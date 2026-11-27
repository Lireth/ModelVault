/**
 * 局部增量扫描通道 models:partialScan：watcher 检出变更子树后仅重扫
 * 这些子树并装饰返回（完整 handler 体，自 scan.js 原样迁移）。
 */

import { BrowserWindow } from 'electron'
import logger from '../../../logger'
import {
  getCurrentRoot,
  getSettings,
  isRegisteredLibrary,
  relinkScannedMeta,
} from '../../../services/store'
import { scanModels } from '../../../services/scanner'
import {
  refreshWatcherBaseline,
  setWatcherScanning,
} from '../../../services/watcher'
import {
  pauseHashWarmup,
  requestHashWarmup,
  resumeHashWarmup,
} from '../../../services/hash-warmup'
import { decorateModels, startThumbDrain } from '../decorate'
import { ensureRootStore } from '../store'
import {
  withMaintenanceLock,
  wrapHandler,
  checkExistingDirectory,
} from '../../handler'
import { samePathIgnoreCase } from '../../../utils'
import { normalizePartialScanDirs } from '../../../../shared/scan-dirs'
import { queueLibraryIndexUpdate } from '../../../services/library-index'
import { slimModelsForList, logPayloadSize } from '../list-payload'
import { updateListSnapshotPartial } from '../list-delta'
import { resolveScanExtensions, scanState } from './shared'

