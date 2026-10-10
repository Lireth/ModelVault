import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import logger from '../logger'

/**
 * 模型目录变更监控（E8；A8 由 fs.watch recursive 重写为「轮询 + 快照比对」）：
 *
 * 原实现的问题：Node 的 fs.watch recursive 在 Windows 后端到端不可靠
 * （漏事件、filename 偶发为 null 导致 .modelvault 过滤被绕过、
 * 缓冲区溢出丢细节），autoRescan 在目标平台时灵时不灵。
 *
 * 现实现：按固定间隔递归遍历目录树并比对快照（目录 -> 条目名列表）——
 * - 条目增减/重命名可靠反映在快照差异上，不受平台事件语义影响；
 * - 关联存储目录（.modelvault）与用户排除目录（excludeDirs）被整条剔除出
 *   快照（既不记录也不递归），从机制上根除「监听自身写入」的自激励问题；
 * - 检测到变更后经防抖向渲染进程推送 models:fsChanged（渲染进程据此自动重扫），
 *   防抖静默期内多次变更只触发一次广播；
 * - 快照原语（collectDirSnapshot / snapshotsEqual）同时是后续
 *   「按变更子树局部重扫」的能力基础。
 */

/** 关联存储目录名：遍历时整条剔除（其存在与否/内部写入都不代表模型库变更） */
const DATA_DIR_NAME = '.modelvault'
/** 基础轮询间隔（ms）：目录最近有变更时以此间隔巡检 */
const DEFAULT_POLL_INTERVAL = 2000
/**
 * 空闲退避阶梯（ms，A-07b）：连续巡检无变更时逐级拉长间隔，
 * 避免空闲库（尤其移动硬盘/网络盘）被高频全树 readdir 持续唤醒；
 * 一旦检测到变更立即回到基础间隔。
 */
const DEFAULT_BACKOFF = [2000, 5000, 10000]
/** 广播防抖（ms）：批量解压/移动文件时只触发一次重扫 */
const DEFAULT_BROADCAST_DEBOUNCE = 3000

/** 当前监控状态（root/excludeNames/snapshot/定时器链） */
let watcher = null

/** 停止遍历与防抖定时器，清理监控状态 */
function stop() {
  if (!watcher) return
  const w = watcher
  watcher = null
  if (w.debounceTimer) clearTimeout(w.debounceTimer)
  if (w.timer) clearInterval(w.timer)
}

/** 向所有窗口广播目录变更 */
function broadcast(root, dirs = []) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('models:fsChanged', { root, dirs })
    }
  }
}

/** 目录名小写集合（与 scanner 的 excludeDirs 同规则：按目录名小写匹配） */
function toNameSet(names) {
  return new Set(
    (names || []).filter((n) => typeof n === 'string' && n).map((n) => n.toLowerCase())
  )
}

/**
 * 递归收集目录快照：目录绝对路径 -> 排序后的条目名列表。
 * skipNames 中的目录名（含关联存储 .modelvault）被整条剔除——既不进快照
 * 也不递归，其出现/消失/内部变化都不构成模型库变更。子目录读取失败
 * （遍历中被删除/锁定）时跳过该子树——其变化会反映在父层条目名差异上；
 * 根目录不可读时抛出，由调用方决定（监控场景下降级为停止监控）。
 * @param {string} root 遍历根目录
 * @param {Set<string>} [skipNames] 需剔除的目录名小写集合
 * @returns {Promise<Map<string, string[]>>} 目录快照
 */
export async function collectDirSnapshot(root, skipNames = new Set()) {
  const snapshot = new Map()
  const skip = new Set(skipNames)
  skip.add(DATA_DIR_NAME)
  const walk = async (dir, isRoot) => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (isRoot) throw err
      return
    }
    const visible = entries.filter((e) => !skip.has(e.name.toLowerCase()))
    snapshot.set(dir, visible.map((e) => e.name).sort())
    await Promise.all(
      visible.filter((e) => e.isDirectory()).map((e) => walk(path.join(dir, e.name), false))
    )
  }
  await walk(root, true)
  return snapshot
}

