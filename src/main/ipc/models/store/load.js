/**
 * models:loadStore —— 持久化数据加载（设置 + 本地索引 + 后台预热/监控联动）。
 */

import logger from '../../../logger'
import { samePathIgnoreCase } from '../../../utils'
import {
  getModelIdsByAbsPath,
  getSettings,
  loadSettings,
} from '../../../services/store'
import { pruneOrphanCovers } from '../../../services/covers'
import { startPerf } from '../../../services/perf'
import { syncWatcher } from '../../../services/watcher'
import { requestHashWarmup } from '../../../services/hash-warmup'
import {
  maintenanceBusyMessage,
  releaseMaintenance,
  tryAcquireMaintenance,
} from '../../../services/maintenance-lock'
import {
  getDecorateCacheRoot,
  resetDecorateCache,
} from '../../../services/decorate/state'
import { clearDeferredOwners, primeHeaderInfoCache } from '../decorate'
import { clearDeferredJobs } from '../../../services/thumbs'
import { slimModelsForList, logPayloadSize } from '../list-payload'
import { wrapHandler, checkExistingDirectory } from '../../handler'
import { readLibraryIndex } from '../../../services/library-index'
import { collectRootStatuses, ensureRootStore } from './session'
import { overlayCurrentMeta } from './list-view'

/** 注册持久化数据加载通道 */
export function registerLoadHandlers() {
  // 加载持久化数据（设置 + 本地索引缓存；元数据仅在主进程内部消费）
  wrapHandler(
    'models:loadStore',
    async () => {
      // V-02：加载/切库与扫描、备份恢复互斥。维护操作进行中时返回当前内存快照，
      // 避免窗口重载/并发调用把根目录切到正在扫描的库之外
      const token = tryAcquireMaintenance('load', null)
      if (!token) {
        logger.warn(
          `维护操作进行中，loadStore 返回当前内存快照: ${maintenanceBusyMessage()}`,
        )
        return { settings: getSettings(), cachedIndex: null }
      }
      try {
        // PERF-2：冷启动/切库关键路径耗时观测（[perf] 日志，优化收益实测依据）
        const perf = startPerf('models:loadStore')
        const settings = await loadSettings()
        // PERF-1：库列表存在性快照与激活库加载链互不依赖（只读 stat），
        // 提前并行发起——未挂载盘符的单次 stat 可能阻塞数秒，不再串行
        // 追加在激活库链之后拖慢首帧返回
        const rootStatusesPromise = collectRootStatuses(settings.modelsFolders)
        /** @type {Record<string, any>|null} */
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
            logger.warn(
              `已设置的模型目录不存在，跳过关联存储加载: ${settings.modelsFolder}`,
            )
          } else {
            await ensureRootStore(settings.modelsFolder, {
              maintenanceToken: token,
            })
            // PERF-1：孤儿封面清理与本地索引读取互不依赖（清理只触碰
            // covers 目录且自吞错误、内部 readdir→引用快照顺序保持不变；
            // 索引读失败返回 null），并行执行缩短启动/切库关键路径
            const index = await Promise.all([
              pruneOrphanCovers(),
              readLibraryIndex(settings.modelsFolder),
            ]).then(([, index]) => index)
            if (index) {
              // IDX-REUSE：先确保装饰/头部缓存归属当前根（冷启动首次进入或
              // 库切换时清空旧根状态），再播种索引中的头部解析结果；随后的
              // 启动后台校验在 mtime/size 未变时不再重复读文件头
              if (
                !samePathIgnoreCase(
                  getDecorateCacheRoot(),
                  settings.modelsFolder,
                )
              ) {
                resetDecorateCache(settings.modelsFolder)
                clearDeferredOwners()
                clearDeferredJobs()
              }
              primeHeaderInfoCache(index.models)
              // OPT-PAYLOAD：列表通道下发瘦身模型（先合成元数据展示字段，
              // 再剥离详情消费面重字段，顺序不可颠倒——合成依赖 folderSubCategory）
              const slimmed = slimModelsForList(
                overlayCurrentMeta(index.models),
              )
              logPayloadSize('models:loadStore', slimmed.approxBytes)
              cachedIndex = {
                ...index,
                models: slimmed.models,
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
              concurrency: settings.hashWarmupConcurrency,
              full: true,
            })
            // 目录监控启动路径闭合（OPT-19）：启动时若 autoScan 关闭则不会触发扫描，
            // 此前 watcher 仅在扫描/设置更新时同步，导致 autoRescan 开启却静默不生效；
            // 此处按设置补一次同步（同根同状态时为幂等刷新）
            syncWatcher(
              settings.modelsFolder,
              settings.autoRescan === true,
              settings.excludeDirs || [],
              { nativeWatch: true },
            )
          }
        }
        // F1-offline：库列表全量根目录存在性快照（PERF-1：已在链首并行发起，
        // 此处仅等待收尾；激活库失效分支同样需要回传）
        const rootStatuses = await rootStatusesPromise
        perf(
          `索引${cachedIndex ? '命中' : '缺失'} / 激活库${
            folderMissing ? '失效' : '正常'
          } / ${rootStatuses.filter((r) => !r.exists).length} 个失效库`,
        )
        return {
          settings,
          cachedIndex,
          folderMissing,
          rootStatuses,
        }
      } finally {
        releaseMaintenance(token)
      }
    },
    {
      errorPrefix: '数据加载失败',
      // OPT-3/OPT-11：列表通道阈值下调至 200ms——万级库的全量模型载荷是
      // 结构化克隆的大头，[perf] 数据驱动后续瘦身决策
      perfWarnMs: 200,
    },
  )
}
