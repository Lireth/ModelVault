import { BrowserWindow, dialog } from 'electron'
import logger from '../../logger'
import {
  getMetaMapByAbsPath,
  getCurrentRoot,
  getSettings,
  loadSettings,
  loadData,
  switchDataRoot,
  reloadLibrarySettings,
  setStoreSaveErrorListener,
  updateSettings,
  flushSettingsSave
} from '../../services/store'
import { pruneOrphanCovers } from '../../services/covers'
import { syncWatcher } from '../../services/watcher'
import { requestHashWarmup } from '../../services/hash-warmup'
import {
  maintenanceBusyMessage,
  releaseMaintenance,
  tryAcquireMaintenance
} from '../../services/maintenance-lock'
import { awaitThumbDrain } from './model-state'
import { wrapHandler, checkExistingDirectory } from '../handler'

/**
 * 存储与设置链路：持久化数据加载、模型根目录选择、应用设置更新。
 * ensureRootStore 是全域切换关联存储的唯一入口（扫描与 loadStore 共用）。
 * 目录存在性校验收敛于 ipc/handler.js 的 checkExistingDirectory（O2）：
 * 拦截渲染进程经 settings:update 写入的任意字符串路径——若不做校验，
 * 后续任意一次元数据写入即在该目录创建 .modelvault/（任意目录写入原语）。
 */

/**
 * 确保指定根目录的关联存储已加载。
 * 切换根目录前必须等待上一轮后台缩略图生成完成（B10）：
 * drain 过程中 getThumbsDir() 依赖 currentRoot，中途切换会把缩略图
 * 写进切换后的目录，且文件不被新根目录 keepNames 命中而被 pruneThumbs 清理。
 * 切库还必须先静止旧根写盘链（A6）：迟到防抖会把旧根数据写进新目录，
 * 见 switchDataRoot。
 *
 * 互斥（V-02）：调用方若已持有全局维护锁（扫描/恢复），必须传入
 * maintenanceToken，避免同一操作内二次加锁；未持有则本函数自行加锁。
 * @param {string} root 目标模型根目录
 * @param {{maintenanceToken?: object|null}} [options] 已持有的维护锁令牌
 */
export async function ensureRootStore(root, { maintenanceToken = null } = {}) {
  if (getCurrentRoot() === root) return

  let token = maintenanceToken
  let owned = false
  if (!token) {
    token = tryAcquireMaintenance('switch', root)
    if (!token) {
      // 调用方（如 loadStore）应把忙状态转换为可读错误；此处抛出由 wrapHandler 兜底
      throw new Error(maintenanceBusyMessage())
    }
    owned = true
  }
  try {
    // 切换根目录前必须等待上一轮后台缩略图生成完成（B10，等待入口收敛于 model-state）
    await awaitThumbDrain()
    // 旧根的库设置也先落盘（B-02）：随后 reloadLibrarySettings 会切换内存视图，
    // 排队中的旧库快照必须在此之前写完（其 target root 已在调度时固定）
    await flushSettingsSave()
    // 旧根待落盘数据先写入旧目录，再切换根目录（A6）
    await switchDataRoot(root)
    await loadData()
    // 库设置随根目录切换（设置随模型库走）：加载目标库的 .modelvault/settings.json，
    // 文件不存在时以默认值初始化并落盘；主题/视图等随目标库生效
    await reloadLibrarySettings(root)
  } finally {
    if (owned) releaseMaintenance(token)
  }
}

/**
 * 注册元数据落盘失败的跨窗口广播（B1）。
 * 防抖落盘在 IPC 响应之后异步发生，渲染进程已收到成功返回，
 * 必须经事件通知，否则用户标注会静默丢失。
 * 副作用注册：仅可由 registerModelIpcHandlers 调用时触发，严禁漂移到模块 import 时。
 */
export function setupStoreErrorForwarding() {
  setStoreSaveErrorListener((err) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('models:storeError', { message: err.message })
      }
    }
  })
}

