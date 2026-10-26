import logger from '../logger'
import { getWatcher, stopWatcher } from './watcher-state'
import {
  collectDirSnapshot,
  computeSnapshotDiff,
  computeStatSnapshotDiff,
  namesFromSnapshot,
} from './watcher-snapshot'
import { scheduleBroadcast } from './watcher-broadcast'

/**
 * 轮询巡检引擎（O12 自 watcher.js 拆出）：
 * 按固定间隔递归遍历目录树并比对快照——条目增删/重命名可靠反映在快照差异
 * 上，不受平台事件语义影响，是变更检测的**正确性来源**（原生事件仅加速触发）。
 * 空闲退避爬梯（A-07b）与窗口隐藏零 IO 探测（O8）由 nextDelay/runWalk 承担；
 * 遍历期间的代际校验（B2）保证旧根在途结果不覆盖新根基线。
 */

/** @typedef {import('./watcher-state').WatcherState} WatcherState */
/** @typedef {import('./watcher-snapshot').SnapshotEntry} SnapshotEntry */

/**
 * 计算下一轮巡检延迟（A-07b 空闲退避；O8 可见性感知）：
 * - 无 backoff 配置（旧 timing）时恒定基础间隔；
 * - 窗口隐藏时恒为基础间隔：隐藏轮不读盘（runWalk 跳过），巡检只是轻量的
 *   可见性探测——以基础间隔探测使「恢复可见后的首次比对」不受阶梯封顶值
 *   拖累（否则封顶 30s 下，切回应用后最坏要等 30s 才发现隐藏期的变更）；
 * - 可见且有阶梯：按连续空闲轮数爬梯（封顶取末档）。
 */
function nextDelay(w) {
  const ladder = w.backoff
  if (!Array.isArray(ladder) || ladder.length === 0) return w.pollInterval
  if (typeof w.isVisible === 'function' && !w.isVisible()) return w.pollInterval
  return ladder[Math.min(w.idleRounds, ladder.length - 1)]
}

/** 安排下一轮巡检并对外通告实际延迟（测试钩子 onPollScheduled） */
export function scheduleNextWalk(w) {
  if (w !== getWatcher() || !getWatcher()) return // 遍历期间监控可能已被停止/替换
  const delay = nextDelay(w)
  w.timer = setTimeout(() => runWalk(w, false), delay)
  w.timer.unref?.()
  if (typeof w.onPollScheduled === 'function') w.onPollScheduled(delay)
}

export function runWalk(w, silent) {
  // 上一次遍历未完成（超大目录树）/快照回填中/扫描期：本轮跳过读盘，
  // 仅安排下一轮，避免并发遍历或与扫描基线互相覆盖（OPT-02）
  if (w.polling || w.refreshing || w.scanning) {
    scheduleNextWalk(w)
    return
  }
  w.polling = true
  Promise.resolve()
    .then(async () => {
      // 非基准轮且窗口隐藏（最小化）：跳过目录遍历，零磁盘 IO——
      // 仅靠下一轮定时器轻量探测可见性，移动硬盘/网络盘不被 readdir 唤醒。
      // 隐藏期间不增减空闲计数；恢复后暂停期间积累的变更由首次比对自然发现。
      if (!silent && typeof w.isVisible === 'function' && !w.isVisible()) return

      // O4：内容校验轮采集 size/mtime；其余轮次只做低成本名称比对。
      // 基准轮（silent）必须建立内容基线，否则首个间隔内的同名覆盖无法发现。
      const contentEnabled =
        Number.isFinite(w.contentCheckInterval) && w.contentCheckInterval > 0
      const wantStats =
        contentEnabled &&
        (silent || Date.now() - w.lastContentCheckAt >= w.contentCheckInterval)
      const revisionAtStart = w.snapshotRevision
      const snapshot = await collectDirSnapshot(w.root, w.excludeNames, {
        withStats: wantStats,
        concurrency: w.traversalConcurrency,
      })

      // 遍历期间进入扫描期/开始原生事件回填/基线已被其他路径更新：本轮结果
      // 可能落后于对方基线，直接丢弃，避免用旧快照覆盖新基线并重复广播
      if (
        w !== getWatcher() ||
        w.refreshing ||
        w.scanning ||
        w.snapshotRevision !== revisionAtStart
      ) {
        // 对方基线更新意味着目录刚有活动：退避重置，下一轮尽快复核
        w.idleRounds = 0
        return
      }

      if (silent) {
        if (wantStats) {
          w.statSnapshot = snapshot
          w.snapshot = namesFromSnapshot(snapshot)
          w.lastContentCheckAt = Date.now()
        } else {
          w.snapshot = snapshot
          w.statSnapshot = null
          w.lastContentCheckAt = 0
        }
        w.snapshotRevision += 1
        return
      }

      if (wantStats) {
        w.lastContentCheckAt = Date.now()
        const names = namesFromSnapshot(snapshot)
        // 名称变化轮已触发重扫时内容基线会被置空：本轮只重建基线，不重复广播
        const changedDirs = w.statSnapshot
          ? computeStatSnapshotDiff(
              w.root,
              w.statSnapshot,
              /** @type {Map<string, SnapshotEntry[]>} */ (snapshot),
            )
          : []
        w.statSnapshot = snapshot
        w.snapshot = names
        w.snapshotRevision += 1
        if (changedDirs.length === 0) {
          w.idleRounds += 1
          return
        }
        w.idleRounds = 0
        scheduleBroadcast(w, changedDirs)
        return
      }

      const changedDirs = computeSnapshotDiff(
        w.root,
        w.snapshot,
        /** @type {Map<string, string[]>} */ (snapshot),
      )
      if (changedDirs.length === 0) {
        w.idleRounds += 1
        return
      }
      w.snapshot = snapshot
      w.snapshotRevision += 1
      // 名称变化已触发重扫（扫描会读到当前内容）；内容基线失效，下个内容
      // 校验轮静默重建，避免对同一批变更重复广播
      w.statSnapshot = null
      w.idleRounds = 0 // 有变更：退避重置，下一轮回到基础间隔
      scheduleBroadcast(w, changedDirs)
    })
    .catch((err) => {
      // 根目录不可读（被删除/离线）：停止监控，等下次扫描/设置变更重新发起。
      // 代际校验（B2 修复）：异常来自旧根的在途遍历时，当前监控状态已是新根，
      // 绝不能被误停——只丢弃该次遍历
      logger.warn(
        `目录监控异常${w === getWatcher() ? '，已停止' : '（旧根遍历已丢弃）'}: ${err.message}`,
      )
      if (w === getWatcher()) stopWatcher()
    })
    .finally(() => {
      w.polling = false
      // 基准轮与正常轮都由统一的递归 setTimeout 链安排下一轮；
      // 基准轮 idleRounds=0，首次延迟即基础间隔（stopWatcher 已清 timer 时不再排）
      scheduleNextWalk(w)
    })
}
