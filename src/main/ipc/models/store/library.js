/**
 * 模型库通道：
 * - models:openLibrary  已保存库的秒开（本地索引优先，无索引交由渲染层全量扫描）
 * - models:chooseFolder 原生目录选择（仅登记库列表，扫描成功后激活）
 * - models:crossLibraryOverview 跨库只读总览
 */

import { BrowserWindow, dialog } from 'electron'
import logger from '../../../logger'
import { samePathIgnoreCase } from '../../../utils'
import {
  getSettings,
  isRegisteredLibrary,
  updateSettings,
} from '../../../services/store'
import { startPerf } from '../../../services/perf'
import { syncWatcher } from '../../../services/watcher'
import { requestHashWarmup } from '../../../services/hash-warmup'
import {
  getDecorateCacheRoot,
  resetDecorateCache,
} from '../../../services/decorate/state'
import { clearDeferredOwners, primeHeaderInfoCache } from '../decorate'
import { clearDeferredJobs } from '../../../services/thumbs'
import { slimModelsForList, logPayloadSize } from '../list-payload'
import {
  withMaintenanceLock,
  wrapHandler,
  checkExistingDirectory,
} from '../../handler'
import { readLibraryIndex } from '../../../services/library-index'
import { collectLibraryOverview } from '../../../services/library-overview'
import { ensureRootStore } from './session'
import { overlayCurrentMeta } from './list-view'

/** 注册模型库打开/选择与跨库总览通道 */
export function registerLibraryHandlers() {
  // F1：打开已保存的模型库并优先返回本地索引（秒切库）。
  // 索引缺失/失效时 cached=false，由渲染层回退全量扫描。
  wrapHandler(
    'models:openLibrary',
    async (event, { folder } = {}) => {
      const root = typeof folder === 'string' ? folder.trim() : ''
      if (!root) return { error: '缺少模型文件夹' }
      if (!isRegisteredLibrary(root)) {
        logger.warn(`拒绝打开模型库列表之外的目录: ${root}`)
        return { error: '该目录不在模型库列表中' }
      }
      const dirInvalid = await checkExistingDirectory(
        root,
        '模型文件夹不存在或不是目录',
      )
      // F1-offline：附失效标志——渲染层据此提交目标库身份并进入离线态
      // （重新定位/重试闭环），而非笼统的错误 toast
      if (dirInvalid) return { error: dirInvalid, folderMissing: true }

      // 先探测索引：无可用索引时不切换主进程根目录，交由渲染层走
      // scanModels 的 V-02 状态机（扫描失败可回滚旧库）
      // PERF-2：秒切库全程耗时观测（索引探测 + 维护锁 + 关联存储切换）
      const perf = startPerf('models:openLibrary')
      const cachedIndex = await readLibraryIndex(root)
      if (!cachedIndex) {
        logger.info(`模型库无可用本地索引，回退全量扫描: ${root}`)
        return { root, cached: false }
      }

      return withMaintenanceLock('switch', root, async (token) => {
        await ensureRootStore(root, { maintenanceToken: token })
        // IDX-REUSE：切库后的后台校验复用目标库索引中的头部解析结果。
        // 先清空旧根的装饰/头部缓存与延迟缩略图归属，再按目标索引播种，
        // 使随后的后台校验扫描无需再次读取索引即可命中头部快照
        if (!samePathIgnoreCase(getDecorateCacheRoot(), root)) {
          resetDecorateCache(root)
          clearDeferredOwners()
          clearDeferredJobs()
        }
        primeHeaderInfoCache(cachedIndex.models)
        // 切库成功后才提交激活库（与扫描链路同一 V-02 状态机）
        await updateSettings({ modelsFolder: root })
        const settings = getSettings()
        syncWatcher(
          root,
          settings.autoRescan === true,
          settings.excludeDirs || [],
          {
            nativeWatch: true,
          },
        )
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
          concurrency: settings.hashWarmupConcurrency,
          full: true,
        })
        logger.info(
          `模型库已打开（本地索引 ${cachedIndex.models.length} 个模型）: ${root}`,
        )
        perf(`本地索引 ${cachedIndex.models.length} 个模型`)
        // OPT-PAYLOAD：秒开列表下发瘦身模型（先合成元数据展示字段再剥离，
        // 顺序不可颠倒——合成依赖 folderSubCategory）
        const slimmed = slimModelsForList(
          overlayCurrentMeta(/** @type {any[]} */ (cachedIndex.models)),
        )
        logPayloadSize('models:openLibrary', slimmed.approxBytes)
        return {
          root,
          settings,
          cached: true,
          models: slimmed.models,
          savedAt: cachedIndex.savedAt,
          durationMs: cachedIndex.durationMs,
        }
      })
    },
    { errorPrefix: '打开模型库失败', perfWarnMs: 200 },
  )

  // 选择模型根目录
  wrapHandler(
    'models:chooseFolder',
    async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      // win 为 null 仅当发起方 webContents 已销毁；Electron 对 null 按无父窗
      // 对话框处理，cast 仅收窄类型、运行时行为不变
      const result = await dialog.showOpenDialog(
        /** @type {import('electron').BrowserWindow} */ (win),
        {
          title: '选择模型文件夹',
          properties: ['openDirectory'],
        },
      )
      if (result.canceled || result.filePaths.length === 0) return null
      const folder = /** @type {string} */ (result.filePaths[0])
      // V-02 切库状态机：选择阶段只把目录加入库列表（供随后的 models:scan
      // 通过白名单校验），不提前写 modelsFolder——只有扫描成功才由 scan 链路
      // 提交为激活库；扫描失败/取消时保持原激活库不变
      const folders = getSettings().modelsFolders || []
      const known = folders.some(
        (f) =>
          typeof f === 'string' && f.toLowerCase() === folder.toLowerCase(),
      )
      if (!known) {
        await updateSettings({ modelsFolders: [...folders, folder] })
      }
      logger.info(`已选择模型目录（待扫描成功后激活）: ${folder}`)
      return folder
    },
    { errorPrefix: '选择文件夹失败' },
  )

  // 跨库存储总览（FN-01）：只读汇总各库索引/元数据，输出跨库重复组与
  // 可释放空间。不获取维护锁、不切换当前根——可在扫描/备份期间安全调用
  wrapHandler('models:crossLibraryOverview', () => collectLibraryOverview(), {
    errorPrefix: '跨库存储分析失败',
  })
}
