/**
 * 全量扫描通道 models:scan：进度推送、可取消、装饰与索引联动、
 * 差量下发与失败回滚（完整 handler 体，自 scan.js 原样迁移）。
 */

import { BrowserWindow } from 'electron'
import logger from '../../../logger'
import {
  getCurrentRoot,
  getSettings,
  isRegisteredLibrary,
  relinkScannedMeta,
  updateSettings,
} from '../../../services/store'
import { scanModels } from '../../../services/scanner'
import { pruneOrphanCovers } from '../../../services/covers'
import { clearDeferredJobs } from '../../../services/thumbs'
import { setWatcherScanning, syncWatcher } from '../../../services/watcher'
import {
  clearHashFailuresForLibrarySwitch,
  pauseHashWarmup,
  requestHashWarmup,
  resumeHashWarmup,
} from '../../../services/hash-warmup'
import {
  clearDeferredOwners,
  decorateModels,
  primeHeaderInfoCache,
  startThumbDrain,
} from '../decorate'
import { ensureRootStore } from '../store'
import {
  getDecorateCacheRoot,
  awaitThumbDrain,
  resetDecorateCache,
} from '../../../services/decorate/state'
import {
  withMaintenanceLock,
  wrapHandler,
  checkExistingDirectory,
} from '../../handler'
import { samePathIgnoreCase } from '../../../utils'
import {
  readLibraryIndex,
  writeLibraryIndex,
} from '../../../services/library-index'
import { slimModelsForList, logPayloadSize } from '../list-payload'
import { beginListSnapshot, computeScanDelta } from '../list-delta'
import { errorMessage } from '../../../../shared/error-text'
import { resolveScanExtensions, scanState } from './shared'

/** 进度事件节流间隔（ms），避免大量小文件时 IPC 过载 */
const PROGRESS_INTERVAL = 120

/**
 * models:scan 响应 errors 载荷条目上限（#62）：与日志截断同口径。
 * 整树权限异常/离线盘场景下 errors 可达万级，裁剪只发生在 IPC 边界
 * （errors 原始数组仍供日志统计真实总数），真实总数经 errorCount 下发。
 */
const MAX_SCAN_ERROR_ENTRIES = 20

