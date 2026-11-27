import logger from '../../logger'
import { backoffMs } from '../../utils'
import { errorMessage } from '../../../shared/error-text'
import { warmup, HASH_FAIL_RETRY_BASE_MS } from './state'

/**
 * 哈希失败负缓存域（OPT-6，O8 自 hash-warmup.js 拆出）：
 * 损坏/被占用（EACCES/EBUSY）等永久失败的文件，若每轮全量扫描都重新入队，
 * 意味着每次都完整读盘失败一遍（10GB 文件一次数分钟）。失败记录以
 * 「文件 mtime + 指数退避静默期」键控：
 * - 同版本（mtime 未变）且静默期未到：批量预热跳过该文件的读盘重试；
 * - 文件被修改（mtime 变化）：记录自动失效，新版本立即恢复预热资格；
 * - 静默期到期：自动恢复重试（占用释放/外部修复的自愈通道）；
 * - 任意一次计算成功：记录清除；
 * - 切库时整体作废（clearHashFailuresForLibrarySwitch，库根变化时由 IPC 层
 *   调用）：记录以绝对路径键控，跨库驻留会在路径复用且 mtime 一致时抑制
 *   新库文件的预热资格；
 * - 详情页/识别的 priority 按需任务不受限制（用户显式等待结果）；
 * - 让路重排（PreemptedError）不是失败，不入记录。
 */

/** 静默期上限：连续失败的退避封顶（24h） */
const HASH_FAIL_RETRY_MAX_MS = 24 * 60 * 60 * 1000
/** 退避倍率：同版本每次失败 ×4（5min → 20min → 80min → 5.3h → 封顶） */
const HASH_FAIL_BACKOFF_FACTOR = 4
/** 记录数上限（防御病态库；超过即丢弃最旧记录腾位） */
const HASH_FAIL_MAX_ENTRIES = 10000

/**
 * 注入哈希失败静默期基准（仅供单元测试使用；生产代码严禁调用）
 * @param {number} ms 毫秒数
 */
export function setHashFailRetryBaseForTests(ms) {
  warmup.hashFailRetryBaseMs =
    Number.isFinite(ms) && ms >= 0 ? ms : HASH_FAIL_RETRY_BASE_MS
}

/**
 * 同版本近期失败且静默期未到时为 true（批量预热跳过读盘重试）。
 * 文件已修改（mtime 变化）时记录自动失效并返回 false——新版本立即可预热。
 * @param {string} id 模型绝对路径
 * @param {number|null} mtimeMs 当前已知文件 mtime（未知时仅按静默期判定，
 *   drain 侧会以实时 stat 复核）
 * @returns {boolean}
 */
export function isHashFailSuppressed(id, mtimeMs) {
  const record = warmup.hashFailures.get(id)
  if (!record) return false
  if (
    Number.isFinite(mtimeMs) &&
    Number.isFinite(record.mtimeMs) &&
    record.mtimeMs !== mtimeMs
  ) {
    warmup.hashFailures.delete(id)
    return false
  }
  return Date.now() < record.retryAt
}

/**
 * 记录一次哈希失败（OPT-6）：同版本连续失败按 ×4 递增静默期（封顶 24h），
 * 新版本（mtime 变化）从基准重新计起。
 * @param {string} id 模型绝对路径
 * @param {number|null} mtimeMs 失败时已知的文件 mtime（drain stat 结果）
 * @param {unknown} err 失败原因（仅用于日志）
 */
export function recordHashFailure(id, mtimeMs, err) {
  const prev = warmup.hashFailures.get(id)
  const sameVersion = Boolean(
    prev && prev.mtimeMs === (Number.isFinite(mtimeMs) ? mtimeMs : null),
  )
  const attempts = sameVersion ? prev.attempts + 1 : 1
  const backoff = backoffMs(
    warmup.hashFailRetryBaseMs,
    attempts,
    HASH_FAIL_RETRY_MAX_MS,
    HASH_FAIL_BACKOFF_FACTOR,
  )
  if (warmup.hashFailures.size >= HASH_FAIL_MAX_ENTRIES && !prev) {
    // 病态防御：丢弃最旧记录（Map 保持插入序）为新记录腾位
    const oldest = warmup.hashFailures.keys().next().value
    if (oldest !== undefined) warmup.hashFailures.delete(oldest)
  }
  warmup.hashFailures.set(id, {
    mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : null,
    failAt: Date.now(),
    retryAt: Date.now() + backoff,
    attempts,
  })
  logger.warn(
    `后台哈希预热失败，已记入负缓存` +
      `（第 ${attempts} 次，${Math.round(backoff / 1000)}s 内批量预热跳过）` +
      `: ${id} ${errorMessage(err)}`,
  )
}

/**
 * 切库时清空哈希失败负缓存（与 resetDecorateCache 同一「库根变化即作废旧根
 * 状态」时机，由 openLibrary/全量扫描在根目录变化时调用）：失败记录以绝对
 * 路径键控、跨库驻留至会话结束，路径复用且 mtime 一致时旧库的失败记录
 * （含最长 24h 静默期）会抑制新库文件的预热资格。同库重扫/重载不调用，
 * OPT-6 的退避静默期在库会话内保持。
 */
export function clearHashFailuresForLibrarySwitch() {
  warmup.hashFailures.clear()
}
