import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import logger from '../logger'
import { relativeWithin, runWithConcurrency } from '../utils'
import { dedupeAndPruneDescendants, isRelDirInScope } from '../../shared/scan-dirs'
import { MAX_SCAN_DEPTH, isExcludedScanName, isExcludedScanEntryName, isVisibleScanEntry } from './scanner'

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
 */

/** 基础轮询间隔（ms）：目录最近有变更时以此间隔巡检 */
const DEFAULT_POLL_INTERVAL = 2000
/**
 * 原生事件监听可用时的基础轮询间隔（OP-05）：事件负责低延迟触发，
 * 轮询只承担漏事件兜底，因此从 2s 放宽到 15s，空闲退避仍封顶 30s。
 */
const NATIVE_WATCH_POLL_INTERVAL = 15000
/** 原生监听失败后的兜底退回间隔（保持原行为） */
const NATIVE_WATCH_FALLBACK_BACKOFF = [2000, 5000, 10000, 30000]
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

/**
 * 监控状态对象（syncWatcher 构造；stop/startNativeWatch/scheduleBroadcast
 * 与轮询链路共享引用）
 * @typedef {object} WatcherState
 * @property {string} root 监控根目录（绝对路径）
 * @property {boolean} enabled 是否启用自动重扫
 * @property {Set<string>} excludeNames 用户排除目录名小写集合
 * @property {Map<string, string[]>} snapshot 名称快照（目录绝对路径 -> 条目名列表）
 * @property {Map<string, SnapshotEntry[]>|null} statSnapshot 内容快照（null 表示需重建基线）
 * @property {number} lastContentCheckAt 最近一次内容校验时刻（Date.now()）
 * @property {number} contentCheckInterval 内容校验间隔（ms，≤0 关闭）
 * @property {number} traversalConcurrency 目录遍历并发上限
 * @property {ReturnType<typeof setTimeout>|null} debounceTimer 广播防抖定时器
 * @property {ReturnType<typeof setTimeout>|null} timer 巡检定时器
 * @property {boolean} polling 当前是否有在途遍历
 * @property {boolean} refreshing 是否正在回填原生事件后的子树快照
 * @property {boolean} scanning 是否处于扫描期（暂停巡检与广播，变更先累积）
 * @property {boolean} pendingNeedsRefresh 待广播变更是否来自原生事件（需回填基线）
 * @property {boolean} delivering 是否正在交付防抖广播（串行化原生事件回填）
 * @property {Array<object>} deliverQueue 待交付广播队列（扫描期清空）
 * @property {number} snapshotRevision 快照基线代际（并发遍历丢弃依据）
 * @property {number} idleRounds 连续空闲轮数（退避爬梯）
 * @property {Set<string>} pendingDirs 防抖静默期内累积的变更子树（原生事件候选）
 * @property {Set<string>} pendingConfirmedDirs 轮询已确认的变更子树（基线已更新）
 * @property {number} pollInterval 基础轮询间隔（ms）
 * @property {boolean} nativeWatch 是否启用原生事件监听
 * @property {import('node:fs').FSWatcher|null} nativeWatcher 原生监听实例（未开启/失败为 null）
 * @property {number[]=} backoff 空闲退避阶梯（未配置为恒定间隔）
 * @property {number} debounceMs 广播防抖时长（ms）
 * @property {() => boolean} isVisible 窗口可见性探测（测试可注入）
 * @property {((delay: number) => void)|null} onPollScheduled 轮询安排通告（测试钩子）
 */

/** 当前监控状态（root/excludeNames/snapshot/定时器链） */
let watcher = null

