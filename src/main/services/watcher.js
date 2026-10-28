import { BrowserWindow } from 'electron'
import logger from '../logger'
import { samePathIgnoreCase } from '../utils'
import { applyFullBaseline, applyPartialBaseline } from './watcher-baseline'
import { scheduleBroadcastTimer } from './watcher-broadcast'
import { startNativeWatch } from './watcher-native'
import { runWalk, scheduleNextWalk } from './watcher-poll'
import {
  DEFAULT_BACKOFF,
  DEFAULT_BROADCAST_DEBOUNCE,
  DEFAULT_CONTENT_CHECK_INTERVAL,
  DEFAULT_FULL_WALK_INTERVAL,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_TRAVERSAL_CONCURRENCY,
  NATIVE_WATCH_FALLBACK_BACKOFF,
  NATIVE_WATCH_POLL_INTERVAL,
  getWatcher,
  setWatcher,
  stop,
  toNameSet,
} from './watcher-state'
import { normalizeConcurrency } from './watcher-snapshot'

/**
 * 模型目录变更监控（E8；A8 轮询快照 + OP-05 原生事件加速）：
 *
 * 历史：纯 fs.watch recursive 在 Windows 上端到端不可靠（漏事件、filename
 * 偶发为 null、缓冲区溢出丢细节）；因此 A8 改为轮询快照作为**正确性来源**。
 * OP-05 在此基础上增加可选的原生事件监听作为**加速触发**：
 * - 事件只用于提前触发防抖广播，快照差异仍是最终判据（漏事件由轮询兜底）；
 * - 原生监听可用时轮询间隔延长到 15s 起（仍受内容校验与空闲退避约束），
 *   降低持续 readdir 开销；监听初始化失败则立即回落到原 2s 阶梯；
 * - 事件路径中的 .modelvault/隐藏项/用户排除目录一律忽略，避免自激励。
 *
 * 轮询实现：按固定间隔递归遍历目录树并比对快照（目录 -> 条目名列表）——
 * - 条目增减/重命名可靠反映在快照差异上，不受平台事件语义影响；
 * - 与 scanner 共享排除策略（隐藏项/put_/node_modules/.git/.modelvault/
 *   $RECYCLE.BIN/System Volume Information）与最大深度：排除项既不记录也不
 *   递归，从机制上根除「监听自身写入」的自激励问题，也避免监控侧关注扫描
 *   侧永远不会扫描的目录；
 * - 用户排除目录（excludeDirs）与 scanner 同规则，仅按目录名匹配；
 * - 检测到变更后经防抖向渲染进程推送 models:fsChanged（渲染进程据此自动重扫），
 *   防抖静默期内多次变更只触发一次广播；
 * - 快照原语（collectDirSnapshot / snapshotsEqual）同时是后续
 *   「按变更子树局部重扫」的能力基础。
 *
 * OPT-02 扫描/监控基线协同：
 * - 扫描遍历顺带产出 dirSnapshot（目录绝对路径 → 条目名），全量扫描完成后
 *   直接作为监控基线，不再扫描结束后再做一次全树 readdir；局部扫描只回填
 *   受影响子树；
 * - 扫描期间（setWatcherScanning）暂停巡检与广播，变更目录先累积；扫描成功
 *   后基线已被扫描结果覆盖，停扫时只补发未被覆盖的子树，避免「扫描已包含的
 *   变更」再次触发局部扫描；
 * - 原生事件广播后对相关子树做一次名称/内容快照回填，使下一轮轮询不再因
 *   旧基线重复检出同一变更（消除重复 models:fsChanged 与重复局部扫描）。
 *
 * O12 模块布局（本文件 = 门面：生命周期入口 + 公共 API 再导出）：
 * - watcher-state.js      单例状态/时序常量/停止清理（最底层依赖，无环）
 * - watcher-snapshot.js   快照采集与差异计算（纯函数）
 * - watcher-baseline.js   扫描基线应用（sanitize/全量/局部替换）
 * - watcher-broadcast.js  防抖广播与投递队列（含原生事件回填）
 * - watcher-native.js     原生 fs.watch 监听（加速触发，失败回落轮询）
 * - watcher-poll.js       轮询巡检引擎（退避爬梯/可见性感知）
 * 既有消费方的导入路径与公共 API 名称保持不变。
 */

/** @typedef {import('./watcher-state').WatcherState} WatcherState */

/**
 * 是否存在可见（未隐藏且未最小化）的主窗口；无窗口/无法判定时按可见处理。
 * O6 修复：Electron 最小化窗口 isVisible() 仍返回 true，仅判 isVisible 会使
 * 「窗口最小化：跳过目录遍历，移动硬盘不被唤醒」（A-07b 目标）落空——
 * 最小化挂后台时全树 readdir 照常执行。isMinimized 与 isVisible 双判。
 */
