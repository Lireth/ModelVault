import { BrowserWindow } from 'electron'
import logger from '../../logger'
import { getCurrentRoot, getSettings, relinkScannedMeta, updateSettings } from '../../services/store'
import { scanModels } from '../../services/scanner'
import { pruneOrphanCovers } from '../../services/covers'
import { clearDeferredJobs } from '../../services/thumbs'
import { syncWatcher } from '../../services/watcher'
import { pauseHashWarmup, requestHashWarmup, resumeHashWarmup } from '../../services/hash-warmup'
import {
  getMaintenanceState,
  maintenanceBusyMessage,
  releaseMaintenance,
  tryAcquireMaintenance
} from '../../services/maintenance-lock'
import { clearDeferredOwners, decorateModels, startThumbDrain } from './decorate'
import { ensureRootStore } from './store'
import { getDecorateCacheRoot, awaitThumbDrain, resetDecorateCache } from './model-state'
import { wrapHandler, checkExistingDirectory } from '../handler'
import { normalizePartialScanDirs } from '../../../shared/scan-dirs'
import { writeLibraryIndex } from '../../services/library-index'

/**
 * 扫描链路：全量扫描模型目录（进度推送、可取消）、局部增量扫描与取消入口。
 * 并发互斥由 services/maintenance-lock 统一提供（与切库、备份恢复共用一把锁）；
 * scanAbort 仅用于取消当前扫描。
 */

/** 进度事件节流间隔（ms），避免大量小文件时 IPC 过载 */
const PROGRESS_INTERVAL = 120

/** 当前扫描的取消控制器（null 表示无进行中的扫描） */
let scanAbort = null

/** 判断两个模型根目录是否相同（Windows 大小写不敏感） */
function isSameRoot(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase()
}

/**
 * 目录是否属于模型库白名单（B1）：settings.modelsFolders（上限 20）。
 * 列表条目只能经 models:chooseFolder（用户对话框确认）写入；主进程扫描成功
 * 链路只更新已登记库的激活根，不新增条目；settings:update 仅允许激活/移除/
 * 重排已登记库，不能再新增根目录。该列表是「.modelvault 写入点可以指向
 * 哪里」的唯一可信来源；渲染进程直接传入的任意路径不得成为关联存储根。
 * Windows 大小写不敏感比较。
 */
function isKnownLibrary(dir) {
  const list = getSettings().modelsFolders || []
  const lower = dir.toLowerCase()
  return list.some((f) => typeof f === 'string' && f.toLowerCase() === lower)
}