/** 停止遍历与防抖定时器，清理监控状态 */
function stop() {
  if (!watcher) return
  const w = watcher
  watcher = null
  if (w.debounceTimer) clearTimeout(w.debounceTimer)
  if (w.timer) clearInterval(w.timer)
  if (w.nativeWatcher) {
    try {
      w.nativeWatcher.close()
    } catch {
      /* 关闭失败不影响停止监控 */
    }
    w.nativeWatcher = null
  }
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
 * 原生事件文件名 → 待广播子树（OP-05）。
 * @param {WatcherState} w 监控状态（读取 excludeNames）
 * @param {string|null} filename fs.watch 回调的文件名（recursive 下为相对路径）
 * @returns {string[]|null} 子树数组；null 表示忽略该事件；空数组表示无法定位（全量兜底）
 */
function nativeEventDirs(w, filename) {
  // 文件名缺失（缓冲区溢出/平台差异）时无法定位子树：走全量扫描兜底
  if (typeof filename !== 'string' || !filename) return []
  const rel = filename.split(path.sep).join('/').replace(/^\/+/, '')
  if (!rel) return []
  const segments = rel.split('/').filter(Boolean)
  for (const seg of segments) {
    // 关联存储/隐藏项/put_ 临时项/内置与用户排除目录：与快照遍历共享
    // isExcludedScanName（O11），从机制上避免监听自身写入造成自激励
    if (isExcludedScanName(seg, w.excludeNames)) return null
  }
  const slash = rel.lastIndexOf('/')
  return [slash < 0 ? '' : rel.slice(0, slash)]
}

/**
 * 启动原生递归监听（OP-05，仅作加速触发；失败时静默回落到轮询）。
 * @param {WatcherState} w 监控状态
 */
function startNativeWatch(w) {
  try {
    const native = fsSync.watch(w.root, { recursive: true }, (_eventType, filename) => {
      if (w !== watcher) return // 旧根在途事件：丢弃（B2 代际防护）
      const dirs = nativeEventDirs(w, filename)
      if (dirs === null) return
      // refresh：原生事件后回填快照基线，避免下一轮轮询重复检出同一变更
      scheduleBroadcast(w, dirs, { refresh: true })
    })
    native.on('error', (err) => {
      logger.warn(`原生目录监听异常，回落到轮询: ${err.message}`)
      try {
        native.close()
      } catch {
        /* 已关闭 */
      }
      if (w === watcher) {
        w.nativeWatcher = null
        // 监听已不可用：恢复原轮询节奏，保证变更仍能被发现
        w.pollInterval = DEFAULT_POLL_INTERVAL
        w.backoff = NATIVE_WATCH_FALLBACK_BACKOFF
      }
    })
    w.nativeWatcher = native
    return true
  } catch (err) {
    logger.warn(`原生目录监听不可用，继续使用轮询: ${err.message}`)
    w.nativeWatcher = null
    return false
  }
}

/**
 * 快照条目（内容快照使用；目录条目只有 name/isDir，符号链接与扫描策略一致地跳过）：
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
 * skipNames 中的目录名（用户排除目录）与 scanner 内置排除策略命中的条目
 * 被整条剔除——既不进快照也不递归，其出现/消失/内部变化都不构成模型库
 * 变更。遍历深度与 scanner 的 MAX_SCAN_DEPTH 一致；符号链接与扫描侧一致
 * 地跳过（不跟随、不记录），避免监控侧对扫描侧忽略的条目产生误报。
 * 子目录读取失败（遍历中被删除/锁定）时跳过该子树——其变化会反映在父层
 * 条目名差异上；根目录不可读时抛出，由调用方决定（监控场景下降级为停止监控）。
 *
 * @param {string} root 遍历根目录
 * @param {Set<string>} [skipNames] 用户排除目录名小写集合（与 scanner 同规则）
 * @param {{withStats?: boolean, concurrency?: number, startDepth?: number}} [options]
 *   withStats: 是否采集文件 size/mtime（内容变更检测）；concurrency: 目录并发上限；
 *   startDepth: 起始目录相对扫描根的深度（子树回填时保持全库深度上限语义）
 * @returns {Promise<Map<string, string[]|SnapshotEntry[]>>} 目录快照
 */
export async function collectDirSnapshot(root, skipNames = new Set(), options = {}) {
  const snapshot = new Map()
  const skip = new Set(skipNames)
  const withStats = options.withStats === true
  const concurrency = normalizeConcurrency(options.concurrency)
  const startDepth =
    Number.isFinite(options.startDepth) && options.startDepth > 0
      ? Math.floor(options.startDepth)
      : 0

  /** 动态目录队列 + 固定 worker 数：不一次性为整棵树创建 Promise */
  const queue = [{ dir: root, isRoot: true, depth: startDepth }]
  let active = 0
  let settled = false

  /** @type {Promise<void>} */
  const walkDone = new Promise((resolve, reject) => {
    const finish = (err) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve()
    }

    /** 处理单个目录：读取条目、写入快照、把子目录追加到队列 */
    const readOne = async ({ dir, isRoot, depth }) => {
      let entries
      try {
        entries = await fs.readdir(dir, { withFileTypes: true })
      } catch (err) {
        if (isRoot) throw err
        return
      }
      // O11：与 scanner 共享 isVisibleScanEntry，规则不再两侧各写一份
      const visible = entries.filter((entry) => isVisibleScanEntry(entry, skip))
      const canDescend = depth < MAX_SCAN_DEPTH
      if (!withStats) {
        snapshot.set(dir, visible.map((e) => e.name).sort())
        for (const entry of visible) {
          if (canDescend && entry.isDirectory()) {
            queue.push({ dir: path.join(dir, entry.name), isRoot: false, depth: depth + 1 })
          }
        }
        return
      }

      // 内容快照：目录条目只记名称/类型；文件逐项 stat 并记录 size/mtime。
      // 单目录内 stat 也有界，避免「大目录 × 目录池」放大句柄占用。
      const list = []
      const files = []
      for (const entry of visible) {
        if (entry.isDirectory()) list.push({ name: entry.name, isDir: true })
        else files.push(entry)
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
        if (canDescend && entry.isDirectory()) {
          queue.push({ dir: path.join(dir, entry.name), isRoot: false, depth: depth + 1 })
        }
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
  await walkDone
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
    const rel = relativeWithin(dirAbs, root)
    // 理论上快照键都在根内；防御性忽略越界项
    if (rel === null) return
    dirs.add(rel === '' ? '' : rel.split(path.sep).join('/'))
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
    const rel = relativeWithin(dirAbs, root)
    // 理论上快照键都在根内；防御性忽略越界项
    if (rel === null) return
    dirs.add(rel === '' ? '' : rel.split(path.sep).join('/'))
  }
  for (const [dir, entries] of oldSnap) consider(dir, entries, newSnap.get(dir))
  for (const [dir, entries] of newSnap) consider(dir, entries, oldSnap.get(dir))
  return [...dirs].sort()
}

/** 根目录比较：Windows 大小写不敏感 */
function sameRoot(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase()
}

/**
 * 规范化扫描产出的目录名快照（OPT-02）：
 * - 只保留根内键，越界项丢弃；
 * - 剔除内置/用户排除目录键（扫描期间排除设置变更时的兜底）；
 * - 条目名过滤隐藏项/put_ 临时项并稳定排序，与 collectDirSnapshot 同构。
 * @param {string} root 模型根目录
 * @param {Map<string, string[]>} snapshot 扫描产出的目录快照
 * @param {Set<string>} excludeNames 用户排除目录名小写集合
 * @returns {Map<string, string[]>} 可用的名称快照
 */
function sanitizeBaseline(root, snapshot, excludeNames) {
  const out = new Map()
  if (!(snapshot instanceof Map)) return out
  for (const [abs, names] of snapshot) {
    if (typeof abs !== 'string' || !Array.isArray(names)) continue
    const rel = relativeWithin(abs, root)
    if (rel === null) continue
    const segments = rel === '' ? [] : rel.split(path.sep)
    if (segments.some((seg) => isExcludedScanName(seg, excludeNames))) continue
    out.set(
      abs,
      names
        .filter((name) => typeof name === 'string' && name && !isExcludedScanEntryName(name))
        .sort()
    )
  }
  return out
}

/** 删除某目录及其全部后代的快照条目（目录被删除/子树回填前调用） */
function removeSnapshotSubtree(w, absDir) {
  for (const dir of [...w.snapshot.keys()]) {
    if (relativeWithin(dir, absDir) !== null) w.snapshot.delete(dir)
  }
  if (w.statSnapshot) {
    for (const dir of [...w.statSnapshot.keys()]) {
      if (relativeWithin(dir, absDir) !== null) w.statSnapshot.delete(dir)
    }
  }
}

/**
 * 清理已被扫描范围覆盖的待广播子树（OPT-02）：
 * - scopes=null 表示全量扫描，全部覆盖；
 * - 数组按局部扫描语义（'' 仅根直属），只清理真正被覆盖的目录；
 * - 清理后若无剩余项，取消已安排的防抖广播（扫描结果已包含这些变更）。
 */
function clearScannedPendingDirs(w, scopes) {
  const clearSet = (set) => {
    if (scopes === null) {
      set.clear()
      return
    }
    for (const dir of [...set]) {
      if (isRelDirInScope(dir, scopes)) set.delete(dir)
    }
  }
  clearSet(w.pendingDirs)
  clearSet(w.pendingConfirmedDirs)
  if (
    w.pendingDirs.size === 0 &&
    w.pendingConfirmedDirs.size === 0 &&
    w.debounceTimer
  ) {
    clearTimeout(w.debounceTimer)
    w.debounceTimer = null
  }
}

/** 全量扫描基线：整体替换名称快照，内容基线延后重建 */
function applyFullBaseline(w, snapshot) {
  const baseline = sanitizeBaseline(w.root, snapshot, w.excludeNames)
  if (baseline.size === 0) return false
  w.snapshot = baseline
  w.statSnapshot = null
  w.snapshotRevision += 1
  // 扫描已完成；内容基线留到下一个内容校验周期重建，避免扫描后立即全树 stat
  w.lastContentCheckAt = Date.now()
  w.idleRounds = 0
  clearScannedPendingDirs(w, null)
  return true
}

/** 局部扫描基线：按受影响子树替换名称快照，范围外条目保持原样 */
function applyPartialBaseline(w, dirs, snapshot) {
  const scopes = dedupeAndPruneDescendants(Array.isArray(dirs) ? dirs : [])
  if (scopes.length === 0) return false
  const baseline = sanitizeBaseline(w.root, snapshot, w.excludeNames)
  for (const rel of scopes) {
    const abs = rel === '' ? w.root : path.join(w.root, ...rel.split('/'))
    if (rel === '') {
      // 空串仅代表根目录直属：只替换根目录自身条目，保留已存在的后代快照
      w.snapshot.delete(abs)
      if (w.statSnapshot) w.statSnapshot.delete(abs)
      continue
    }
    removeSnapshotSubtree(w, abs)
  }
  for (const [abs, names] of baseline) {
    const rel = relativeWithin(abs, w.root)
    if (rel === null) continue
    const relPosix = rel === '' ? '' : rel.split(path.sep).join('/')
    if (!isRelDirInScope(relPosix, scopes)) continue
    w.snapshot.set(abs, names)
  }
  // 非根子树扫描后目录可能已消失：快照中不存在该键即视为删除
  for (const rel of scopes) {
    if (rel === '') continue
    const abs = path.join(w.root, ...rel.split('/'))
    if (!w.snapshot.has(abs)) removeSnapshotSubtree(w, abs)
  }
  w.statSnapshot = null
  w.snapshotRevision += 1
  // 保留原内容校验节奏：局部扫描不推迟范围外目录的同名覆盖检测
  w.idleRounds = 0
  clearScannedPendingDirs(w, scopes)
  return true
}

/**
 * 原生事件广播后回填相关子树快照（OPT-02）：
 * 事件只用于提前触发，快照才是正确性来源；若不回填，下一轮轮询会把同一
 * 变更再当作新变更广播一次，导致重复局部扫描。
 * @param {WatcherState} w 监控状态
 * @param {string[]} relDirs 变更子树（空数组表示无法定位，按全根处理）
 * @returns {Promise<void>}
 */
async function refreshSnapshotScopes(w, relDirs) {
  if (w !== watcher || w.refreshing) return
  w.refreshing = true
  try {
    const scopes = dedupeAndPruneDescendants(
      Array.isArray(relDirs) && relDirs.length > 0 ? relDirs : ['']
    )
    for (const rel of scopes) {
      if (w !== watcher) return
      const depth = rel === '' ? 0 : rel.split('/').length
      if (depth > MAX_SCAN_DEPTH) continue
      const abs = rel === '' ? w.root : path.join(w.root, ...rel.split('/'))
      if (relativeWithin(abs, w.root) === null) continue
      const withStats = Boolean(w.statSnapshot)
      let snapshot
      try {
        snapshot = await collectDirSnapshot(abs, w.excludeNames, {
          withStats,
          concurrency: w.traversalConcurrency,
          startDepth: depth
        })
      } catch (err) {
        // 子树在事件与回填之间被删除：移除其快照即可，由父目录条目反映变更
        if (rel !== '' && (err?.code === 'ENOENT' || err?.code === 'ENOTDIR')) {
          removeSnapshotSubtree(w, abs)
          continue
        }
        throw err
      }
      if (w !== watcher) return
      if (rel === '') {
        // 无法定位子树（filename 缺失等）：按全根刷新，后续轮询以本次为基线
        w.snapshot = withStats ? namesFromSnapshot(snapshot) : snapshot
        w.statSnapshot = withStats ? snapshot : null
        continue
      }
      removeSnapshotSubtree(w, abs)
      for (const [dir, entries] of snapshot) {
        w.snapshot.set(dir, withStats ? entries.map((entry) => entry.name) : entries)
        if (withStats && w.statSnapshot) w.statSnapshot.set(dir, entries)
      }
    }
  } catch (err) {
    logger.warn(
      `原生事件快照回填失败${w === watcher ? '，已停止监控' : '（旧根已丢弃）'}: ${err.message}`
    )
    if (w === watcher) stopWatcher()
  } finally {
    if (w === watcher) {
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
 * - 两类来源取并集并去重，仍保持「一次防抖窗只广播一次」。
 * @param {WatcherState} w 监控状态
 * @param {string[]} nativeDirs 原生事件候选子树
 * @param {string[]} confirmedDirs 轮询已确认的变更子树
 * @param {boolean} needsRefresh 是否需要回填原生事件候选快照
 * @returns {Promise<void>}
 */
async function deliverBroadcast(w, nativeDirs, confirmedDirs, needsRefresh) {
  if (w !== watcher || w.scanning) return
  let dirs = [...confirmedDirs]
  if (needsRefresh) {
    const before = new Map(w.snapshot)
    const beforeStats = w.statSnapshot ? new Map(w.statSnapshot) : null
    await refreshSnapshotScopes(w, nativeDirs)
    if (w !== watcher || w.scanning) return
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
  logger.info(`检测到模型目录变更，触发重扫: ${w.root}（${dirs.length} 个子树）`)
  broadcast(w.root, dirs)
}

/** 串行消费广播队列：同一 watcher 同一时刻只交付一轮，避免回填交叉 */
async function pumpDeliverQueue(w) {
  if (w.delivering) return
  w.delivering = true
  try {
    while (w === watcher && w.deliverQueue.length > 0) {
      const entry = w.deliverQueue.shift()
      try {
        await deliverBroadcast(w, entry.nativeDirs, entry.confirmedDirs, entry.needsRefresh)
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
function scheduleBroadcastTimer(w) {
  if (w !== watcher || w.scanning || w.debounceTimer) return
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
 * 代际校验（B2 修复）：w 已不是当前 watcher（stop/syncWatcher 切换到新根）
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
function scheduleBroadcast(w, changedDirs = [], options = {}) {
  if (w !== watcher) return
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
      const contentEnabled = Number.isFinite(w.contentCheckInterval) && w.contentCheckInterval > 0
      const wantStats =
        contentEnabled &&
        (silent || Date.now() - w.lastContentCheckAt >= w.contentCheckInterval)
      const revisionAtStart = w.snapshotRevision
      const snapshot = await collectDirSnapshot(w.root, w.excludeNames, {
        withStats: wantStats,
        concurrency: w.traversalConcurrency
      })

      // 遍历期间进入扫描期/开始原生事件回填/基线已被其他路径更新：本轮结果
      // 可能落后于对方基线，直接丢弃，避免用旧快照覆盖新基线并重复广播
      if (
        w !== watcher ||
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
              /** @type {Map<string, SnapshotEntry[]>} */ (snapshot)
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
        /** @type {Map<string, string[]>} */ (snapshot)
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
 * 扫描期开关（OPT-02）：扫描期间暂停巡检与广播，变更目录先累积；
 * 扫描成功后由 syncWatcher（全量）或 refreshWatcherBaseline（局部）覆盖基线并
 * 清理已覆盖项；停扫时只补发未被扫描覆盖的子树。
 * @param {boolean} scanning 是否进入扫描期
 */
export function setWatcherScanning(scanning) {
  const w = watcher
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
  const w = watcher
  if (!w || !w.enabled || !sameRoot(w.root, root)) return false
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
 *   nativeWatch?: boolean, baseline?: Map<string, string[]>,
 *   backoff?: number[], isVisible?: () => boolean,
 *   onPollScheduled?: (delay: number) => void}} [timing]
 *   轮询间隔/广播防抖/内容校验间隔（毫秒）与目录遍历并发；nativeWatch 开启
 *   原生事件监听；baseline 为全量扫描产出的目录名快照（OPT-02：直接作为
 *   监控基线，跳过扫描后的重复全树遍历）；backoff 空闲退避阶梯；
 *   isVisible/onPollScheduled 为测试注入钩子；生产走默认值，测试注入小值
 *   （contentCheckInterval≤0 关闭内容校验）
 */
export function syncWatcher(root, enabled, excludeDirs = [], timing = {}) {
  const wantEnabled = enabled === true
  if (watcher && sameRoot(watcher.root, root) && watcher.enabled === wantEnabled) {
    // 同根同状态（如每次扫描完成后的重复同步）：刷新排除名单；若本次扫描
    // 提供了目录快照，直接覆盖基线并清理已扫描的待广播项（OPT-02），
    // 不重启遍历（skipNames 每轮遍历时读取，热生效）
    watcher.excludeNames = toNameSet(excludeDirs)
    if (timing.baseline instanceof Map && timing.baseline.size > 0) {
      applyFullBaseline(watcher, timing.baseline)
    }
    // OP-05：原生监听曾因异常退出（或首次不可用）时，借同步时机尝试重建
    if (watcher.nativeWatch && !watcher.nativeWatcher) {
      startNativeWatch(watcher)
    }
    return
  }
  stop()
  if (!root || !wantEnabled) return

  // OP-05：原生事件监听默认关闭（由调用方显式开启）；开启时轮询降频为兜底
  const nativeWatch = timing.nativeWatch === true
  const pollMs =
    timing.pollInterval ?? (nativeWatch ? NATIVE_WATCH_POLL_INTERVAL : DEFAULT_POLL_INTERVAL)
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
    refreshing: false,
    scanning: false,
    pendingNeedsRefresh: false,
    delivering: false,
    deliverQueue: [],
    snapshotRevision: 0,
    idleRounds: 0,
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
    isVisible: typeof timing.isVisible === 'function' ? timing.isVisible : windowsVisible,
    onPollScheduled: typeof timing.onPollScheduled === 'function' ? timing.onPollScheduled : null
  }
  watcher = w
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
      `）: ${root}`
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

/** 停止目录监控（应用退出时调用） */
export function stopWatcher() {
  stop()
  logger.info('目录监控已停止')
}