function windowsVisible() {
  return BrowserWindow.getAllWindows().some(
    (win) =>
      !win.isDestroyed() &&
      (typeof win.isVisible !== 'function' || win.isVisible()) &&
      (typeof win.isMinimized !== 'function' || !win.isMinimized()),
  )
}

/**
 * 扫描期开关（OPT-02）：扫描期间暂停巡检与广播，变更目录先累积；
 * 扫描成功后由 syncWatcher（全量）或 refreshWatcherBaseline（局部）覆盖基线并
 * 清理已覆盖项；停扫时只补发未被扫描覆盖的子树。
 * @param {boolean} scanning 是否进入扫描期
 */
export function setWatcherScanning(scanning) {
  const w = getWatcher()
  if (!w) return
  const next = scanning === true
  if (w.scanning === next) return
  w.scanning = next
  if (next) {
    // 已安排的广播先按住：扫描结果可能已包含这些变更，停扫时再按基线过滤
    if (w.debounceTimer) {
      clearTimeout(w.debounceTimer)
      w.debounceTimer = null
    }
    // 已进入交付队列但尚未广播的批次同样作废（在途批次会检查 scanning 后跳过）
    w.deliverQueue.length = 0
    return
  }
  if (w.pendingDirs.size > 0 || w.pendingConfirmedDirs.size > 0) {
    scheduleBroadcastTimer(w)
  }
}

/**
 * 局部扫描完成后回填监控基线（OPT-02）：
 * 只替换受影响子树的目录名快照，范围外基线保持原样；同时清理已被扫描
 * 覆盖的待广播目录，避免扫描结果再次触发局部扫描。
 * @param {string} root 扫描的模型根目录
 * @param {string[]} dirs 本次局部扫描的子树（POSIX 相对路径，'' 为根直属）
 * @param {Map<string, string[]>} snapshot scanner 返回的目录名快照
 * @returns {boolean} 是否成功应用到当前监控状态
 */
export function refreshWatcherBaseline(root, dirs, snapshot) {
  const w = getWatcher()
  if (!w || !w.enabled || !samePathIgnoreCase(w.root, root)) return false
  // 空快照合法：本次扫描的子树已被删除，需要移除对应旧基线条目
  if (!(snapshot instanceof Map)) return false
  return applyPartialBaseline(w, dirs, snapshot)
}

/**
 * 同步目录监控状态（扫描成功后与设置变更时调用）。
 * @param {string} root 当前模型根目录
 * @param {boolean} enabled 是否启用自动重扫（settings.autoRescan）
 * @param {string[]} [excludeDirs] 排除目录名（与 scanner 同规则，遍历时剔除，
 *   避免被排除目录内的文件变化触发无意义重扫）
 * @param {{pollInterval?: number, broadcastDebounce?: number,
 *   contentCheckInterval?: number, traversalConcurrency?: number,
 *   fullWalkInterval?: number,
 *   nativeWatch?: boolean, baseline?: Map<string, string[]>,
 *   backoff?: number[], isVisible?: () => boolean,
 *   onPollScheduled?: (delay: number) => void}} [timing]
 *   轮询间隔/广播防抖/内容校验间隔（毫秒）与目录遍历并发；fullWalkInterval 为
 *   活跃期全量回扫周期（PERF-4，默认 5）；nativeWatch 开启
 *   原生事件监听；baseline 为全量扫描产出的目录名快照（OPT-02：直接作为
 *   监控基线，跳过扫描后的重复全树遍历）；backoff 空闲退避阶梯；
 *   isVisible/onPollScheduled 为测试注入钩子；生产走默认值，测试注入小值
 *   （contentCheckInterval≤0 关闭内容校验）
 */