/** 注册全量扫描通道的 IPC 处理器 */
export function registerFullScanHandler() {
  // 扫描模型目录（耗时操作，进度通过 models:scanProgress 事件推送，
  // 可经 models:cancelScan 取消）
  wrapHandler(
    'models:scan',
    async (event, { folder, snapshot } = {}) => {
      // 复用内存中的设置（B3）：应用启动时已 loadSettings，热路径无需重读磁盘，
      // 也避免 loadSettings 的损坏重置副作用在扫描路径被意外触发
      const root =
        typeof folder === 'string' && folder
          ? folder
          : getSettings().modelsFolder
      if (!root) {
        return { error: '尚未设置模型文件夹' }
      }
      // 同步获取全局维护锁（V-02）：任何 await 之前完成，防止并发扫描/切库/
      // 备份恢复在事件循环间隙双重进入
      return withMaintenanceLock('scan', root, async (token) => {
        scanState.controller = new AbortController()
        const signal = scanState.controller.signal
        const startedAt = Date.now()
        const previousRoot = getCurrentRoot()
        let completed = false

        try {
          // OPT-02：扫描期间暂停目录监控巡检与广播，变更先累积；扫描成功后
          // 用本次目录快照覆盖基线，停扫时只补发未被扫描覆盖的子树
          setWatcherScanning(true)
          // 扫描期间暂停后台哈希预热取队（正在计算的单个文件不中断），结束后恢复
          pauseHashWarmup()
          // 扫描目录必须是已存在的目录（C6）：防止任意字符串路径（如已删除目录、
          // 或误传文件/系统根）在 ensureRootStore 中创建 .modelvault 写入元数据
          const dirInvalid = await checkExistingDirectory(
            root,
            '模型文件夹不存在或不是目录',
          )
          if (dirInvalid) {
            // F1-offline：附失效标志，渲染层进入离线态（离线页/横幅承担提示），
            // 不再弹笼统的扫描失败 toast
            return { error: dirInvalid, folderMissing: true }
          }
          // 白名单校验（B1）：扫描目录必须已在模型库列表中。存在性校验只保证
          // 「路径可用」，不保证「用户想把这里当库」——无白名单时任意可写目录
          // 都能经 ensureRootStore 落 .modelvault，构成渲染可控的任意目录写入
          // 原语。新增库只能走 models:chooseFolder（用户对话框确认）
          if (!isRegisteredLibrary(root)) {
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
          await pruneOrphanCovers()
          // 切换根目录后装饰缓存全部失效；延迟缩略图队列同步清空——
          // 残留的旧根条目会被下一轮 drain 以「新根」的 thumbs 目录生成（跨根写文件），
          // 并把无效的封面更新推送回渲染进程（C5，与 B10 同类竞态）
          const cacheRootChanged = !samePathIgnoreCase(
            getDecorateCacheRoot(),
            root,
          )
          if (cacheRootChanged) {
            resetDecorateCache(root)
            clearDeferredOwners()
            clearDeferredJobs()
            // 切根即作废旧库的哈希失败负缓存（路径复用且 mtime 一致时，
            // 旧记录会抑制新库文件的预热资格）
            clearHashFailuresForLibrarySwitch()
          }
          // IDX-REUSE：通过「选择文件夹/重新定位」首次进入某库时，若目标库
          // 已有本地索引，先播种上次扫描的头部解析结果，避免首扫对全库重复读盘
          if (cacheRootChanged) {
            const index = await readLibraryIndex(root)
            if (index) primeHeaderInfoCache(index.models)
          }

          let lastSent = 0
          // 应用扫描规则：排除目录 + 扫描文件扩展名（来自应用设置）
          const appSettings = getSettings()
          const { models, errors, dirCount, dirSnapshot, dirRawNames } =
            await scanModels(
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
                // 与局部扫描同一兜底口径（FIX-5）：异常时回退 undefined → scanner
                // 默认全集；此前 `|| []` 在异常场景会产出空集（扫不到任何文件）
                extensions: resolveScanExtensions(appSettings),
                signal,
              },
            )

          // 重关联被移动/重命名模型的标注（A-02）：必须在装饰前执行——
          // decorateOne 按扫描出的新路径键读取元数据，先迁移才能让标注/封面/
          // 哈希履历在本次结果中即时生效
          const relinkResult = relinkScannedMeta(models)

          // OPT-04：全量扫描按库规模自适应装饰缓存容量并清理陈旧条目；
          // O-3：把本次扫描已 readdir 的目录清单（dirSnapshot/dirRawNames）
          // 传给装饰层，sidecar 候选探测按目录剪枝，避免对每个模型盲 stat
          // 全部 9 个候选，也避免装饰层对同一目录再补一次 readdir；
          // O-3b：dirRawNames 为含被可见性过滤条目目录的全量清单，剪枝
          // 优先使用（符号链接 sidecar 保留检出）
          const decorated = await decorateModels(models, signal, {
            adaptCacheSize: true,
            dirSnapshot,
            dirRawNames,
          })
          // 原始扫描数组的元素壳随装饰完成立即释放（O8）：装饰结果为字段浅拷贝的
          // 新对象，原始元素不再被引用；大库扫描期间原始数组、装饰数组与 IPC
          // 结构化克隆三份并存，此步可砍掉约 1/3 的瞬时内存峰值
          models.length = 0
          /** @type {Record<string, number>} */
          const byType = {}
          for (const m of decorated) {
            byType[m.type] = (byType[m.type] || 0) + 1
          }

          logger.info(
            `扫描完成：${decorated.length} 个模型 / ${dirCount} 个目录 / 耗时 ${Date.now() - startedAt}ms / ${errors.length} 个错误`,
          )
          if (errors.length > 0) {
            logger.warn(
              `扫描错误详情: ${JSON.stringify(errors.slice(0, MAX_SCAN_ERROR_ENTRIES))}`,
            )
          }

          // F1：全量扫描完成后写入本地索引（秒切库/启动缓存）。
          // P1-3/OPT-03：索引写移出扫描响应关键路径——大库序列化已交给
          // JSON worker，内容未变化时按指纹跳过写盘；索引只是展示缓存
          // （写失败仅记日志、缺失时秒开回退全量扫描），排队进串行链后立即
          // 继续构建响应；退出路径经 flushIndexWrites 收尾，进程崩溃丢失的
          // 极端场景等价于索引不存在，已有兜底
          void writeLibraryIndex(root, {
            models: decorated,
            durationMs: Date.now() - startedAt,
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
            concurrency: appSettings.hashWarmupConcurrency,
            full: true,
          })

          // 扫描成功后与 settings.modelsFolder 保持一致（C6）：
          // 显式传入 folder 的扫描也持久化根目录，与 models:chooseFolder 行为闭环
          await updateSettings({ modelsFolder: root })
          // 同步目录监控状态（E8）：autoRescan 开启时监听当前根目录，变更触发自动重扫。
          // 排除名单须现读内存设置而非扫描前快照：扫描期间用户经 settings:update
          // 更新过 excludeDirs 时，旧快照会把 watcher 名单回退为扫描前的值
          /** @type {{nativeWatch: boolean, baseline?: Map<string, string[]>}} */
          const watcherTiming = { nativeWatch: true }
          // OPT-02：扫描已产出目录名快照，直接交给 watcher 作为基线，跳过
          // 扫描结束后的重复全树遍历；旧版本/mock 缺该字段时保持原有行为
          if (dirSnapshot instanceof Map && dirSnapshot.size > 0) {
            watcherTiming.baseline = dirSnapshot
          }
          syncWatcher(
            root,
            getSettings().autoRescan === true,
            getSettings().excludeDirs || [],
            watcherTiming,
          )

          completed = true
          // SCAN-DELTA：渲染层快照代际与注册表一致时仅回差量（万级库的
          // 重复重扫从 10MB+ 级结构化克隆降为 KB 级）；失配（窗口重载/
          // 离线清空/无快照）返回 null，走全量下发并播种新代际。
          // 差量命中时跳过全量瘦身（未变化条目不需要 slim 拷贝）
          const delta = computeScanDelta(root, snapshot, decorated)
          if (delta) {
            logPayloadSize('models:scan:delta', delta.approxBytes)
            return {
              root,
              delta: { upsert: delta.upsert, remove: delta.remove },
              // 差量应用后的库总规模（渲染层 toast/lastScan 用）
              total: delta.total,
              unchanged: delta.unchanged,
              snap: { root, gen: delta.gen },
              byType,
              // #62：errors 载荷按上限裁剪，真实总数随 errorCount 下发
              errors: errors.slice(0, MAX_SCAN_ERROR_ENTRIES),
              errorCount: errors.length,
              durationMs: Date.now() - startedAt,
              // 本次扫描自动重新关联的移动/重命名模型数（A-02，渲染层据此提示）
              relinked: relinkResult.relinked,
              // 库设置随模型库走：显式传入 folder 的扫描即切库（chooseFolder/switchRoot
              // 均经此路径），响应携带目标库合并后的设置供渲染层应用（主题/视图随库切换）
              settings: getSettings(),
            }
          }
          // OPT-PAYLOAD：列表通道下发瘦身模型（索引/预热/装饰缓存仍持有
          // 完整装饰对象——瘦身只发生在 IPC 边界，decorated 数组不改动）
          const slimmed = slimModelsForList(decorated)
          const snap = beginListSnapshot(root, decorated)
          logPayloadSize('models:scan', slimmed.approxBytes)
          return {
            root,
            models: slimmed.models,
            snap: { root, gen: snap.gen },
            byType,
            // #62：errors 载荷按上限裁剪，真实总数随 errorCount 下发
            errors: errors.slice(0, MAX_SCAN_ERROR_ENTRIES),
            errorCount: errors.length,
            durationMs: Date.now() - startedAt,
            // 本次扫描自动重新关联的移动/重命名模型数（A-02，渲染层据此提示）
            relinked: relinkResult.relinked,
            // 库设置随模型库走：显式传入 folder 的扫描即切库（chooseFolder/switchRoot
            // 均经此路径），响应携带目标库合并后的设置供渲染层应用（主题/视图随库切换）
            settings: getSettings(),
          }
        } finally {
          // 扫描失败/取消且已经切到新根：回滚到原根，避免主进程根目录与
          // 渲染层保留的旧列表不一致（V-02 切库状态机）。切换事实按主进程
          // 实际当前根判定而非调用点返回后的赋值：ensureRootStore 内部
          // switchDataRoot 已提交、后续 loadData/reloadLibrarySettings 抛错时
          // 调用点以异常退出，后置开关恒为 false 会漏掉该回滚窗口（#61）
          const rootSwitched =
            Boolean(previousRoot) &&
            !samePathIgnoreCase(previousRoot, getCurrentRoot() || '')
          if (!completed && rootSwitched && previousRoot) {
            try {
              await ensureRootStore(previousRoot, { maintenanceToken: token })
              logger.warn(
                `扫描未完成，已回滚模型库根目录: ${root} → ${previousRoot}`,
              )
            } catch (err) {
              logger.error(
                `扫描失败后回滚模型库根目录失败: ${errorMessage(err)}`,
              )
            }
          }
          scanState.controller = null
          resumeHashWarmup()
          // 停扫：补发扫描未覆盖的变更子树（已覆盖项由基线回填时清理）
          setWatcherScanning(false)
        }
      })
    },
    { errorPrefix: '扫描失败', perfWarnMs: 200 },
  )
}
