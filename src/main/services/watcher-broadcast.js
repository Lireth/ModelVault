import path from 'node:path'
import { BrowserWindow } from 'electron'
import logger from '../logger'
import { relativeWithin } from '../utils'
import { dedupeAndPruneDescendants } from '../../shared/scan-dirs'
import { MAX_SCAN_DEPTH } from './scanner'
import { getWatcher, stopWatcher } from './watcher-state'
import {
  collectDirSnapshot,
  computeSnapshotDiff,
  computeStatSnapshotDiff,
  namesFromSnapshot,
} from './watcher-snapshot'
import { removeSnapshotSubtree } from './watcher-baseline'

/**
 * 防抖广播与投递（O12 自 watcher.js 拆出）：
 * 变更目录在防抖静默期内取并集，一次防抖窗只向渲染进程广播一次
 * models:fsChanged（渲染层据此触发局部重扫）。两类来源：
 * - 轮询确认（confirmedDirs）：快照已更新，直接广播；
 * - 原生事件候选（nativeDirs）：先回填快照基线再做差异比较，只有真实变化
 *   才广播——重复/噪声事件不再触发第二次局部扫描（OPT-02）。
 * 所有入口都做 `w !== getWatcher()` 代际校验（B2）：旧根在途批次一律丢弃。
 */

/** @typedef {import('./watcher-state').WatcherState} WatcherState */

/** 向所有窗口广播目录变更 */
function broadcast(root, dirs = []) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('models:fsChanged', { root, dirs })
    }
  }
}

/**
 * 原生事件广播后回填相关子树快照（OPT-02）：
 * 事件只用于提前触发，快照才是正确性来源；若不回填，下一轮轮询会把同一
 * 变更再当作新变更广播一次，导致重复局部扫描。
 * 回填成本与事件语义成比例（OPT-10）：
 * - 定位子树（rel !== ''）：子树内 readdir（内容基线存在时含 stat）——
 *   成本与子树大小成比例；
 * - filename 缺失（unlocated，nativeDirs 为空 = 无法定位变更位置）：降级为
 *   全根「仅名称」回填并把内容基线置空——ReadDirectoryChangesW 缓冲溢出
 *   的突发不再反复触发即时全树 stat，内容基线由后续内容校验轮按 OPT-9
 *   渐进分桶重建；
 * @param {WatcherState} w 监控状态
 * @param {string[]} relDirs 变更子树（空数组表示无法定位，按全根处理）
 * @param {boolean} [unlocated] 本次事件是否无法定位变更位置（filename 缺失）
 * @returns {Promise<void>}
 */
async function refreshSnapshotScopes(w, relDirs, unlocated = false) {
  if (w !== getWatcher() || w.refreshing) return
  w.refreshing = true
  try {
    const scopes = dedupeAndPruneDescendants(
      Array.isArray(relDirs) && relDirs.length > 0 ? relDirs : [''],
    )
    for (const rel of scopes) {
      if (w !== getWatcher()) return
      const depth = rel === '' ? 0 : rel.split('/').length
      if (depth > MAX_SCAN_DEPTH) continue
      const abs = rel === '' ? w.root : path.join(w.root, ...rel.split('/'))
      if (relativeWithin(abs, w.root) === null) continue
      // OPT-10：unlocated 的全根回填强制仅名称（内容基线随之置空，见上）
      const withStats = Boolean(w.statSnapshot) && !(unlocated && rel === '')
      let snapshot
      try {
        snapshot = await collectDirSnapshot(abs, w.excludeNames, {
          withStats,
          concurrency: w.traversalConcurrency,
          startDepth: depth,
        })
      } catch (err) {
        // 子树在事件与回填之间被删除：移除其快照即可，由父目录条目反映变更
        if (rel !== '' && (err?.code === 'ENOENT' || err?.code === 'ENOTDIR')) {
          removeSnapshotSubtree(w, abs)
          continue
        }
        throw err
      }
      if (w !== getWatcher()) return
      if (rel === '') {
        // 无法定位子树（filename 缺失等）：按全根刷新，后续轮询以本次为基线；
        // unlocated 时 withStats=false，内容基线在此置空（交给内容校验轮重建）
        w.snapshot = withStats ? namesFromSnapshot(snapshot) : snapshot
        w.statSnapshot = withStats ? snapshot : null
        continue
      }
      removeSnapshotSubtree(w, abs)
      for (const [dir, names] of snapshot) {
        w.snapshot.set(
          dir,
          withStats ? names.map((entry) => entry.name) : names,
        )
        if (withStats && w.statSnapshot) w.statSnapshot.set(dir, names)
      }
    }
  } catch (err) {
    logger.warn(
      `原生事件快照回填失败${w === getWatcher() ? '，已停止监控' : '（旧根已丢弃）'}: ${err.message}`,
    )
    if (w === getWatcher()) stopWatcher()
  } finally {
    if (w === getWatcher()) {
      // 即便本次回填提前返回/部分更新，也推进代际，令并发中的巡检快照作废
      w.snapshotRevision += 1
      w.refreshing = false
    }
  }
}

