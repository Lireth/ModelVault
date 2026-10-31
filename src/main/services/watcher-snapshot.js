import fs from 'node:fs/promises'
import path from 'node:path'
import { relativeWithin, runWithConcurrency } from '../utils'
import { MAX_SCAN_DEPTH, isVisibleScanEntry } from './scanner'
import {
  DEFAULT_TRAVERSAL_CONCURRENCY,
  STAT_CONCURRENCY,
} from './watcher-state'

/**
 * 目录快照采集与差异计算（O12 自 watcher.js 拆出）：
 * 纯函数模块——不读取监控单例，输入输出均为显式参数。轮询巡检（watcher-poll）、
 * 原生事件回填（watcher-broadcast）与扫描基线（watcher-baseline）共用。
 */

/**
 * 快照条目（内容快照使用；目录条目只有 name/isDir，符号链接与扫描策略一致地跳过）：
 * @typedef {object} SnapshotEntry
 * @property {string} name 条目名
 * @property {boolean} [isDir] 是否为目录
 * @property {number|null} [size] 文件字节数（stat 失败为 null）
 * @property {number|null} [mtimeMs] 文件修改时间（stat 失败为 null）
 */

/** 把并发配置收口到 [1, 64] 的安全区间 */
export function normalizeConcurrency(value) {
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
export async function collectDirSnapshot(
  root,
  skipNames = new Set(),
  options = {},
) {
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
            queue.push({
              dir: path.join(dir, entry.name),
              isRoot: false,
              depth: depth + 1,
            })
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
            stats[index] = {
              name: entry.name,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
            }
          } catch {
            // 遍历期间被删除/锁定：记空值，下一轮内容校验会恢复或再次发现
            stats[index] = { name: entry.name, size: null, mtimeMs: null }
          }
        },
        STAT_CONCURRENCY,
      )
      list.push(...stats)
      snapshot.set(dir, list.sort(compareEntryName))
      for (const entry of visible) {
        if (canDescend && entry.isDirectory()) {
          queue.push({
            dir: path.join(dir, entry.name),
            isRoot: false,
            depth: depth + 1,
          })
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
export function namesFromSnapshot(statSnapshot) {
  const names = new Map()
  for (const [dir, entries] of statSnapshot) {
    names.set(
      dir,
      entries.map((entry) => entry.name),
    )
  }
  return names
}

/**
 * 对选定目录补齐内容条目（OPT-9 渐进内容校验）：
 * 以名称快照为事实清单，仅 stat 选中目录内的条目（同名覆盖写入检测），
 * 未选中目录由调用方沿用旧内容条目。条目形状与 collectDirSnapshot(true)
 * 完全一致（目录条目仅记 isDir，stat 失败记 null，名称排序），两套结果
 * 可直接合并参与 computeStatSnapshotDiff。
 * @param {Map<string, string[]>} nameSnapshot 名称快照（全树，已按可见性过滤）
 * @param {Iterable<string>} selectedDirs 本轮 stat 的目录绝对路径集合
 * @param {{dirConcurrency?: number}} [options] 目录间并发上限（目录内文件
 *   stat 沿用 STAT_CONCURRENCY，与 collectDirSnapshot 同款有界并发）
 * @returns {Promise<Map<string, SnapshotEntry[]>>} 选中目录的内容条目
 */
export async function statSelectedDirEntries(
  nameSnapshot,
  selectedDirs,
  options = {},
) {
  const dirs = [...selectedDirs].filter((dir) => nameSnapshot.has(dir))
  const out = new Map()
  await runWithConcurrency(
    dirs,
    async (dir) => {
      const names = nameSnapshot.get(dir) || []
      const entries = new Array(names.length)
      await runWithConcurrency(
        names,
        async (name, index) => {
          try {
            const stat = await fs.stat(path.join(dir, name))
            entries[index] = stat.isDirectory()
              ? { name, isDir: true }
              : { name, size: stat.size, mtimeMs: stat.mtimeMs }
          } catch {
            // stat 间隙被删除/锁定：记空值，下一轮内容校验会恢复或再次发现
            entries[index] = { name, size: null, mtimeMs: null }
          }
        },
        STAT_CONCURRENCY,
      )
      out.set(dir, entries.sort(compareEntryName))
    },
    normalizeConcurrency(options.dirConcurrency),
  )
  return out
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
  for (const [dir, entries] of newSnap) consider(dir, oldSnap.get(dir), entries)
  return [...dirs].sort()
}
