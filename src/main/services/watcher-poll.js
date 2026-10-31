import path from 'node:path'
import fs from 'node:fs/promises'
import logger from '../logger'
import { relativeWithin } from '../utils'
import { dedupeAndPruneDescendants } from '../../shared/scan-dirs'
import { isVisibleScanEntry } from './scanner'
import { removeSnapshotSubtree } from './watcher-baseline'
import { getWatcher, stopWatcher } from './watcher-state'
import {
  collectDirSnapshot,
  computeSnapshotDiff,
  computeStatSnapshotDiff,
  namesFromSnapshot,
  statSelectedDirEntries,
} from './watcher-snapshot'
import { scheduleBroadcast } from './watcher-broadcast'

/**
 * 轮询巡检引擎（O12 自 watcher.js 拆出）：
 * 按间隔遍历目录树并比对快照——条目增删/重命名可靠反映在快照差异
 * 上，不受平台事件语义影响，是变更检测的**正确性来源**（原生事件仅加速触发）。
 * 空闲退避爬梯（A-07b）与窗口隐藏零 IO 探测（O8）由 nextDelay/runWalk 承担；
 * 遍历期间的代际校验（B2）保证旧根在途结果不覆盖新根基线。
 *
 * 活跃期分层巡检（PERF-4）：变更具有局部性（下载/解压通常持续写同一子树），
 * 上一轮检出变更后的连续巡检只遍历「根目录直属条目 + 热点子树」，每
 * fullWalkInterval 轮做一次全树遍历兜底冷区域——热点区域保持基础间隔的
 * 发现速度，冷区域变更发现延迟上界 = fullWalkInterval × 基础间隔，
 * 全树 readdir 的常驻成本在大库活跃写入期下降约 (N-1)/N。
 * 空闲（无变更）阶段无热点，行为与旧版逐轮全树遍历完全一致。
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

/**
 * 热点子树快照采集（PERF-4）：
 * - 根目录只 readdir 自身条目（与 collectDirSnapshot 同一可见性过滤）——
 *   顶层新增/删除在此显形，但不整树递归（那是全量轮的事）；
 * - 每个热点子树完整递归收集（startDepth 保持与全库一致的最大深度语义，
 *   与原生事件回填路径同款参数）。
 * @param {WatcherState} w 监控状态
 * @param {string[]} hotRels 热点子树（POSIX 相对路径，已去后代冗余）
 * @returns {Promise<{partial: Map<string, string[]>, hotRels: string[]}>}
 *   partial：本轮实际采集到的部分快照（绝对路径 -> 条目名）
 */
async function collectHotSnapshot(w, hotRels) {
  const partial = new Map()
  const entries = await fs.readdir(w.root, { withFileTypes: true })
  partial.set(
    w.root,
    entries
      .filter((entry) => isVisibleScanEntry(entry, w.excludeNames))
      .map((entry) => entry.name)
      .sort(),
  )
  for (const rel of hotRels) {
    if (rel === '') continue // 根直属由上方 readdir 覆盖（防御：'' 不得整树递归）
    const abs = path.join(w.root, ...rel.split('/'))
    try {
      const sub = await collectDirSnapshot(abs, w.excludeNames, {
        concurrency: w.traversalConcurrency,
        startDepth: rel.split('/').length,
      })
      for (const [dir, names] of sub) partial.set(dir, names)
    } catch (err) {
      // 子树在两轮之间被删除/不可读：跳过采集即可——差异会经「旧基线有、
      // 本轮无」检出，合并阶段移除其基线条目；其余错误按巡检异常上抛
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') continue
      throw err
    }
  }
  return { partial, hotRels }
}

