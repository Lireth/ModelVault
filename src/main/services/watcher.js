import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import logger from '../logger'
import { runWithConcurrency } from '../utils'

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
 * 空闲退避阶梯（ms，A-07b；O8 延长封顶）：连续巡检无变更时逐级拉长间隔，
 * 避免空闲库（尤其移动硬盘/网络盘）被高频全树 readdir 持续唤醒；
 * 一旦检测到变更立即回到基础间隔。封顶 30s：可见挂机（应用开着、库空闲）
 * 的巡检频率较 10s 封顶降 67%；外部改动的发现延迟最坏 30s+防抖，
 * 而「操作完切回应用」场景由隐藏期探测的快速比对覆盖（见 nextDelay）。
 */
const DEFAULT_BACKOFF = [2000, 5000, 10000, 30000]
/** 广播防抖（ms）：批量解压/移动文件时只触发一次重扫 */
const DEFAULT_BROADCAST_DEBOUNCE = 3000
/**
 * 内容校验间隔（ms，O4）：名称快照只能发现条目增删/重命名，同名覆盖写入
 * （下载器原地替换、工具覆写）不会改变条目名。以低频全树 stat 对比
 * size/mtime 检出这类变更——默认 60s，避免每轮轮询都对所有文件 stat。
 */
const DEFAULT_CONTENT_CHECK_INTERVAL = 60000
/** 目录遍历的并发上限（O4）：避免无界 Promise.all 在大库上耗尽句柄 */
const DEFAULT_TRAVERSAL_CONCURRENCY = 8
/** 内容快照中单目录内文件 stat 的并发上限（与目录池相乘仍有界） */
const STAT_CONCURRENCY = 8

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
 * 快照条目（内容快照使用；目录/符号链接条目只有 name/isDir）：
 * @typedef {object} SnapshotEntry
 * @property {string} name 条目名
 * @property {boolean} [isDir] 是否为目录
 * @property {number|null} [size] 文件字节数（stat 失败为 null）
 * @property {number|null} [mtimeMs] 文件修改时间（stat 失败为 null）
 */

/** 把并发配置收口到 [1, 64] 的安全区间 */
function normalizeConcurrency(value) {
  if (!Number.isFinite(value)) return DEFAULT_TRAVERSAL_CONCURRENCY
  return Math.min(64, Math.max(1, Math.floor(value)))
}

/**
 * 按名称排序的快照条目比较器（名称唯一，不会相等）。
 * @param {SnapshotEntry} a
 * @param {SnapshotEntry} b
 * @returns {number}
 */
function compareEntryName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * 递归收集目录快照（O4：有界并发遍历）。
 * 默认返回「目录绝对路径 -> 排序后的条目名列表」；withStats=true 时返回
 * 「目录绝对路径 -> 排序后的 SnapshotEntry[]（含 size/mtimeMs）」，用于
 * 低频内容校验（同名覆盖写入无法从条目名差异中检出）。
 *
 * skipNames 中的目录名（含关联存储 .modelvault）被整条剔除——既不进快照
 * 也不递归，其出现/消失/内部变化都不构成模型库变更。子目录读取失败
 * （遍历中被删除/锁定）时跳过该子树——其变化会反映在父层条目名差异上；
 * 根目录不可读时抛出，由调用方决定（监控场景下降级为停止监控）。
 *
 * @param {string} root 遍历根目录
 * @param {Set<string>} [skipNames] 需剔除的目录名小写集合
 * @param {{withStats?: boolean, concurrency?: number}} [options]
 *   withStats: 是否采集文件 size/mtime（内容变更检测）；concurrency: 目录并发上限
 * @returns {Promise<Map<string, string[]|SnapshotEntry[]>>} 目录快照
 */
