import path from 'node:path'
import { relativeWithin } from '../utils'
import {
  dedupeAndPruneDescendants,
  isRelDirInScope,
} from '../../shared/scan-dirs'
import { isExcludedScanEntryName, isExcludedScanName } from './scanner'

/**
 * 监控基线应用（O12 自 watcher.js 拆出）：
 * 扫描（全量/局部）完成后把扫描产出的目录快照覆盖为监控基线，并清理已被
 * 扫描覆盖的待广播子树，避免「扫描已包含的变更」再次触发局部扫描（OPT-02）。
 * 全部函数以调用方传入的 WatcherState 为操作对象，不读取监控单例；
 * `w !== getWatcher()` 的代际防护由调用方（广播/轮询链路）负责。
 */

/** @typedef {import('./watcher-state').WatcherState} WatcherState */

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
        .filter(
          (name) =>
            typeof name === 'string' && name && !isExcludedScanEntryName(name),
        )
        .sort(),
    )
  }
  return out
}

/** 删除某目录及其全部后代的快照条目（目录被删除/子树回填前调用） */
export function removeSnapshotSubtree(w, absDir) {
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
export function applyFullBaseline(w, snapshot) {
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
export function applyPartialBaseline(w, dirs, snapshot) {
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