/**
 * 防抖结束时交付广播（OPT-02）：
 * - 轮询已确认的变更（confirmedDirs）直接参与广播；
 * - 原生事件候选（nativeDirs）先回填快照，再与回填前的基线做差异比较，
 *   只有真实变化才广播——重复/噪声事件不再触发第二次局部扫描；
 * - 两类来源取并集并去重，仍保持「一次防抖窗只广播一次」；
 * - 回填期间进入扫描期（FIX-4 交付竞态）：不广播也不丢弃——回填已把变更
 *   写入基线，丢弃会让下一轮轮询 diff 为空，变更将永远不再被检出；改为把
 *   差异比较确认的真实变化写回待广播集合，由停扫补发链路承接（若后续扫描
 *   覆盖了这些子树，clearScannedPendingDirs 会按 scopes 去重清理）。
 * @param {WatcherState} w 监控状态
 * @param {string[]} nativeDirs 原生事件候选子树
 * @param {string[]} confirmedDirs 轮询已确认的变更子树
 * @param {boolean} needsRefresh 是否需要回填原生事件候选快照
 * @returns {Promise<void>}
 */
async function deliverBroadcast(w, nativeDirs, confirmedDirs, needsRefresh) {
  if (w !== getWatcher() || w.scanning) return
  let dirs = [...confirmedDirs]
  if (needsRefresh) {
    const before = new Map(w.snapshot)
    const beforeStats = w.statSnapshot ? new Map(w.statSnapshot) : null
    // OPT-10：filename 缺失（nativeDirs 为空）= 无法定位变更位置——降级为
    // 仅名称回填并把内容基线置空（refreshSnapshotScopes 内），缓冲溢出突发
    // 不再反复触发即时全树 stat；内容校验轮按 OPT-9 渐进分桶重建基线。
    // 回填后的差异比较自动落到名称通道（statSnapshot 已置空）
    const unlocated = nativeDirs.length === 0
    await refreshSnapshotScopes(w, nativeDirs, unlocated)
    if (w !== getWatcher()) return
    const refreshed =
      beforeStats && w.statSnapshot
        ? computeStatSnapshotDiff(w.root, beforeStats, w.statSnapshot)
        : computeSnapshotDiff(w.root, before, w.snapshot)
    dirs = [...new Set([...dirs, ...refreshed])].sort()
  }
  if (dirs.length === 0) {
    // 原生事件未产生任何快照差异（重复/噪声事件）：不广播，避免重复局部扫描
    return
  }
  if (w.scanning) {
    // FIX-4：基线已含本次变更，静默丢弃 = 永久丢失（见函数 JSDoc）。
    // 写回 pendingConfirmedDirs：变更已经差异比较确认为真实变化且基线
    // 已更新，语义与轮询确认项一致，停扫补发无需再次回填。
    for (const d of dirs) w.pendingConfirmedDirs.add(d)
    logger.info(
      `扫描期检出目录变更，转停扫补发: ${w.root}（${dirs.length} 个子树）`,
    )
    return
  }
  logger.info(
    `检测到模型目录变更，触发重扫: ${w.root}（${dirs.length} 个子树）`,
  )
  broadcast(w.root, dirs)
}

/** 串行消费广播队列：同一 watcher 同一时刻只交付一轮，避免回填交叉 */
async function pumpDeliverQueue(w) {
  if (w.delivering) return
  w.delivering = true
  try {
    while (w === getWatcher() && w.deliverQueue.length > 0) {
      const entry = w.deliverQueue.shift()
      try {
        await deliverBroadcast(
          w,
          entry.nativeDirs,
          entry.confirmedDirs,
          entry.needsRefresh,
        )
      } catch (err) {
        // 单批失败不阻塞后续批次；下一轮轮询仍会兜底检出未广播的变更
        logger.warn(`目录变更广播交付失败: ${err.message}`)
      }
    }
  } finally {
    w.delivering = false
  }
}

/** 安排防抖广播定时器（扫描期/已有定时器时不重复安排） */
export function scheduleBroadcastTimer(w) {
  if (w !== getWatcher() || w.scanning || w.debounceTimer) return
  w.debounceTimer = setTimeout(() => {
    w.debounceTimer = null
    const nativeDirs = [...w.pendingDirs].sort()
    const confirmedDirs = [...w.pendingConfirmedDirs].sort()
    w.pendingDirs.clear()
    w.pendingConfirmedDirs.clear()
    const needsRefresh = w.pendingNeedsRefresh
    w.pendingNeedsRefresh = false
    w.deliverQueue.push({ nativeDirs, confirmedDirs, needsRefresh })
    void pumpDeliverQueue(w)
  }, w.debounceMs)
}

/**
 * 防抖广播：静默期内多轮变更只广播一次，变更目录取并集（A-03）。
 * 代际校验（B2 修复）：w 已不是当前监控状态（stop/syncWatcher 切换到新根）
 * 时，旧根在途遍历检出的变更必须直接丢弃——否则它会设置一个无人清理的
 * 防抖定时器，稍后向渲染进程广播旧根的 models:fsChanged，可能触发
 * partialScan(旧根) 把用户刚切换的库静默切回旧根。
 * diff 目录在每轮发现变更时合入 w.pendingDirs，广播载荷携带 { root, dirs }，
 * 渲染层据此只重扫这些子树。
 * @param {WatcherState} w 监控状态
 * @param {string[]} changedDirs 变更子树
 * @param {{refresh?: boolean}} [options] refresh=true 表示来源为原生事件，
 *   广播后需回填快照基线（OPT-02）
 */
export function scheduleBroadcast(w, changedDirs = [], options = {}) {
  if (w !== getWatcher()) return
  if (options.refresh === true) {
    w.pendingNeedsRefresh = true
  } else {
    // 轮询快照已更新：这些目录是已确认变更，无需回填即可广播
    for (const d of changedDirs) w.pendingConfirmedDirs.add(d)
  }
  if (!Array.isArray(w.pendingDirs)) w.pendingDirs = new Set()
  for (const d of changedDirs) w.pendingDirs.add(d)
  if (w.scanning) return
  scheduleBroadcastTimer(w)
}