export async function collectDirSnapshot(root, skipNames = new Set(), options = {}) {
  const snapshot = new Map()
  const skip = new Set(skipNames)
  skip.add(DATA_DIR_NAME)
  const withStats = options.withStats === true
  const concurrency = normalizeConcurrency(options.concurrency)

  /** 动态目录队列 + 固定 worker 数：不一次性为整棵树创建 Promise */
  const queue = [{ dir: root, isRoot: true }]
  let active = 0
  let settled = false

  await new Promise((resolve, reject) => {
    const finish = (err) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve()
    }

    /** 处理单个目录：读取条目、写入快照、把子目录追加到队列 */
    const readOne = async ({ dir, isRoot }) => {
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (err) {
        if (isRoot) throw err
        return
      }
      const visible = entries.filter((e) => !skip.has(e.name.toLowerCase()))
      if (!withStats) {
        snapshot.set(dir, visible.map((e) => e.name).sort())
        for (const entry of visible) {
          if (entry.isDirectory()) queue.push({ dir: path.join(dir, entry.name), isRoot: false })
        }
        return
      }

      // 内容快照：目录条目只记名称/类型；文件逐项 stat 并记录 size/mtime。
      // 单目录内 stat 也有界，避免「大目录 × 目录池」放大句柄占用。
      const list = []
      const files = []
      for (const entry of visible) {
        if (entry.isDirectory()) {
          list.push({ name: entry.name, isDir: true })
        } else if (entry.isSymbolicLink()) {
          // 符号链接不跟随 stat（可能指向库外/网络目标），只记录条目名
          list.push({ name: entry.name, isDir: false })
        } else {
          files.push(entry)
        }
      }
      const stats = new Array(files.length)
      await runWithConcurrency(
        files,
        async (entry, index) => {
          try {
            const stat = await fs.stat(path.join(dir, entry.name))
            stats[index] = { name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs }
          } catch {
            // 遍历期间被删除/锁定：记空值，下一轮内容校验会恢复或再次发现
            stats[index] = { name: entry.name, size: null, mtimeMs: null }
          }
        },
        STAT_CONCURRENCY
      )
      list.push(...stats)
      snapshot.set(dir, list.sort(compareEntryName))
      for (const entry of visible) {
        if (entry.isDirectory()) queue.push({ dir: path.join(dir, entry.name), isRoot: false })
      }
    }

    const pump = () => {
      if (settled) return
      if (queue.length === 0 && active === 0) {
        finish()
        return
      }
      while (active < concurrency && queue.length > 0 && !settled) {
        const job = queue.shift()
        active += 1
        readOne(job)
          .catch((err) => {
            // 子目录读取失败已在 readOne 内部吞掉；仅根目录失败终止整次遍历
            if (job.isRoot) finish(err)
          })
          .finally(() => {
            active -= 1
            pump()
          })
      }
    }
    pump()
  })
  return snapshot
}

/** 内容快照 → 名称快照（两套快照共用结构差异判定） */
function namesFromSnapshot(statSnapshot) {
  const names = new Map()
  for (const [dir, entries] of statSnapshot) {
    names.set(dir, entries.map((entry) => entry.name))
  }
  return names
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

/** 内容快照条目是否完全一致（名称/类型/size/mtime 任一不同即视为变更） */
function statEntriesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const left = a[i]
    const right = b[i]
    if (
      left.name !== right.name ||
      Boolean(left.isDir) !== Boolean(right.isDir) ||
      left.size !== right.size ||
      left.mtimeMs !== right.mtimeMs
    ) {
      return false
    }
  }
  return true
}

/**
 * 计算两份内容快照（withStats=true）间发生变化的目录集合（O4）：
 * 除条目增删/重命名外，同名文件的 size/mtime 变化也会命中——这是名称快照
 * 无法发现的内容覆盖写入。返回相对根的 POSIX 路径数组（根目录为 ''）。
 * @param {string} root 监控根目录（绝对路径）
 * @param {Map<string, SnapshotEntry[]>} oldSnap 旧内容快照
 * @param {Map<string, SnapshotEntry[]>} newSnap 新内容快照
 * @returns {string[]} 变更目录的相对路径（POSIX 分隔，根目录为 ''）
 */
export function computeStatSnapshotDiff(root, oldSnap, newSnap) {
  const dirs = new Set()
  const consider = (dirAbs, oldEntries, newEntries) => {
    if (statEntriesEqual(oldEntries, newEntries)) return
    const rel = path.relative(root, dirAbs)
    const normalized = rel === '' ? '' : rel.split(path.sep).join('/')
    if (normalized && (normalized.startsWith('..') || path.isAbsolute(normalized))) return
    dirs.add(normalized)
  }
  for (const [dir, entries] of oldSnap) consider(dir, entries, newSnap.get(dir))
  for (const [dir, entries] of newSnap) consider(dir, entries, oldSnap.get(dir))
  return [...dirs].sort()
}

/**
 * 防抖广播：静默期内多轮变更只广播一次，变更目录取并集（A-03）。
 * 代际校验（B2 修复）：w 已不是当前 watcher（stop/syncWatcher 切换到新根）
 * 时，旧根在途遍历检出的变更必须直接丢弃——否则它会设置一个无人清理的
 * 防抖定时器，稍后向渲染进程广播旧根的 models:fsChanged，可能触发
 * partialScan(旧根) 把用户刚切换的库静默切回旧根。
 * diff 目录在每轮发现变更时合入 w.pendingDirs，广播载荷携带 { root, dirs }，
 * 渲染层据此只重扫这些子树。
 */
