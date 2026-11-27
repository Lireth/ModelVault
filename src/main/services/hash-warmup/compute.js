import fs from 'node:fs/promises'
import logger from '../../logger'
import { getModelMeta, setModelMeta } from '../store'
import { computeFileHash } from '../civitai'
import { isRetryableHashPoolError } from '../hash-worker-pool'
import { errorMessage } from '../../../shared/error-text'
import { warmup, TRANSIENT_RETRY_DELAY_MS } from './state'
import { emitProgress } from './progress'

/**
 * 哈希计算核心域（O8 自 hash-warmup.js 拆出）：
 * computeAndCacheHash 是预热与识别链路的唯一哈希计算入口，
 * 含临时故障重试（OPT-05）、版本竞态防护与缓存回写。
 */

/**
 * 线程池临时故障重试（OPT-05）：worker 崩溃/临时文件占用时最多重试 2 次；
 * 退避等待与线程池重启延迟（250ms 起）错开，避免立即撞上未就绪的新 worker。
 */
const TRANSIENT_RETRY_MAX = 2

/**
 * 注入临时故障重试退避时长（仅供单元测试使用；生产代码严禁调用）
 * @param {number} ms 毫秒数
 */
export function setHashRetryDelayForTests(ms) {
  warmup.transientRetryDelayMs =
    Number.isFinite(ms) && ms >= 0 ? ms : TRANSIENT_RETRY_DELAY_MS
}

/**
 * 等待指定毫秒（重试退避）
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 带临时故障重试的哈希计算（OPT-05）：
 * 仅对 worker 崩溃/连续不可用/临时文件占用等可恢复错误重试，最多 2 次；
 * 每次重试前复位进度并等待线程池退避重启。永久错误（ENOENT/EACCES 等）
 * 直接抛出，不进行无效重试。
 * @param {string} id 模型绝对路径
 * @param {boolean} priority 是否前台优先任务
 * @param {{active: boolean, id: string, percent: number, hashedBytes: number,
 *   totalBytes: number, hash: string}} snap 进度快照
 * @param {AbortSignal} signal 取消信号（同 id 新版本请求取代旧任务时中止）
 * @returns {Promise<string>} SHA256
 */
async function computeHashWithRetry(id, priority, snap, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await computeFileHash(
        id,
        signal,
        (hashedBytes, totalBytes) => {
          snap.hashedBytes = hashedBytes
          snap.totalBytes = totalBytes
          snap.percent =
            totalBytes > 0
              ? Math.min(100, Math.round((hashedBytes / totalBytes) * 100))
              : 0
          emitProgress(snap)
        },
        { priority },
      )
    } catch (err) {
      if (attempt >= TRANSIENT_RETRY_MAX || !isRetryableHashPoolError(err))
        throw err
      logger.warn(
        `哈希计算临时失败，${warmup.transientRetryDelayMs}ms 后重试` +
          `（第 ${attempt + 1}/${TRANSIENT_RETRY_MAX} 次）: ${id} ${errorMessage(err)}`,
      )
      // 上一次尝试可能已推送过部分进度：重试前复位，避免界面停在旧百分比
      snap.percent = 0
      snap.hashedBytes = 0
      snap.totalBytes = 0
      emitProgress(snap, true)
      await delay(warmup.transientRetryDelayMs)
    }
  }
}

/**
 * 计算并缓存模型哈希（预热与识别链路共用的单一入口）：
 * 同一模型同 mtime 已在计算中时复用同一 Promise；完成后重读最新元数据
 * 回写 hash/hashMtime。线程池临时故障自动重试（OPT-05）。
 * 计算完成后复查文件 mtime：期间被同名覆盖/移动/删除时抛错且不写缓存
 * （此时哈希对应旧版本或混合内容，写入会让识别链路反查到错误的模型版本）。
 * @param {string} id 模型绝对路径
 * @param {number} mtimeMs 调用方 stat 到的文件 mtime（保证缓存与文件版本对应）
 * @param {{priority?: boolean}} [options] priority=true 为前台任务（详情页/识别），
 *   线程池会优先执行并让在途后台任务让路（OPT-08）
 * @returns {Promise<string>} 64 位十六进制 SHA256
 * @throws 计算期间文件版本变化（mtime 不一致/已删除）或底层哈希错误
 */
export function computeAndCacheHash(id, mtimeMs, options = {}) {
  const priority = options.priority === true
  const current = warmup.inflight.get(id)
  if (current && current.mtimeMs === mtimeMs) return current.promise
  // OPT-13：同 id 不同 mtime 的新请求取代旧任务——旧结果本就会因完成后
  // mtime 复查被丢弃，此处直接中止其读盘，避免 1-10GB 文件被并行双倍读盘
  if (current) current.controller?.abort()
  const controller = new AbortController()
  const promise = (async () => {
    // 本次计算的进度快照（识别与预热链路共用，事件按 id 供渲染层匹配；
    // hash 完成后回填，随完成事件送达渲染层——FEAT-1 重复检测数据源）
    const snap = {
      active: true,
      id,
      percent: 0,
      hashedBytes: 0,
      totalBytes: 0,
      hash: '',
    }
    try {
      emitProgress(snap, true)
      const hash = await computeHashWithRetry(
        id,
        priority,
        snap,
        controller.signal,
      )
      // 竞态防护：大文件哈希耗时数十秒，期间文件可能被同名覆盖（重新下载/
      // 同步工具写入）。此时哈希对应旧版本或新旧混合内容，若仍以计算前的
      // mtime 落盘，缓存会与 knownInfo 的旧 mtime 判定为有效（hasValidCachedHash），
      // 识别链路据被污染的哈希反查到错误的模型版本。完成后复查 mtime：
      // 不一致（或文件已消失/不再是普通文件）即丢弃结果，绝不写缓存
      let after
      try {
        after = await fs.stat(id)
      } catch {
        throw new Error('哈希计算期间文件被移动或删除，本次结果已丢弃')
      }
      if (!after.isFile() || after.mtimeMs !== mtimeMs) {
        throw new Error('哈希计算期间文件被修改，本次结果已丢弃，请重试')
      }
      snap.hash = hash
      // 写盘前重读最新元数据：哈希计算期间用户可能已并发保存其他字段
      const latest = getModelMeta(id) || {}
      setModelMeta(id, { ...latest, hash, hashMtime: mtimeMs })
      // OPT-6：计算成功即清除失败记录（占用释放/外部修复后的首次成功自愈）
      warmup.hashFailures.delete(id)
      return hash
    } finally {
      // 完成即熄灭本快照（active=false），渲染层据此清除当前模型的进度标识
      snap.active = false
      emitProgress(snap, true)
    }
  })()
  const entry = { mtimeMs, promise, controller }
  warmup.inflight.set(id, entry)
  // 完成后清理映射；拒绝场景下 finally 派生的 promise 由尾部 catch 消费
  // （预热为后台任务可能无调用方 await，防 unhandledRejection；识别链路
  // await 的是原始 promise，仍能拿到错误自行处理）
  promise
    .finally(() => {
      if (warmup.inflight.get(id) === entry) warmup.inflight.delete(id)
    })
    .catch(() => {})
  return promise
}
