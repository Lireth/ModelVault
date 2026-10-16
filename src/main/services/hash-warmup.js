import fs from 'node:fs/promises'
import logger from '../logger'
import { getModelMeta, setModelMeta } from './store'
import { computeFileHash } from './civitai'

/**
 * 模型哈希后台预热服务（Civitai 识别加速）：
 *
 * Civitai by-hash 反查要求完整的文件 SHA256，大文件（1-10GB）首次计算
 * 耗时数十秒。本服务在应用启动/扫描完成后于后台逐个预计算缺失的哈希并
 * 写入元数据缓存（hash/hashMtime，与识别链路共用同一缓存约定），用户点击
 * 识别时命中缓存即可秒回。
 *
 * 设计要点：
 * - 单文件串行处理：避免多路大文件读取争抢磁盘 I/O（与后台缩略图共用磁盘）；
 * - 去重：队列内 queued 集合 + 计算中 inflight 映射双重拦截；
 * - 共享计算：computeAndCacheHash 是预热与识别链路的唯一哈希计算入口，
 *   识别到达时若同一模型（同 mtime）正在预热，直接复用同一 Promise，
 *   绝不重复读盘计算；
 * - 写盘前重读最新元数据：哈希计算期间用户可能已并发保存其他字段
 *   （与 ipc/models/civitai.js ensureHash 的既有约定一致）；
 * - 扫描让路：全量/局部扫描期间暂停取队（正在计算的单个文件不中断），
 *   扫描结束后自动恢复，避免预热拖慢扫描；
 * - 容错：文件已删除/移动（stat 失败）静默跳过，不中断队列。
 */

/** 普通入队后的延迟启动间隔（ms）：避开扫描刚结束/缩略图生成的 I/O 高峰 */
const WARMUP_DELAY_MS = 3000

/** 待预热队列（FIFO；优先任务 unshift 插队） */
const queue = []
/** 队列去重集合（与 queue 同步维护） */
const queued = new Set()
/** 进行中的哈希任务：id -> { mtimeMs, promise }（供识别链路共享复用） */
const inflight = new Map()
/** 延迟启动定时器（全局唯一，重复调度时保留更早的计划） */
let drainTimer = null
/** 定时器计划触发时间（ms 时间戳），用于比较保留更早计划 */
let drainScheduledAt = 0
/** drain 是否正在消费队列 */
let draining = false
/** 扫描期间置 true：drain 暂停取队（已在计算的单个文件不中断） */
let paused = false

/**
 * 计算并缓存模型哈希（预热与识别链路共用的单一入口）：
 * 同一模型同 mtime 已在计算中时复用同一 Promise；完成后重读最新元数据
 * 回写 hash/hashMtime。
 * @param {string} id 模型绝对路径
 * @param {number} mtimeMs 调用方 stat 到的文件 mtime（保证缓存与文件版本对应）
 * @returns {Promise<string>} 64 位十六进制 SHA256
 */
export function computeAndCacheHash(id, mtimeMs) {
  const current = inflight.get(id)
  if (current && current.mtimeMs === mtimeMs) return current.promise
  const promise = (async () => {
    const hash = await computeFileHash(id)
    // 写盘前重读最新元数据：哈希计算期间用户可能已并发保存其他字段
    const latest = getModelMeta(id) || {}
    setModelMeta(id, { ...latest, hash, hashMtime: mtimeMs })
    return hash
  })()
  const entry = { mtimeMs, promise }
  inflight.set(id, entry)
  // 完成后清理映射；拒绝场景下 finally 派生的 promise 由尾部 catch 消费
  // （预热为后台任务可能无调用方 await，防 unhandledRejection；识别链路
  // await 的是原始 promise，仍能拿到错误自行处理）
  promise
    .finally(() => {
      if (inflight.get(id) === entry) inflight.delete(id)
    })
    .catch(() => {})
  return promise
}

/**
 * 请求预热一批模型的哈希（去重入队，由 drain 后台串行消费）：
 * 已在队列/计算中的模型自动跳过；缓存是否有效由消费时按 mtime 复查。
 * @param {string[]} ids 模型绝对路径列表
 * @param {{priority?: boolean, delayMs?: number}} [opts]
 *   priority: 插队到队首并立即启动（详情页打开当前模型）；
 *   delayMs: 普通入队的延迟启动间隔（默认 3s）
 */
export function requestHashWarmup(ids, opts = {}) {
  const priority = opts.priority === true
  let added = false
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== 'string' || !id || queued.has(id) || inflight.has(id)) continue
    queued.add(id)
    if (priority) queue.unshift(id)
    else queue.push(id)
    added = true
  }
  if (!added) return
  scheduleDrain(priority ? 0 : opts.delayMs ?? WARMUP_DELAY_MS)
}

/** 扫描开始：暂停 drain 取队（正在计算的单个文件不中断，处理完当前即停） */
export function pauseHashWarmup() {
  paused = true
}

/**
 * 扫描结束：恢复取队；队列非空且无既定计划时重新调度。
 * @param {number} [delayMs] 恢复调度的延迟间隔（生产默认 3s，测试可传 0）
 */
export function resumeHashWarmup(delayMs = WARMUP_DELAY_MS) {
  paused = false
  if (queue.length > 0 && !drainTimer && !draining) scheduleDrain(delayMs)
}

/** 调度一次 drain（全局唯一；重复调度时保留更早的计划，优先任务可提前） */
function scheduleDrain(delayMs) {
  const runAt = Date.now() + delayMs
  if (drainTimer && runAt >= drainScheduledAt) return
  if (drainTimer) clearTimeout(drainTimer)
  drainScheduledAt = runAt
  drainTimer = setTimeout(() => {
    drainTimer = null
    drain()
  }, delayMs)
}

/** 串行消费队列：逐个 stat 复查 → 跳过有效缓存 → 计算并回写 */
async function drain() {
  if (draining) return
  draining = true
  try {
    while (queue.length > 0 && !paused) {
      const id = queue.shift()
      queued.delete(id)
      if (inflight.has(id)) continue
      let mtimeMs
      try {
        const stat = await fs.stat(id)
        if (!stat.isFile()) continue
        mtimeMs = stat.mtimeMs
      } catch {
        continue // 文件已被删除/移动：静默跳过
      }
      const meta = getModelMeta(id)
      if (meta?.hash && meta.hashMtime === mtimeMs) continue // 缓存有效，免计算
      try {
        await computeAndCacheHash(id, mtimeMs)
        logger.info(`后台哈希预热完成: ${id}`)
      } catch (err) {
        logger.warn(`后台哈希预热失败: ${id} ${err.message}`)
      }
    }
  } finally {
    draining = false
  }
}

/* ---------------- 仅供单元测试使用 ---------------- */

/** 等待队列清空且所有计算完成（测试辅助，轮询直至空闲） */
export async function whenWarmupIdle() {
  while (queue.length > 0 || draining || inflight.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** 清空全部内部状态（测试隔离用；生产代码严禁调用） */
export function resetHashWarmupForTests() {
  queue.length = 0
  queued.clear()
  inflight.clear()
  paused = false
  draining = false
  if (drainTimer) {
    clearTimeout(drainTimer)
    drainTimer = null
    drainScheduledAt = 0
  }
}