/** 注册扫描链路的 IPC 处理器 */
export function registerScanHandlers() {
  // 扫描模型目录（耗时操作，进度通过 models:scanProgress 事件推送，
  // 可经 models:cancelScan 取消）
  wrapHandler('models:scan', async (event, { folder } = {}) => {
    // 复用内存中的设置（B3）：应用启动时已 loadSettings，热路径无需重读磁盘，
    // 也避免 loadSettings 的损坏重置副作用在扫描路径被意外触发
    const root = typeof folder === 'string' && folder ? folder : getSettings().modelsFolder
    if (!root) {
      return { error: '尚未设置模型文件夹' }
    }
    // 同步获取全局维护锁（V-02）：任何 await 之前完成，防止并发扫描/切库/
    // 备份恢复在事件循环间隙双重进入
    const token = tryAcquireMaintenance('scan', root)
    if (!token) {
      return { error: maintenanceBusyMessage() }
    }
    scanAbort = new AbortController()
    const signal = scanAbort.signal
    const startedAt = Date.now()
    const previousRoot = getCurrentRoot()
    let rootSwitched = false
    let completed = false

    try {
      // 扫描期间暂停后台哈希预热取队（正在计算的单个文件不中断），结束后恢复
      pauseHashWarmup()
      // 扫描目录必须是已存在的目录（C6）：防止任意字符串路径（如已删除目录、
      // 或误传文件/系统根）在 ensureRootStore 中创建 .modelvault 写入元数据
      const dirInvalid = await checkExistingDirectory(root, '模型文件夹不存在或不是目录')
      if (dirInvalid) {
        return { error: dirInvalid }
      }
      // 白名单校验（B1）：扫描目录必须已在模型库列表中。存在性校验只保证
      // 「路径可用」，不保证「用户想把这里当库」——无白名单时任意可写目录
      // 都能经 ensureRootStore 落 .modelvault，构成渲染可控的任意目录写入
      // 原语。新增库只能走 models:chooseFolder（用户对话框确认）
      if (!isKnownLibrary(root)) {
        logger.warn(`拒绝扫描模型库列表之外的目录: ${root}`)
        return { error: '该目录不在模型库列表中' }
      }

      const win = BrowserWindow.fromWebContents(event.sender)
      logger.info(`开始扫描模型目录: ${root}`)

      // 等待上一轮后台缩略图生成完成，避免与新扫描的缩略图清理逻辑竞争（C4 单一入口）
      await awaitThumbDrain()
      // 切换/加载该根目录的关联存储，并清理孤儿封面文件。
      // 维护锁由本扫描持有，传入令牌避免 ensureRootStore 再次加锁
      await ensureRootStore(root, { maintenanceToken: token })
      rootSwitched = Boolean(previousRoot) && !isSameRoot(previousRoot, root)
      await pruneOrphanCovers()
      // 切换根目录后装饰缓存全部失效；延迟缩略图队列同步清空——
      // 残留的旧根条目会被下一轮 drain 以「新根」的 thumbs 目录生成（跨根写文件），
      // 并把无效的封面更新推送回渲染进程（C5，与 B10 同类竞态）
      if (getDecorateCacheRoot() !== root) {
        resetDecorateCache(root)
        clearDeferredOwners()
        clearDeferredJobs()
      }

      let lastSent = 0
      // 应用扫描规则：排除目录 + 扫描文件扩展名（来自应用设置）
      const appSettings = getSettings()
      const { models, errors, dirCount } = await scanModels(
        root,
        (progress) => {
          const now = Date.now()
          if (now - lastSent >= PROGRESS_INTERVAL) {
            lastSent = now
            // 窗口可能已在扫描期间关闭：?. 只防 null 不防已销毁（访问 webContents 抛错），须判 isDestroyed
            if (win && !win.isDestroyed()) {
              win.webContents.send('models:scanProgress', progress)
            }
          }
        },
        {
          excludeDirs: appSettings.excludeDirs || [],
          extensions: appSettings.scanExtensions || [],
          signal
        }
      )

      // 重关联被移动/重命名模型的标注（A-02）：必须在装饰前执行——
      // decorateOne 按扫描出的新路径键读取元数据，先迁移才能让标注/封面/
      // 哈希履历在本次结果中即时生效
      const relinkResult = relinkScannedMeta(models)

      const decorated = await decorateModels(models, signal)
      // 原始扫描数组的元素壳随装饰完成立即释放（O8）：装饰结果为字段浅拷贝的
      // 新对象，原始元素不再被引用；大库扫描期间原始数组、装饰数组与 IPC
      // 结构化克隆三份并存，此步可砍掉约 1/3 的瞬时内存峰值
      models.length = 0
      const byType = {}
      for (const m of decorated) {
        byType[m.type] = (byType[m.type] || 0) + 1
      }

      logger.info(
        `扫描完成：${decorated.length} 个模型 / ${dirCount} 个目录 / 耗时 ${Date.now() - startedAt}ms / ${errors.length} 个错误`
      )
      if (errors.length > 0) {
        logger.warn(`扫描错误详情: ${JSON.stringify(errors.slice(0, 20))}`)
      }

      // F1：全量扫描完成后写入本地索引（秒切库/启动缓存）。
      // 索引只作展示缓存，写失败不影响本次扫描结果
      await writeLibraryIndex(root, {
        models: decorated,
        durationMs: Date.now() - startedAt
      })

      // 响应先返回，缺失的缩略图由后台队列补齐（完成后推送 thumbsReady 更新）
      startThumbDrain(win)

      // 后台预热缺失的模型哈希（Civitai 识别加速）：缓存缺失的条目按
      // mtime 逐个计算回写，已缓存/文件缺失的条目消费时秒级跳过；
      // 扫描刚结束磁盘繁忙，预热服务延迟启动。
      // O1：传入装饰结果的 size/mtime 并标记为完整库快照——候选策略据此
      // 只对同尺寸模型计算，full=true 同步重置体积索引（清除已删除模型）
      requestHashWarmup(decorated, {
        mode: appSettings.hashWarmup,
        full: true
      })

      // 扫描成功后与 settings.modelsFolder 保持一致（C6）：
      // 显式传入 folder 的扫描也持久化根目录，与 models:chooseFolder 行为闭环
      await updateSettings({ modelsFolder: root })
      // 同步目录监控状态（E8）：autoRescan 开启时监听当前根目录，变更触发自动重扫。
      // 排除名单须现读内存设置而非扫描前快照：扫描期间用户经 settings:update
      // 更新过 excludeDirs 时，旧快照会把 watcher 名单回退为扫描前的值
      syncWatcher(root, getSettings().autoRescan === true, getSettings().excludeDirs || [])

      completed = true
      return {
        root,
        models: decorated,
        byType,
        errors,
        durationMs: Date.now() - startedAt,
        // 本次扫描自动重新关联的移动/重命名模型数（A-02，渲染层据此提示）
        relinked: relinkResult.relinked,
        // 库设置随模型库走：显式传入 folder 的扫描即切库（chooseFolder/switchRoot
        // 均经此路径），响应携带目标库合并后的设置供渲染层应用（主题/视图随库切换）
        settings: getSettings()
      }
    } finally {
      // 扫描失败/取消且已经切到新根：回滚到原根，避免主进程根目录与
      // 渲染层保留的旧列表不一致（V-02 切库状态机）
      if (!completed && rootSwitched && previousRoot) {
        try {
          await ensureRootStore(previousRoot, { maintenanceToken: token })
          logger.warn(`扫描未完成，已回滚模型库根目录: ${root} → ${previousRoot}`)
        } catch (err) {
          logger.error(`扫描失败后回滚模型库根目录失败: ${err.message}`)
        }
      }
      scanAbort = null
      releaseMaintenance(token)
      resumeHashWarmup()
    }
  }, { errorPrefix: '扫描失败' })

  // 取消进行中的扫描（经 AbortController 中止，扫描返回 { canceled: true }）
  wrapHandler('models:cancelScan', () => {
    const maintenance = getMaintenanceState()
    const cancelable =
      maintenance && (maintenance.kind === 'scan' || maintenance.kind === 'partial-scan')
    if (cancelable && scanAbort) {
      scanAbort.abort()
      return { ok: true }
    }
    return { ok: false }
  })

  // 局部增量扫描（A-03）：watcher 检出变更子树后，仅重扫这些子树并装饰返回。
  // 与全量扫描、切库、备份恢复共用全局维护锁（V-02）；不做孤儿封面清理
  // （全量扫描兜底）、不回写设置/不重启 watcher；重关联限定在受影响子树内。
  wrapHandler('models:partialScan', async (event, { folder, dirs } = {}) => {
    const root = typeof folder === 'string' && folder ? folder : getSettings().modelsFolder
    if (!root) return { error: '尚未设置模型文件夹' }
    // 同步获取维护锁（B-01/V-02）：任何 await 之前完成，防止并发穿透
    const token = tryAcquireMaintenance('partial-scan', root)
    if (!token) {
      return { error: maintenanceBusyMessage() }
    }
    const abort = new AbortController()
    scanAbort = abort
    const signal = abort.signal
    const startedAt = Date.now()
    try {
      // 与全量扫描一致：扫描期间暂停后台哈希预热取队，结束后恢复
      pauseHashWarmup()
      // 子树清洗在锁内完成：失败路径统一经 finally 释放锁
      const normalized = normalizePartialScanDirs(dirs)
      if (normalized.error) return { error: normalized.error }
      // O3：子树过多且一级目录收敛后仍超限——明确要求渲染层回退全量扫描，
      // 绝不静默丢弃部分子树（丢弃会让这些子树停留在陈旧状态）
      if (normalized.fullScanRequired) {
        logger.warn('局部扫描子树过多，已要求渲染层改为完整扫描')
        return { fullScanRequired: true }
      }
      const subDirs = normalized.subDirs
      if (normalized.collapsed) {
        logger.info(`局部扫描子树过多，已收敛为 ${subDirs.length} 个一级目录`)
      }

      // 与全量扫描一致的目录前置校验（白名单 + 存在性）
      if (!isKnownLibrary(root)) {
        logger.warn(`拒绝局部扫描模型库列表之外的目录: ${root}`)
        return { error: '该目录不在模型库列表中' }
      }
      const dirInvalid = await checkExistingDirectory(root, '模型文件夹不存在或不是目录')
      if (dirInvalid) {
        return { error: dirInvalid }
      }
      // 局部扫描只作用于当前根（V-02）：渲染层请求发出后根已切换时直接拒绝，
      // 绝不能借 ensureRootStore 把主进程根目录切回旧库
      const currentRoot = getCurrentRoot()
      if (currentRoot && !isSameRoot(root, currentRoot)) {
        logger.warn(`拒绝针对非当前根的局部扫描: ${root}（当前 ${currentRoot}）`)
        return { error: '模型库已切换，请稍后重试' }
      }

      await ensureRootStore(root, { maintenanceToken: token })
      const appSettings = getSettings()
      const scanResult = await scanModels(root, null, {
        excludeDirs: appSettings.excludeDirs || [],
        // 与全量扫描一致地应用用户配置的扫描扩展名（B3 修复）：此前传
        // undefined 落回默认全集，用户已排除的扩展名（如 .ckpt）会在
        // watcher 触发一次局部重扫后“复活”，局部结果与全量结果不一致。
        // 空数组防御回退 undefined：scanner 语义中空集 = 扫不到任何文件，
        // 规范化后的 scanExtensions 恒非空，此处仅为契约兜底
        extensions:
          Array.isArray(appSettings.scanExtensions) && appSettings.scanExtensions.length > 0
            ? appSettings.scanExtensions
            : undefined,
        subDirs,
        signal
      })
      const models = scanResult.models
      // 重关联限定受影响子树：范围外元数据保持原样
      const relinkResult = relinkScannedMeta(models, { affectedDirs: subDirs })
      // pruneThumbs=false（OPT-1 修复）：局部装饰仅覆盖变更子树，若按局部
      // usedThumbs 清理会把子树外模型的全部缩略图误删（缓存命中路径不会重新
      // 生成，坏图将持续到元数据变化）。失效缩略图与孤儿封面同一约定：
      // 由下一次全量扫描兜底清理
      const decorated = await decorateModels(models, signal, { pruneThumbs: false })
      models.length = 0 // 同全量扫描：装饰后立即释放原始数组（O8）

      const win = BrowserWindow.fromWebContents(event.sender)
      // 装饰中新登记的缩略图任务经既有后台链生成并推送
      startThumbDrain(win)

      // 受影响子树的哈希预热（同全量扫描，Civitai 识别加速）。
      // O1：局部扫描不是完整快照——按 id 合并体积索引，使新增文件与子树外
      // 同尺寸模型也能被识别为重复候选
      requestHashWarmup(decorated, {
        mode: appSettings.hashWarmup,
        full: false
      })

      logger.info(
        `局部扫描完成：${subDirs.length} 个子树 → ${decorated.length} 个模型 / 重关联 ${relinkResult.relinked} 个`
      )

      return {
        models: decorated,
        dirs: subDirs,
        relinked: relinkResult.relinked,
        durationMs: Date.now() - startedAt
      }
    } finally {
      scanAbort = null
      releaseMaintenance(token)
      resumeHashWarmup()
    }
  }, { errorPrefix: '局部扫描失败' })
}