function scheduleBroadcast(w, changedDirs = []) {
  if (w !== watcher) return
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
      (typeof win.isMinimized !== 'function' || !win.isMinimized())
  )
}

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

      // O4：内容校验轮采集 size/mtime；其余轮次只做低成本名称比对。
      // 基准轮（silent）必须建立内容基线，否则首个间隔内的同名覆盖无法发现。
      const contentEnabled = Number.isFinite(w.contentCheckInterval) && w.contentCheckInterval > 0
      const wantStats =
        contentEnabled &&
        (silent || Date.now() - w.lastContentCheckAt >= w.contentCheckInterval)
      const snapshot = await collectDirSnapshot(w.root, w.excludeNames, {
        withStats: wantStats,
        concurrency: w.traversalConcurrency
      })

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
        return
      }

      if (wantStats) {
        w.lastContentCheckAt = Date.now()
        const names = namesFromSnapshot(snapshot)
        // 名称变化轮已触发重扫时内容基线会被置空：本轮只重建基线，不重复广播
        const changedDirs = w.statSnapshot
          ? computeStatSnapshotDiff(w.root, w.statSnapshot, snapshot)
          : []
        w.statSnapshot = snapshot
        w.snapshot = names
        if (changedDirs.length === 0) {
          w.idleRounds += 1
          return
        }
        w.idleRounds = 0
        scheduleBroadcast(w, changedDirs)
        return
      }

      const changedDirs = computeSnapshotDiff(w.root, w.snapshot, snapshot)
      if (changedDirs.length === 0) {
        w.idleRounds += 1
        return
      }
      w.snapshot = snapshot
      // 名称变化已触发重扫（扫描会读到当前内容）；内容基线失效，下个内容
      // 校验轮静默重建，避免对同一批变更重复广播
      w.statSnapshot = null
      w.idleRounds = 0 // 有变更：退避重置，下一轮回到基础间隔
      scheduleBroadcast(w, changedDirs)
    })
    .catch((err) => {
      // 根目录不可读（被删除/离线）：停止监控，等下次扫描/设置变更重新发起。
      // 代际校验（B2 修复）：异常来自旧根的在途遍历时，当前 watcher 已是新根，
      // 绝不能被误停——只丢弃该次遍历
      logger.warn(`目录监控异常${w === watcher ? '，已停止' : '（旧根遍历已丢弃）'}: ${err.message}`)
      if (w === watcher) stopWatcher()
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
 * @param {{pollInterval?: number, broadcastDebounce?: number,
 *   contentCheckInterval?: number, traversalConcurrency?: number}} [timing]
 *   轮询间隔/广播防抖/内容校验间隔（毫秒）与目录遍历并发；
 *   生产走默认值，测试注入小值（contentCheckInterval≤0 关闭内容校验）
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
    // O4：内容快照（withStats=true）与最近一次内容校验时刻；null 表示需重建基线
    statSnapshot: null,
    lastContentCheckAt: 0,
    contentCheckInterval:
      timing.contentCheckInterval ?? DEFAULT_CONTENT_CHECK_INTERVAL,
    traversalConcurrency: normalizeConcurrency(
      timing.traversalConcurrency ?? DEFAULT_TRAVERSAL_CONCURRENCY
    ),
    debounceTimer: null,
    timer: null,
    polling: false,
    idleRounds: 0,
    pendingDirs: new Set(),
    pollInterval: pollMs,
    // 退避阶梯：测试 timing 未传 backoff 时为 undefined（恒定间隔，旧行为）；
    // 生产默认 2s→5s→10s→30s（A-07b；O8 延长封顶，见 DEFAULT_BACKOFF 注释）
    backoff: timing.backoff ?? (timing.pollInterval ? undefined : DEFAULT_BACKOFF),
    debounceMs: timing.broadcastDebounce ?? DEFAULT_BROADCAST_DEBOUNCE,
    isVisible: typeof timing.isVisible === 'function' ? timing.isVisible : windowsVisible,
    onPollScheduled: typeof timing.onPollScheduled === 'function' ? timing.onPollScheduled : null
  }
  watcher = w
  logger.info(
    `目录监控已启动（autoRescan，基础轮询 ${pollMs}ms` +
      (w.backoff ? `，空闲退避至 ${w.backoff[w.backoff.length - 1]}ms` : '') +
      (w.contentCheckInterval > 0
        ? `，内容校验 ${w.contentCheckInterval}ms`
        : '，内容校验已关闭') +
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