/** 注册局部增量扫描通道的 IPC 处理器 */
export function registerPartialScanHandler() {
  // 局部增量扫描（A-03）：watcher 检出变更子树后，仅重扫这些子树并装饰返回。
  // 与全量扫描、切库、备份恢复共用全局维护锁（V-02）；不做孤儿封面清理
  // （全量扫描兜底）、不回写设置/不重启 watcher；重关联限定在受影响子树内。
  wrapHandler(
    'models:partialScan',
    async (event, { folder, dirs } = {}) => {
      const root =
        typeof folder === 'string' && folder
          ? folder
          : getSettings().modelsFolder
      if (!root) return { error: '尚未设置模型文件夹' }
      // 同步获取维护锁（B-01/V-02）：任何 await 之前完成，防止并发穿透
      return withMaintenanceLock('partial-scan', root, async (token) => {
        const abort = new AbortController()
        scanState.controller = abort
        const signal = abort.signal
        const startedAt = Date.now()
        try {
          // OPT-02：与全量扫描一致，局部扫描期间暂停监控巡检/广播并按扫描
          // 范围回填基线，避免扫描已覆盖的变更再次触发局部扫描
          setWatcherScanning(true)
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
          // error 为空即 subDirs 必已产出（normalizePartialScanDirs 契约）
          const subDirs = /** @type {string[]} */ (normalized.subDirs)
          if (normalized.collapsed) {
            logger.info(
              `局部扫描子树过多，已收敛为 ${subDirs.length} 个一级目录`,
            )
          }

          // 与全量扫描一致的目录前置校验（白名单 + 存在性）
          if (!isRegisteredLibrary(root)) {
            logger.warn(`拒绝局部扫描模型库列表之外的目录: ${root}`)
            return { error: '该目录不在模型库列表中' }
          }
          const dirInvalid = await checkExistingDirectory(
            root,
            '模型文件夹不存在或不是目录',
          )
          if (dirInvalid) {
            // F1-offline：同全量扫描——附失效标志，渲染层置位离线态且不再
            // 降级为注定连环失败的全量扫描
            return { error: dirInvalid, folderMissing: true }
          }
          // 局部扫描只作用于当前根（V-02）：渲染层请求发出后根已切换时直接拒绝，
          // 绝不能借 ensureRootStore 把主进程根目录切回旧库
          const currentRoot = getCurrentRoot()
          if (currentRoot && !samePathIgnoreCase(root, currentRoot)) {
            logger.warn(
              `拒绝针对非当前根的局部扫描: ${root}（当前 ${currentRoot}）`,
            )
            return { error: '模型库已切换，请稍后重试' }
          }

          await ensureRootStore(root, { maintenanceToken: token })
          const appSettings = getSettings()
          const scanResult = await scanModels(root, null, {
            excludeDirs: appSettings.excludeDirs || [],
            // 与全量扫描一致地应用用户配置的扫描扩展名（B3 修复）：此前传
            // undefined 落回默认全集，用户已排除的扩展名（如 .ckpt）会在
            // watcher 触发一次局部重扫后“复活”，局部结果与全量结果不一致。
            // 兜底口径与全量扫描共用 resolveScanExtensions（FIX-5）
            extensions: resolveScanExtensions(appSettings),
            subDirs,
            signal,
          })
          const models = scanResult.models
          // B5：读取失败（非 ENOENT）的子树——其旧模型/索引/基线一律保留，
          // 不参与重关联孤儿判定与移除语义（扫描不到 ≠ 已删除）
          const failedDirs = Array.isArray(scanResult.failedDirs)
            ? scanResult.failedDirs
            : []
          if (failedDirs.length > 0) {
            logger.warn(
              `局部扫描有 ${failedDirs.length} 个目录读取失败，已保留其既有数据: ${failedDirs.slice(0, 10).join(', ')}`,
            )
          }
          // 重关联限定受影响子树：范围外与失败子树内的元数据保持原样
          const relinkResult = relinkScannedMeta(models, {
            affectedDirs: subDirs,
            excludeDirs: failedDirs,
          })
          // pruneThumbs=false（OPT-1 修复）：局部装饰仅覆盖变更子树，若按局部
          // usedThumbs 清理会把子树外模型的全部缩略图误删（缓存命中路径不会重新
          // 生成，坏图将持续到元数据变化）。失效缩略图与孤儿封面同一约定：
          // 由下一次全量扫描兜底清理。
          // forceRefresh（OPT-07/OPT-08）：变更子树内的 sidecar/封面文件变化不
          // 会改动模型 mtime，必须启用文件级缓存复核，否则新增/修改的 sidecar
          // 与预览图会被旧缓存遮蔽。OPT-8 起复核细化为 sidecar 家族文件级事实
          // 比对：子树内未变化的模型照常命中缓存（不再随每轮局部扫描重做
          // 16MB 级 safetensors 头解析），仅真实变化的模型完整重装饰
          const decorated = await decorateModels(models, signal, {
            pruneThumbs: false,
            forceRefresh: true,
            // O-3：复用本次局部扫描的目录清单剪枝 sidecar 候选探测
            dirSnapshot: scanResult.dirSnapshot,
            // O-3b：含被可见性过滤条目目录的全量清单（符号链接 sidecar 检出）
            dirRawNames: scanResult.dirRawNames,
          })
          models.length = 0 // 同全量扫描：装饰后立即释放原始数组（O8）
          // SCAN-DELTA：局部结果同步进快照注册表（渲染层将合并同一批对象，
          // 注册表保持为渲染层列表的镜像；尚无快照时跳过，全量扫描自然播种）
          updateListSnapshotPartial(root, decorated)

          // O8/OPT-03：局部结果合并入索引更新队列，短窗口内多次局部扫描只做
          // 一次索引读改写；索引缺失时跳过，不凭空创建不完整索引。
          // 退出路径经 flushIndexWrites 将待合并更新一并落盘。
          queueLibraryIndexUpdate(root, {
            upsertModels: decorated,
            affectedDirs: subDirs,
            excludeDirs: failedDirs,
          })

          const win = BrowserWindow.fromWebContents(event.sender)
          // 装饰中新登记的缩略图任务经既有后台链生成并推送
          startThumbDrain(win)

          // 受影响子树的哈希预热（同全量扫描，Civitai 识别加速）。
          // O1：局部扫描不是完整快照——按 id 合并体积索引，使新增文件与子树外
          // 同尺寸模型也能被识别为重复候选
          requestHashWarmup(decorated, {
            mode: appSettings.hashWarmup,
            concurrency: appSettings.hashWarmupConcurrency,
            full: false,
          })

          // OPT-02：只回填受影响子树的监控基线，并清理这些子树对应的待广播项；
          // 范围外基线保持原样，未覆盖的新变更仍会在停扫后补发。
          // B5：失败子树不回填基线也不清待广播——停扫后自动重试直至恢复
          if (scanResult.dirSnapshot instanceof Map) {
            refreshWatcherBaseline(
              root,
              subDirs,
              scanResult.dirSnapshot,
              failedDirs,
            )
          }

          logger.info(
            `局部扫描完成：${subDirs.length} 个子树 → ${decorated.length} 个模型 / 重关联 ${relinkResult.relinked} 个`,
          )

          // OPT-PAYLOAD：局部结果同全量扫描口径瘦身后再下发
          const slimmed = slimModelsForList(decorated)
          logPayloadSize('models:partialScan', slimmed.approxBytes)
          return {
            models: slimmed.models,
            dirs: subDirs,
            failedDirs,
            relinked: relinkResult.relinked,
            durationMs: Date.now() - startedAt,
          }
        } finally {
          scanState.controller = null
          resumeHashWarmup()
          setWatcherScanning(false)
        }
      })
    },
    { errorPrefix: '局部扫描失败', perfWarnMs: 200 },
  )
}
