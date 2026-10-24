import { BrowserWindow, dialog } from 'electron'
import logger from '../../logger'
import {
  getModelIdsByAbsPath,
  getModelMeta,
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
import { readLibraryIndex } from '../../services/library-index'
import { collectLibraryOverview } from '../../services/library-overview'

/**
 * 存储与设置链路：持久化数据加载、模型根目录选择、应用设置更新。
 * ensureRootStore 是全域切换关联存储的唯一入口（扫描与 loadStore 共用）。
 * 目录存在性校验收敛于 ipc/handler.js 的 checkExistingDirectory（O2）：
 * settings:update 只允许激活/移除/重排已登记库列表中的根目录，未登记路径
 * 一律拒绝（新增只能经 models:chooseFolder 对话框）——否则任意已存在目录
 * 都可被提升为库根，后续元数据写入即在该目录创建 .modelvault/
 * （任意目录写入原语）。
 */

/**
 * 目录是否属于模型库列表（与 scan.js 同规则：Windows 大小写不敏感）。
 * @param {string} dir 目标目录
 * @returns {boolean}
 */
function isKnownLibrary(dir) {
  const list = getSettings().modelsFolders || []
  const lower = String(dir).toLowerCase()
  return list.some((f) => typeof f === 'string' && f.toLowerCase() === lower)
}

/**
 * 库列表全量根目录的存在性快照（F1-offline 库路径失效处理）：
 * 渲染层侧栏据 exists=false 的条目对失效库给出灰显标记；响应同时携带
 * 激活库的 folderMissing 标志，供渲染层进入离线态（重新定位/重试闭环）。
 * 并行 stat（库列表上限 20 条）：未挂载盘符的单次 stat 可能阻塞数秒，
 * 并行后总耗时取决于最慢一条而非串行累加。
 * @param {unknown} folders 设置中的模型库列表
 * @returns {Promise<Array<{folder: string, exists: boolean}>>}
 */
async function collectRootStatuses(folders) {
  const list = Array.isArray(folders)
    ? folders.filter((f) => typeof f === 'string' && f)
    : []
  return Promise.all(
    list.map(async (folder) => ({
      folder,
      // checkExistingDirectory 返回空串表示存在（O2 助手语义）
      exists: (await checkExistingDirectory(folder)) === ''
    }))
  )
}

/**
 * F1：用当前内存元数据覆盖索引中的用户标注字段。
 * 索引是上一次全量扫描的快照；收藏/评分/备注等可能在扫描后修改。
 * 覆盖标量标注保证秒开列表即刻准确；封面/缩略图仍由后台校验刷新。
 * @param {any[]} models 索引中的装饰模型
 * @returns {any[]} 合并后的模型列表
 */
function overlayCurrentMeta(models) {
  if (!Array.isArray(models)) return models
  return models.map((m) => {
    const meta = getModelMeta(m.id)
    if (!meta) return m
    return {
      ...m,
      alias: meta.alias || '',
      note: meta.note || '',
      noteSource: meta.noteSource || '',
      favorite: meta.favorite === true,
      nsfw: meta.nsfw === true,
      rating: meta.rating || 0,
      params: meta.params || null,
      tags: meta.tags || [],
      triggerWords: meta.triggerWords || '',
      triggerWordsSource: meta.triggerWordsSource || '',
      subCategory:
        (m.type === 'lora' && m.folderSubCategory) ||
        meta.subCategory ||
        (m.type === 'checkpoint' ? 'base' : ''),
      hash: meta.hash || m.hash || ''
    }
  })
}

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
 * @param {{maintenanceToken?: {id: number}|null}} [options] 已持有的维护锁令牌
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
  // 加载持久化数据（设置 + 本地索引缓存；元数据仅在主进程内部消费）
  wrapHandler('models:loadStore', async () => {
    // V-02：加载/切库与扫描、备份恢复互斥。维护操作进行中时返回当前内存快照，
    // 避免窗口重载/并发调用把根目录切到正在扫描的库之外
    const token = tryAcquireMaintenance('load', null)
    if (!token) {
      logger.warn(`维护操作进行中，loadStore 返回当前内存快照: ${maintenanceBusyMessage()}`)
      return { settings: getSettings(), cachedIndex: null }
    }
    try {
      const settings = await loadSettings()
      let cachedIndex = null
      // F1-offline：激活库路径失效标志（目录被移动/重命名/盘符未挂载）——
      // 渲染层据此进入明确的离线态，而非笼统的扫描失败 toast
      let folderMissing = false
      if (settings.modelsFolder) {
        // 已设置目录不存在（如磁盘离线/被移动）时不切换关联存储，
        // 防止后续元数据写入在不存在的路径下重建目录树。
        // checkExistingDirectory 返回空串表示存在（O2 助手语义）
        const dirMissing = await checkExistingDirectory(settings.modelsFolder)
        if (dirMissing) {
          folderMissing = true
          logger.warn(`已设置的模型目录不存在，跳过关联存储加载: ${settings.modelsFolder}`)
        } else {
          await ensureRootStore(settings.modelsFolder, { maintenanceToken: token })
          // 清理不再被元数据引用的孤儿封面文件
          await pruneOrphanCovers()
          // F1：返回上次全量扫描的本地索引，渲染层可先秒开列表再后台校验
          cachedIndex = await readLibraryIndex(settings.modelsFolder)
          if (cachedIndex) {
            cachedIndex = {
              ...cachedIndex,
              models: overlayCurrentMeta(cachedIndex.models)
            }
          }
          // 启动后后台预热缺失的模型哈希（Civitai 识别加速）：仅入队，
          // 由预热服务延迟逐个处理，已缓存/文件缺失的条目消费时秒级跳过。
          // P1-2：播种改用索引模型自带的 size/mtime——此前只有元数据键的
          // 裸 id，candidates 策略下全部入队由 drain 逐个串行 stat，缓存哈希
          // 的大库（网络盘尤甚）启动后是分钟级纯 stat 开销；现在体积唯一者
          // 直接不入队（零 IO）。full=true 重置体积索引；索引模型即上次扫描
          // 的装饰结果（readLibraryIndex 宽返回类型在此断言），无索引时回退
          // 裸 id 列表（不构造随响应回传的完整元数据映射，启动 IPC 瘦身）
          const warmupSeed = cachedIndex
            ? /** @type {any[]} */ (cachedIndex.models)
            : getModelIdsByAbsPath()
          requestHashWarmup(warmupSeed, {
            mode: settings.hashWarmup,
            full: true
          })
          // 目录监控启动路径闭合（OPT-19）：启动时若 autoScan 关闭则不会触发扫描，
          // 此前 watcher 仅在扫描/设置更新时同步，导致 autoRescan 开启却静默不生效；
          // 此处按设置补一次同步（同根同状态时为幂等刷新）
          syncWatcher(
            settings.modelsFolder,
            settings.autoRescan === true,
            settings.excludeDirs || [],
            { nativeWatch: true }
          )
        }
      }
      // F1-offline：库列表全量根目录存在性快照随响应回传（含正常分支）——
      // 激活库正常时，其他已保存库同样可能因盘符未挂载而失效，侧栏需要标记
      const rootStatuses = await collectRootStatuses(settings.modelsFolders)
      return {
        settings,
        cachedIndex,
        folderMissing,
        rootStatuses
      }
    } finally {
      releaseMaintenance(token)
    }
  }, { errorPrefix: '数据加载失败' })

  // F1：打开已保存的模型库并优先返回本地索引（秒切库）。
  // 索引缺失/失效时 cached=false，由渲染层回退全量扫描。
  wrapHandler('models:openLibrary', async (event, { folder } = {}) => {
    const root = typeof folder === 'string' ? folder.trim() : ''
    if (!root) return { error: '缺少模型文件夹' }
    if (!isKnownLibrary(root)) {
      logger.warn(`拒绝打开模型库列表之外的目录: ${root}`)
      return { error: '该目录不在模型库列表中' }
    }
    const dirInvalid = await checkExistingDirectory(root, '模型文件夹不存在或不是目录')
    // F1-offline：附失效标志——渲染层据此提交目标库身份并进入离线态
    // （重新定位/重试闭环），而非笼统的错误 toast
    if (dirInvalid) return { error: dirInvalid, folderMissing: true }

    // 先探测索引：无可用索引时不切换主进程根目录，交由渲染层走
    // scanModels 的 V-02 状态机（扫描失败可回滚旧库）
    const cachedIndex = await readLibraryIndex(root)
    if (!cachedIndex) {
      logger.info(`模型库无可用本地索引，回退全量扫描: ${root}`)
      return { root, cached: false }
    }

    const token = tryAcquireMaintenance('switch', root)
    if (!token) return { error: maintenanceBusyMessage() }
    try {
      await ensureRootStore(root, { maintenanceToken: token })
      // 切库成功后才提交激活库（与扫描链路同一 V-02 状态机）
      await updateSettings({ modelsFolder: root })
      const settings = getSettings()
      syncWatcher(root, settings.autoRescan === true, settings.excludeDirs || [], {
        nativeWatch: true
      })
      // 切库即作废旧库的后台哈希预热队列：秒切库不经过扫描链路的 full 快照
      // 重播种，旧库排队任务若继续消费，会对已不在当前根内的文件白算
      // SHA256——跨根写守卫使结果无法落盘，纯浪费分钟级磁盘 IO（后台校验
      // 扫描失败/取消时该队列会一直消费到空）。以索引模型的 size/mtime 按
      // 新库策略整体重播种（full=true 丢弃旧排队项并重置体积索引）；随后的
      // 后台校验扫描完成时再次 full 播种，幂等无冲突。索引模型即上次扫描的
      // 装饰结果（含 id/size/mtimeMs），readLibraryIndex 的宽返回类型在此断言
      const indexModels = /** @type {any[]} */ (cachedIndex.models)
      requestHashWarmup(indexModels, {
        mode: settings.hashWarmup,
        full: true
      })
      logger.info(
        `模型库已打开（本地索引 ${cachedIndex.models.length} 个模型）: ${root}`
      )
      return {
        root,
        settings,
        cached: true,
        models: overlayCurrentMeta(cachedIndex.models),
        savedAt: cachedIndex.savedAt,
        durationMs: cachedIndex.durationMs
      }
    } finally {
      releaseMaintenance(token)
    }
  }, { errorPrefix: '打开模型库失败' })

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
    // 模型库根目录写入收敛（OPT-04）：settings:update 不得新增库根目录。
    // modelsFolder / modelsFolders 中所有未出现在当前列表内的路径一律拒绝——
    // 新增库只能经 models:chooseFolder 的原生对话框（用户确认）写入；主进程
    // 扫描成功链路只更新已登记库的激活根，不新增条目。否则渲染进程可把任意
    // 已存在目录提升为库根，随后经 ensureRootStore 在该目录创建 .modelvault
    //（任意目录写入原语）。已在当前列表/当前激活根中的路径跳过校验：
    // 目录暂时离线时仍可保存设置。
    const current = getSettings()
    const currentKeys = new Set(
      [current.modelsFolder, ...(current.modelsFolders || [])]
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
      // 先做存在性校验，保留原有「目录不存在/不是目录」的明确提示；
      // 已存在的目录仍必须命中当前库列表，否则拒绝新增。
      const dirInvalid = await checkExistingDirectory(
        folder,
        `模型文件夹不存在或不是目录: ${folder}`
      )
      if (dirInvalid) {
        logger.warn(`拒绝设置不存在的模型目录: ${folder}`)
        return { error: dirInvalid }
      }
      logger.warn(`拒绝经 settings:update 新增模型库根目录: ${folder}`)
      return { error: '该目录不在模型库列表中，新增模型库请通过「更改文件夹」选择' }
    }
    await updateSettings(patch)
    const settings = getSettings()
    // 目录监控随设置联动（E8）：autoRescan 开关或激活根目录变更时重启/停止监听；
    // 排除名单与 scanner 同规则（按目录名小写匹配），被排除目录的变更不触发重扫
    syncWatcher(
      settings.modelsFolder,
      settings.autoRescan === true,
      settings.excludeDirs || [],
      { nativeWatch: true }
    )
    logger.info(`应用设置已更新: ${JSON.stringify(patch).slice(0, 200)}`)
    return { settings }
  }, { errorPrefix: '设置保存失败' })

  // 跨库存储总览（FN-01）：只读汇总各库索引/元数据，输出跨库重复组与
  // 可释放空间。不获取维护锁、不切换当前根——可在扫描/备份期间安全调用
  wrapHandler('models:crossLibraryOverview', () => collectLibraryOverview(), {
    errorPrefix: '跨库存储分析失败'
  })
}