/** 热点巡检的差异比较范围：本轮访问子树内的旧基线条目（子树被删时以缺失参与） */
function hotOldSub(w, root, hotRels, partial) {
  const oldSub = new Map()
  const hotAbs = hotRels
    .filter((rel) => rel !== '')
    .map((rel) => path.join(root, ...rel.split('/')))
  for (const [dir, names] of w.snapshot) {
    if (partial.has(dir)) {
      oldSub.set(dir, names)
      continue
    }
    if (hotAbs.some((abs) => relativeWithin(dir, abs) !== null)) {
      oldSub.set(dir, names)
    }
  }
  return oldSub
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

      // 基准轮：无条件全树遍历建立基线（不消耗 PERF-4 的全量/热点交替周期，
      // 也不读热点状态）——基准后首轮比对轮恒为全量轮，确保首个比对有完整视野
      if (silent) {
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
          w.idleRounds = 0
          return
        }
        if (wantStats) {
          w.statSnapshot = snapshot
          w.snapshot = namesFromSnapshot(snapshot)
          w.lastContentCheckAt = Date.now()
          // OPT-9：基线轮全树已 stat，全部目录记为本轮已校验
          const checkedAt = Date.now()
          w.contentCheckedAt = new Map()
          for (const dir of snapshot.keys()) w.contentCheckedAt.set(dir, checkedAt)
        } else {
          w.snapshot = snapshot
          w.statSnapshot = null
          w.lastContentCheckAt = 0
          w.contentCheckedAt = new Map()
        }
        w.snapshotRevision += 1
        return
      }

      // PERF-4：全量/热点轮判定——内容校验轮、无热点或到达全量回扫周期时
      // 走全树遍历；否则只巡「根直属条目 + 热点子树」。
      w.walkCount += 1
      // 根直属变更（rel=''）由热点轮的根 readdir 天然覆盖，不进子树集——
      // 否则 collectDirSnapshot(root) 会整树递归，破坏分层意义
      const hotRels =
        (w.walkCount - 1) % Math.max(1, w.fullWalkInterval) === 0
          ? []
          : dedupeAndPruneDescendants([...w.lastHotDirs]).filter(
              (rel) => rel !== '',
            )
      const isFullRound = wantStats || hotRels.length === 0

      let snapshot = null
      let hot = null
      if (wantStats) {
        // OPT-9：内容轮的采集在下方渐进分支内完成（基线重建与渐进两态各自
        // 采集所需的快照形态不同，此处不预采集以免双整树遍历）
      } else if (isFullRound) {
        snapshot = await collectDirSnapshot(w.root, w.excludeNames, {
          concurrency: w.traversalConcurrency,
        })
      } else {
        hot = await collectHotSnapshot(w, hotRels)
      }

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

      if (wantStats) {
        w.lastContentCheckAt = Date.now()
        // 基线缺失（扫描完成/切换根后的静默重建）：整树 stat 建立完整内容
        // 基线，全部目录记为本轮已校验。扫描本身会重排目录内容，一次性
        // 全量 stat 与事件相称；稳态下的渐进分桶才是常驻成本的大头
        if (!w.statSnapshot) {
          const snapshot = await collectDirSnapshot(w.root, w.excludeNames, {
            withStats: true,
            concurrency: w.traversalConcurrency,
          })
          if (
            w !== getWatcher() ||
            w.refreshing ||
            w.scanning ||
            w.snapshotRevision !== revisionAtStart
          ) {
            w.idleRounds = 0
            return
          }
          w.statSnapshot = snapshot
          w.snapshot = namesFromSnapshot(snapshot)
          const checkedAt = Date.now()
          w.contentCheckedAt = new Map()
          for (const dir of snapshot.keys())
            w.contentCheckedAt.set(dir, checkedAt)
          w.snapshotRevision += 1
          w.idleRounds += 1
          w.lastHotDirs = []
          return
        }

        // OPT-9 渐进内容校验：整树仅 readdir（名称事实，本就属于全量轮），
        // stat 按目录分桶——热点子树（近期检出变更处）与名称变化目录当轮
        // 必检（内容变化高发处），其余按「上次内容校验时间」最旧优先取每轮
        // 配额（ceil(目录数/fullWalkInterval)，下限 32），未校验目录沿用旧
        // size/mtime。同名覆盖写入的发现延迟 = 所在桶的轮转等待，全量覆盖
        // 窗口 ≈ fullWalkInterval × 内容校验周期；与名称分层（PERF-4）同一
        // 「热点即时、冷区轮转」的分层哲学，大库稳态的常驻 stat 底噪按
        // 配额比例下降
        const nameSnapshot = /** @type {Map<string, string[]>} */ (
          await collectDirSnapshot(w.root, w.excludeNames, {
            concurrency: w.traversalConcurrency,
          })
        )
        if (
          w !== getWatcher() ||
          w.refreshing ||
          w.scanning ||
          w.snapshotRevision !== revisionAtStart
        ) {
          w.idleRounds = 0
          return
        }

        // 名称变化目录必 stat：其内容条目已随增删失真，且变更目录正是
        // 内容变化高发处
        const nameChangedDirs = new Set()
        for (const rel of computeSnapshotDiff(w.root, w.snapshot, nameSnapshot)) {
          nameChangedDirs.add(
            rel === '' ? w.root : path.join(w.root, ...rel.split('/')),
          )
        }

        // 热点子树（近期检出变更，POSIX rel）展开为绝对目录集合（含后代）
        const hotAbs = w.lastHotDirs
          .filter((rel) => rel !== '')
          .map((rel) => path.join(w.root, ...rel.split('/')))
        const selected = new Set(nameChangedDirs)
        if (w.lastHotDirs.includes('')) selected.add(w.root)
        for (const dir of nameSnapshot.keys()) {
          if (
            dir !== w.root &&
            !selected.has(dir) &&
            hotAbs.some((abs) => relativeWithin(dir, abs) !== null)
          ) {
            selected.add(dir)
          }
        }
        // 轮转配额：其余目录按上次内容校验时间最旧优先补足
        const budget = Math.max(
          32,
          Math.ceil(nameSnapshot.size / Math.max(1, w.fullWalkInterval)),
        )
        if (selected.size < budget) {
          const rest = [...nameSnapshot.keys()]
            .filter((dir) => !selected.has(dir))
            .sort(
              (a, b) =>
                (w.contentCheckedAt.get(a) || 0) -
                (w.contentCheckedAt.get(b) || 0),
            )
          for (const dir of rest) {
            if (selected.size >= budget) break
            selected.add(dir)
          }
        }

        // stat 选中目录并与旧内容快照合并：未选中目录沿用旧条目（其名称
        // 事实未变——名称变化的目录已在必检集合内；size/mtime 陈旧由轮转
        // 保证有限窗口内刷新）。树中消失的目录随合并自然移除
        const fresh = await statSelectedDirEntries(nameSnapshot, selected)
        const merged = new Map()
        const checkedAt = Date.now()
        for (const dir of nameSnapshot.keys()) {
          const freshEntries = fresh.get(dir)
          if (freshEntries) {
            merged.set(dir, freshEntries)
            w.contentCheckedAt.set(dir, checkedAt)
            continue
          }
          const oldEntries = w.statSnapshot.get(dir)
          if (oldEntries) merged.set(dir, oldEntries)
        }
        for (const dir of [...w.contentCheckedAt.keys()]) {
          if (!nameSnapshot.has(dir)) w.contentCheckedAt.delete(dir)
        }

        // 内容差异（选中目录内的条目增删与同名覆盖一并显形；未选中目录
        // 新旧条目相同不产生差异）
        const changedDirs = computeStatSnapshotDiff(
          w.root,
          w.statSnapshot,
          merged,
        )
        w.statSnapshot = merged
        w.snapshot = nameSnapshot
        w.snapshotRevision += 1
        if (changedDirs.length === 0) {
          w.idleRounds += 1
          // 热点子树本轮内容校验未见变化：清空热点，后续轮次回到全树遍历
          w.lastHotDirs = []
          return
        }
        w.idleRounds = 0
        w.lastHotDirs = changedDirs
        scheduleBroadcast(w, changedDirs)
        return
      }

      if (isFullRound) {
        const changedDirs = computeSnapshotDiff(
          w.root,
          w.snapshot,
          /** @type {Map<string, string[]>} */ (snapshot),
        )
        if (changedDirs.length === 0) {
          w.idleRounds += 1
          w.lastHotDirs = [] // 全树确认无变更：无热点，后续轮次保持全树遍历
          return
        }
        w.snapshot = snapshot
        w.snapshotRevision += 1
        // 名称变化已触发重扫（扫描会读到当前内容）。OPT-9：内容基线不再整体
        // 置空——变化目录已记入热点，下个内容校验轮按渐进分桶 stat 这些目录
        // 并合并刷新基线（扫描完成时基线仍由 applyFull/PartialBaseline 置空
        // 重建，两条路径互不冲突）
        w.idleRounds = 0 // 有变更：退避重置，下一轮回到基础间隔
        w.lastHotDirs = changedDirs
        scheduleBroadcast(w, changedDirs)
        return
      }

      // 热点轮（PERF-4）：差异只比较本轮访问的子树，基线按子树合并——
      // 范围外目录视为未变，由周期性全量轮兜底冷区域。
      const changedDirs = computeSnapshotDiff(
        w.root,
        hotOldSub(w, w.root, hot.hotRels, hot.partial),
        hot.partial,
      )
      // 基线合并：先移除各热点子树的旧条目（含本轮发现已删除的子树），
      // 再写入新采集条目；根目录条目直接覆盖
      for (const rel of hot.hotRels) {
        removeSnapshotSubtree(w, path.join(w.root, ...rel.split('/')))
      }
      for (const [dir, names] of hot.partial) w.snapshot.set(dir, names)
      if (changedDirs.length === 0) {
        // 热点区域暂无新变化：保留热点继续盯（下载/解压可能分批写入），
        // 退避照常爬梯；全量回扫周期到期后由全量轮确认并清空热点
        w.idleRounds += 1
        return
      }
      // OPT-9：内容基线不再整体置空——变化目录已记入热点，下个内容校验轮
      // 按渐进分桶 stat 并合并刷新（扫描完成时仍由 baseline 置空重建）
      w.snapshotRevision += 1
      w.idleRounds = 0
      w.lastHotDirs = changedDirs
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
