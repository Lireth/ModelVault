import fs from 'node:fs/promises'
import logger from '../../logger'
import { getModelMeta, setModelMeta } from '../store'
import { computeQuickFingerprint } from '../quick-fingerprint'
import { errorMessage } from '../../../shared/error-text'
import { warmup } from './state'
import { isHashFailSuppressed } from './failures'
import { pushQueue } from './queue'

/**
 * 体积索引与候选预筛域（O1/OP-C，O8 自 hash-warmup.js 拆出）：
 * 已知体积表/体积反查索引的维护、缓存有效性判定、快指纹获取
 * （两阶段查重的阶段一）与碰撞同伴补入队。
 */

/**
 * 规范化请求项：字符串或 {id, size, mtimeMs} 对象（扫描装饰结果可直接传入）
 * @param {Array<string|{id?: string, size?: number|null, mtimeMs?: number|null}>} items
 * @returns {Array<{id: string, size: number|null, mtimeMs: number|null}>}
 */
export function normalizeRequestItems(items) {
  /** @type {Array<{id: string, size: number|null, mtimeMs: number|null}>} */
  const out = []
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item === 'string' && item) {
      out.push({ id: item, size: null, mtimeMs: null })
    } else if (
      item &&
      typeof item === 'object' &&
      typeof item.id === 'string' &&
      item.id
    ) {
      out.push({
        id: item.id,
        // isFinite 判定为真时必为有限数（类型 cast，运行时零改动）
        size: Number.isFinite(item.size)
          ? /** @type {number} */ (item.size)
          : null,
        mtimeMs: Number.isFinite(item.mtimeMs)
          ? /** @type {number} */ (item.mtimeMs)
          : null,
      })
    }
  }
  return out
}

/**
 * 从体积反查索引中移除某 id（更新体积前调用）
 * @param {string} id 模型绝对路径
 */
function removeFromSizeIndex(id) {
  const info = warmup.knownInfo.get(id)
  if (!info || !Number.isFinite(info.size)) return
  const set = warmup.sizeIndex.get(info.size)
  if (!set) return
  set.delete(id)
  if (set.size === 0) warmup.sizeIndex.delete(info.size)
}

/**
 * 记录/更新模型的体积与 mtime（体积未知时保留旧值，避免降级为无信息）。
 * @param {string} id 模型绝对路径
 * @param {number|null} size 文件字节数
 * @param {number|null} mtimeMs 文件修改时间
 */
export function rememberInfo(id, size, mtimeMs) {
  const prev = warmup.knownInfo.get(id)
  if (prev) removeFromSizeIndex(id)
  const next = {
    size: Number.isFinite(size)
      ? size
      : prev && Number.isFinite(prev.size)
        ? prev.size
        : null,
    mtimeMs: Number.isFinite(mtimeMs)
      ? mtimeMs
      : prev && Number.isFinite(prev.mtimeMs)
        ? prev.mtimeMs
        : null,
  }
  warmup.knownInfo.set(id, next)
  if (Number.isFinite(next.size)) {
    let set = warmup.sizeIndex.get(next.size)
    if (!set) {
      set = new Set()
      warmup.sizeIndex.set(next.size, set)
    }
    set.add(id)
  }
}

/**
 * 缓存是否确定有效（哈希存在且 mtime 与已知值一致；mtime 未知时保守返回 false）
 * @param {string} id 模型绝对路径
 * @returns {boolean}
 */
export function hasValidCachedHash(id) {
  const info = warmup.knownInfo.get(id)
  const meta = getModelMeta(id)
  return Boolean(
    meta?.hash &&
    info &&
    Number.isFinite(info.mtimeMs) &&
    meta.hashMtime === info.mtimeMs,
  )
}

/**
 * 获取模型快指纹（OP-C 两阶段查重的阶段一，meta 缓存 + 按需计算）：
 * quickHash 且 quickHashMtime 与当前 stat 一致 → 缓存命中零读盘；否则计算
 * （头尾各 1MB，成本与文件体积无关）并写回元数据——写盘前重读最新元数据，
 * 与 computeAndCacheHash 同一约定。
 * 文件缺失/不可读/计算失败返回 null（调用方保守回退全量判定；指纹成本仅
 * 2MB 读盘，失败不入负缓存——下轮重试代价可忽略）。
 * @param {string} id 模型绝对路径
 * @returns {Promise<string|null>} 64 位十六进制快指纹
 */
export async function ensureQuickFingerprint(id) {
  let stat
  try {
    stat = await fs.stat(id)
    if (!stat.isFile()) return null
  } catch {
    return null
  }
  const meta = getModelMeta(id)
  if (meta?.quickHash && meta.quickHashMtime === stat.mtimeMs) {
    return meta.quickHash
  }
  try {
    const fp = await computeQuickFingerprint(id, stat.size)
    // 写盘前重读最新元数据：指纹计算期间用户可能已并发保存其他字段
    const latest = getModelMeta(id) || {}
    setModelMeta(id, { ...latest, quickHash: fp, quickHashMtime: stat.mtimeMs })
    return fp
  } catch (err) {
    logger.warn(
      `快指纹计算失败（该模型保守回退全量判定）: ${id} ${errorMessage(err)}`,
    )
    return null
  }
}

/**
 * 某体积分组出现 ≥2 个文件时，把组内尚未计算/缓存无效的模型一并入队。
 * 候选预筛的关键闭环：先前因体积唯一而跳过的模型，在后续扫描/局部扫描
 * 发现同尺寸文件时必须被补算，否则重复检测会漏掉「先出现的那一份」。
 * @param {number} size 文件字节数
 * @param {string|undefined} excludeId 当前正在处理的 id（避免重复入队自身）
 * @returns {boolean} 是否有新任务入队
 */
export function enqueueCollisionPeers(size, excludeId = undefined) {
  const ids = warmup.sizeIndex.get(size)
  if (!ids || ids.size < 2) return false
  let added = false
  for (const id of ids) {
    if (id === excludeId) continue
    if (warmup.queued.has(id) || warmup.inflight.has(id)) continue
    if (hasValidCachedHash(id)) continue
    // OPT-6：同版本近期失败的模型不重复入队（drain 侧实时 stat 复核兜底）
    if (isHashFailSuppressed(id, warmup.knownInfo.get(id)?.mtimeMs ?? null))
      continue
    if (pushQueue(id, false, 'candidates')) added = true
  }
  return added
}