/**
 * 比较两份目录快照是否一致：键集合相同且各目录的条目名列表逐项相等。
 * @param {Map<string, string[]>} a 快照 A
 * @param {Map<string, string[]>} b 快照 B
 * @returns {boolean} 一致返回 true
 */
export function snapshotsEqual(a, b) {
  if (a.size !== b.size) return false
  for (const [dir, names] of a) {
    const other = b.get(dir)
    if (!other || other.length !== names.length) return false
    for (let i = 0; i < names.length; i++) {
      if (names[i] !== other[i]) return false
    }
  }
  return true
}

/**
 * 计算两次快照间发生条目录变化的目录集合（A-03 增量扫描依据）：
 * 新增/消失/条目列表不同的目录都计入，返回相对根的 POSIX 路径数组
 * （根目录为 ''），排序去重。局部重扫只需覆盖这些子树即可与全量结果一致。
 * @param {string} root 监控根目录（绝对路径）
 * @param {Map<string, string[]>} oldSnap 旧快照
 * @param {Map<string, string[]>} newSnap 新快照
 * @returns {string[]} 变更目录的相对路径（POSIX 分隔，根目录为 ''）
 */
export function computeSnapshotDiff(root, oldSnap, newSnap) {
  const dirs = new Set()
  const consider = (dirAbs, oldNames, newNames) => {
    const a = oldNames || []
    const b = newNames || []
    if (a.length === b.length && a.every((n, i) => n === b[i])) return
    const rel = path.relative(root, dirAbs)
    const normalized = rel === '' ? '' : rel.split(path.sep).join('/')
    // 理论上快照键都在根内；防御性忽略越界项
    if (normalized && (normalized.startsWith('..') || path.isAbsolute(normalized))) return
    dirs.add(normalized)
  }
  for (const [dir, names] of oldSnap) consider(dir, names, newSnap.get(dir))
  for (const [dir, names] of newSnap) consider(dir, oldSnap.get(dir), names)
  return [...dirs].sort()
}

/**
 * 防抖广播：静默期内多轮变更只广播一次，变更目录取并集（A-03）。
 * diff 目录在每轮发现变更时合入 w.pendingDirs，广播载荷携带 { root, dirs }，
 * 渲染层据此只重扫这些子树。
 */
function scheduleBroadcast(w, changedDirs = []) {
  if (!Array.isArray(w.pendingDirs)) w.pendingDirs = new Set()
  for (const d of changedDirs) w.pendingDirs.add(d)
  if (w.debounceTimer) clearTimeout(w.debounceTimer)
  w.debounceTimer = setTimeout(() => {
    w.debounceTimer = null
    const dirs = [...w.pendingDirs].sort()
    w.pendingDirs.clear()
    logger.info(`检测到模型目录变更，触发重扫: ${w.root}（${dirs.length} 个子树）`)
    broadcast(w.root, dirs)
  }, w.debounceMs)
}

/** 是否存在可见（未最小化）的主窗口；无窗口/无法判定时按可见处理 */
function windowsVisible() {
  return BrowserWindow.getAllWindows().some(
    (win) => !win.isDestroyed() && (typeof win.isVisible !== 'function' || win.isVisible())
  )
}

/**
 * 计算下一轮巡检延迟（A-07b 空闲退避）：
 * idleRounds 为连续无变更轮数；无 backoff 配置（旧 timing）时恒定基础间隔。
 */
function nextDelay(w) {
  const ladder = w.backoff
  if (!Array.isArray(ladder) || ladder.length === 0) return w.pollInterval
  return ladder[Math.min(w.idleRounds, ladder.length - 1)]
}

/** 安排下一轮巡检并对外通告实际延迟（测试钩子 onPollScheduled） */
function scheduleNextWalk(w) {
  if (w !== watcher || !watcher) return // 遍历期间监控可能已被停止/替换
  const delay = nextDelay(w)
  w.timer = setTimeout(() => runWalk(w, false), delay)
  w.timer.unref?.()
  if (typeof w.onPollScheduled === 'function') w.onPollScheduled(delay)
}