export function syncWatcher(root, enabled, excludeDirs = [], timing = {}) {
  const wantEnabled = enabled === true
  const current = getWatcher()
  if (
    current &&
    samePathIgnoreCase(current.root, root) &&
    current.enabled === wantEnabled
  ) {
    // 同根同状态（如每次扫描完成后的重复同步）：刷新排除名单；若本次扫描
    // 提供了目录快照，直接覆盖基线并清理已扫描的待广播项（OPT-02），
    // 不重启遍历（skipNames 每轮遍历时读取，热生效）
    current.excludeNames = toNameSet(excludeDirs)
    if (timing.baseline instanceof Map && timing.baseline.size > 0) {
      applyFullBaseline(current, timing.baseline)
    }
    // OP-05：原生监听曾因异常退出（或首次不可用）时，借同步时机尝试重建
    if (current.nativeWatch && !current.nativeWatcher) {
      startNativeWatch(current)
    }
    return
  }
  stop()
  if (!root || !wantEnabled) return

  // OP-05：原生事件监听默认关闭（由调用方显式开启）；开启时轮询降频为兜底
  const nativeWatch = timing.nativeWatch === true
  const pollMs =
    timing.pollInterval ??
    (nativeWatch ? NATIVE_WATCH_POLL_INTERVAL : DEFAULT_POLL_INTERVAL)
  const w = /** @type {WatcherState} */ ({
    root,
    enabled: true,
    excludeNames: toNameSet(excludeDirs),
    snapshot: new Map(),
    // O4：内容快照（withStats=true）与最近一次内容校验时刻；null 表示需重建基线
    statSnapshot: null,
    lastContentCheckAt: 0,
    contentCheckInterval:
      timing.contentCheckInterval ?? DEFAULT_CONTENT_CHECK_INTERVAL,
    traversalConcurrency: normalizeConcurrency(
      timing.traversalConcurrency ?? DEFAULT_TRAVERSAL_CONCURRENCY,
    ),
    debounceTimer: null,
    timer: null,
    polling: false,
    refreshing: false,
    scanning: false,
    pendingNeedsRefresh: false,
    delivering: false,
    deliverQueue: [],
    snapshotRevision: 0,
    idleRounds: 0,
    // PERF-4：热点巡检状态（活跃期只巡变更子树 + 根直属条目，每 N 轮全树兜底）
    lastHotDirs: [],
    walkCount: 0,
    fullWalkInterval: timing.fullWalkInterval ?? DEFAULT_FULL_WALK_INTERVAL,
    pendingDirs: new Set(),
    pendingConfirmedDirs: new Set(),
    pollInterval: pollMs,
    // OP-05 原生监听状态（未开启/启动失败为 null）
    nativeWatch,
    nativeWatcher: null,
    // 退避阶梯：测试 timing 未传 backoff 时为 undefined（恒定间隔，旧行为）；
    // 原生监听开启时以 15s 起步、30s 封顶；否则默认 2s→5s→10s→30s
    backoff:
      timing.backoff ??
      (timing.pollInterval
        ? undefined
        : nativeWatch
          ? [NATIVE_WATCH_POLL_INTERVAL, 30000]
          : DEFAULT_BACKOFF),
    debounceMs: timing.broadcastDebounce ?? DEFAULT_BROADCAST_DEBOUNCE,
    isVisible:
      typeof timing.isVisible === 'function'
        ? timing.isVisible
        : windowsVisible,
    onPollScheduled:
      typeof timing.onPollScheduled === 'function'
        ? timing.onPollScheduled
        : null,
  })
  setWatcher(w)
  // OPT-02：本次扫描已产出目录快照时直接复用为监控基线，无需扫描结束后
  // 再做一次全树 readdir；内容基线留待下个内容校验周期静默重建。
  const reusedBaseline =
    timing.baseline instanceof Map && timing.baseline.size > 0
      ? applyFullBaseline(w, timing.baseline)
      : false
  if (nativeWatch && !startNativeWatch(w)) {
    // 原生监听不可用：退回原轮询节奏（避免 15s 起步导致变更发现过慢）
    w.pollInterval = DEFAULT_POLL_INTERVAL
    w.backoff = NATIVE_WATCH_FALLBACK_BACKOFF
  }
  logger.info(
    `目录监控已启动（autoRescan，基础轮询 ${w.pollInterval}ms` +
      (w.nativeWatcher ? '，原生事件监听已启用' : '') +
      (reusedBaseline ? '，复用扫描目录快照' : '') +
      (w.backoff ? `，空闲退避至 ${w.backoff[w.backoff.length - 1]}ms` : '') +
      (w.contentCheckInterval > 0
        ? `，内容校验 ${w.contentCheckInterval}ms`
        : '，内容校验已关闭') +
      `）: ${root}`,
  )
  if (reusedBaseline) {
    // 已有权威名称基线：直接进入轮询链，不再立即遍历全树
    scheduleNextWalk(w)
  } else {
    // 无扫描基线时保留原行为：立即建立基准快照（不等首个间隔；只记录不比对），
    // 启用前已存在的文件、以及随后才出现的 .modelvault 都不产生首次误报。
    runWalk(w, true)
  }
}

// 公共 API 再导出：快照原语供扫描侧（scan.js 的 dirSnapshot 语义）与测试复用；
// stopWatcher 供应用退出链路（quit.js）。名称与拆分前完全一致。
export {
  collectDirSnapshot,
  computeSnapshotDiff,
  computeStatSnapshotDiff,
  snapshotsEqual,
} from './watcher-snapshot'
export { stopWatcher } from './watcher-state'