/** 注册存储与设置链路的 IPC 处理器 */
export function registerStoreHandlers() {
  // 加载持久化数据（设置 + 当前模型根目录的元数据，键为绝对路径）
  wrapHandler('models:loadStore', async () => {
    // V-02：加载/切库与扫描、备份恢复互斥。维护操作进行中时返回当前内存快照，
    // 避免窗口重载/并发调用把根目录切到正在扫描的库之外
    const token = tryAcquireMaintenance('load', null)
    if (!token) {
      logger.warn(`维护操作进行中，loadStore 返回当前内存快照: ${maintenanceBusyMessage()}`)
      return { settings: getSettings(), models: getMetaMapByAbsPath() }
    }
    try {
      const settings = await loadSettings()
      let metaMap = {}
      if (settings.modelsFolder) {
        // 已设置目录不存在（如磁盘离线/被移动）时不切换关联存储，
        // 防止后续元数据写入在不存在的路径下重建目录树。
        // checkExistingDirectory 返回空串表示存在（O2 助手语义）
        const dirMissing = await checkExistingDirectory(settings.modelsFolder)
        if (dirMissing) {
          logger.warn(`已设置的模型目录不存在，跳过关联存储加载: ${settings.modelsFolder}`)
        } else {
          await ensureRootStore(settings.modelsFolder, { maintenanceToken: token })
          // 清理不再被元数据引用的孤儿封面文件
          await pruneOrphanCovers()
          metaMap = getMetaMapByAbsPath()
          // 启动后后台预热缺失的模型哈希（Civitai 识别加速）：仅入队，
          // 由预热服务延迟逐个处理，已缓存/文件缺失的条目消费时秒级跳过
          requestHashWarmup(Object.keys(metaMap))
          // 目录监控启动路径闭合（OPT-19）：启动时若 autoScan 关闭则不会触发扫描，
          // 此前 watcher 仅在扫描/设置更新时同步，导致 autoRescan 开启却静默不生效；
          // 此处按设置补一次同步（同根同状态时为幂等刷新）
          syncWatcher(
            settings.modelsFolder,
            settings.autoRescan === true,
            settings.excludeDirs || []
          )
        }
      }
      return {
        settings,
        models: metaMap
      }
    } finally {
      releaseMaintenance(token)
    }
  }, { errorPrefix: '数据加载失败' })

  // 选择模型根目录
  wrapHandler('models:chooseFolder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win, {
      title: '选择模型文件夹',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const folder = result.filePaths[0]
    // V-02 切库状态机：选择阶段只把目录加入库列表（供随后的 models:scan
    // 通过白名单校验），不提前写 modelsFolder——只有扫描成功才由 scan 链路
    // 提交为激活库；扫描失败/取消时保持原激活库不变
    const folders = getSettings().modelsFolders || []
    const known = folders.some(
      (f) => typeof f === 'string' && f.toLowerCase() === folder.toLowerCase()
    )
    if (!known) {
      await updateSettings({ modelsFolders: [...folders, folder] })
    }
    logger.info(`已选择模型目录（待扫描成功后激活）: ${folder}`)
    return folder
  }, { errorPrefix: '选择文件夹失败' })

  // 更新应用设置（通用/扫描/外观），返回规范化后的完整设置
  wrapHandler('settings:update', async (event, patch = {}) => {
    // modelsFolder / modelsFolders（E7 多根目录）的变更项必须是真实存在的目录：
    // 防止渲染进程写入任意路径后，经元数据写入在该目录创建 .modelvault
    // （任意目录写入原语）。与当前值相同的路径不重复校验：
    // 模型目录所在磁盘暂时离线时仍可保存其他设置
    const currentKeys = new Set(
      [getSettings().modelsFolder, ...(getSettings().modelsFolders || [])]
        .filter((f) => typeof f === 'string' && f)
        .map((f) => f.toLowerCase())
    )
    const candidates = []
    if (typeof patch?.modelsFolder === 'string' && patch.modelsFolder.trim()) {
      candidates.push(patch.modelsFolder.trim())
    }
    if (Array.isArray(patch?.modelsFolders)) {
      for (const f of patch.modelsFolders) {
        if (typeof f === 'string' && f.trim()) candidates.push(f.trim())
      }
    }
    for (const folder of candidates) {
      if (currentKeys.has(folder.toLowerCase())) continue
      const dirInvalid = await checkExistingDirectory(
        folder,
        `模型文件夹不存在或不是目录: ${folder}`
      )
      if (dirInvalid) {
        logger.warn(`拒绝设置不存在的模型目录: ${folder}`)
        return { error: dirInvalid }
      }
    }
    await updateSettings(patch)
    const settings = getSettings()
    // 目录监控随设置联动（E8）：autoRescan 开关或激活根目录变更时重启/停止监听；
    // 排除名单与 scanner 同规则（按目录名小写匹配），被排除目录的变更不触发重扫
    syncWatcher(
      settings.modelsFolder,
      settings.autoRescan === true,
      settings.excludeDirs || []
    )
    logger.info(`应用设置已更新: ${JSON.stringify(patch).slice(0, 200)}`)
    return { settings }
  }, { errorPrefix: '设置保存失败' })
}