function runWalk(w, silent) {
  // 上一次遍历未完成（超大目录树）时本轮跳过读盘，仅安排下一轮，避免并发遍历
  if (w.polling) {
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

      const snapshot = await collectDirSnapshot(w.root, w.excludeNames)
      if (silent) {
        w.snapshot = snapshot
        return
      }
      const changedDirs = computeSnapshotDiff(w.root, w.snapshot, snapshot)
      if (changedDirs.length === 0) {
        w.idleRounds += 1
        return
      }
      w.snapshot = snapshot
      w.idleRounds = 0 // 有变更：退避重置，下一轮回到基础间隔
      scheduleBroadcast(w, changedDirs)
    })
    .catch((err) => {
      // 根目录不可读（被删除/离线）：停止监控，等下次扫描/设置变更重新发起
      logger.warn(`目录监控异常，已停止: ${err.message}`)
      stopWatcher()
    })
    .finally(() => {
      w.polling = false
      // 基准轮与正常轮都由统一的递归 setTimeout 链安排下一轮；
      // 基准轮 idleRounds=0，首次延迟即基础间隔（stopWatcher 已清 timer 时不再排）
      scheduleNextWalk(w)
    })
}

/**
 * 同步目录监控状态（扫描成功后与设置变更时调用）。
 * @param {string} root 当前模型根目录
 * @param {boolean} enabled 是否启用自动重扫（settings.autoRescan）
 * @param {string[]} [excludeDirs] 排除目录名（与 scanner 同规则，遍历时剔除，
 *   避免被排除目录内的文件变化触发无意义重扫）
 * @param {{pollInterval?: number, broadcastDebounce?: number}} [timing]
 *   轮询间隔/广播防抖（毫秒；生产走默认值，测试注入小值）
 */
export function syncWatcher(root, enabled, excludeDirs = [], timing = {}) {
  const wantEnabled = enabled === true
  if (watcher && watcher.root === root && watcher.enabled === wantEnabled) {
    // 同根同状态（如每次扫描完成后的重复同步）：仅刷新排除名单即返回，
    // 不重启遍历（skipNames 每轮遍历时读取，热生效）
    watcher.excludeNames = toNameSet(excludeDirs)
    return
  }
  stop()
  if (!root || !wantEnabled) return

  const pollMs = timing.pollInterval ?? DEFAULT_POLL_INTERVAL
  const w = {
    root,
    enabled: true,
    excludeNames: toNameSet(excludeDirs),
    snapshot: new Map(),
    debounceTimer: null,
    timer: null,
    polling: false,
    idleRounds: 0,
    pendingDirs: new Set(),
    pollInterval: pollMs,
    // 退避阶梯：测试 timing 未传 backoff 时为 undefined（恒定间隔，旧行为）；
    // 生产默认 2s→5s→10s（A-07b）
    backoff: timing.backoff ?? (timing.pollInterval ? undefined : DEFAULT_BACKOFF),
    debounceMs: timing.broadcastDebounce ?? DEFAULT_BROADCAST_DEBOUNCE,
    isVisible: typeof timing.isVisible === 'function' ? timing.isVisible : windowsVisible,
    onPollScheduled: typeof timing.onPollScheduled === 'function' ? timing.onPollScheduled : null
  }
  watcher = w
  logger.info(
    `目录监控已启动（autoRescan，基础轮询 ${pollMs}ms` +
      (w.backoff ? `，空闲退避至 ${w.backoff[w.backoff.length - 1]}ms` : '') +
      `）: ${root}`
  )
  // 立即建立基准快照（不等首个间隔；只记录不比对）：
  // 启用前已存在的文件、以及随后才出现的 .modelvault 都不产生首次误报。
  // 基准轮结束后由递归 setTimeout 链安排后续巡检
  runWalk(w, true)
}

/** 停止目录监控（应用退出时调用） */
export function stopWatcher() {
  stop()
  logger.info('目录监控已停止')
}
