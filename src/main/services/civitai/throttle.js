/**
 * Civitai API 节流与开关：
 * 全局限流状态（上次请求时刻/最小间隔/串行链）与 429、连接级瞬时错误的
 * 退避重试策略集中在本模块（可变状态不跨文件）；开关关闭统一拒绝文案。
 */

import logger from '../../logger'
import { cancelResponseBody } from '../../utils'
import {
  REQUEST_TIMEOUT_MS,
  fetchWithValidatedRedirects,
  isTransientNetworkError,
} from '../net-fetch'
import { errorMessage } from '../../../shared/error-text'
import { isAllowedCivitaiApiUrl } from './hosts'

/** 关闭 Civitai 开关时主进程统一拒绝文案（IPC 与 civimg 代理共用） */
export const CIVITAI_DISABLED_ERROR = 'Civitai 功能已关闭'

/**
 * Civitai API 全局限流（实测）：
 * 突发约 30 个请求后返回 429 Too Many Requests（Retry-After: 60），约
 * 1.3 请求/秒的持续速率可稳定通过（84 连发验证）。批量链路（识别/分配
 * 标签）请求间隔低于该速率即触发整批漏分配，故在服务层统一节流：
 * 相邻请求至少间隔 CIVITAI_API_MIN_INTERVAL_MS，并对 429 按 Retry-After
 * 退避重试兜底。
 */
const CIVITAI_API_MIN_INTERVAL_MS = 1200
/** 429 退避重试次数上限 */
const CIVITAI_429_MAX_RETRIES = 3
/** 429 无 Retry-After 头时的兜底等待（秒） */
const CIVITAI_429_FALLBACK_WAIT_S = 60
/** 429 Retry-After 等待上限（秒），防止异常大值卡死批量链路 */
const CIVITAI_429_MAX_WAIT_S = 90
/**
 * 连接级瞬时网络错误重试次数上限（1 次，与 update-download 的 OPT-01 同款）：
 * 批量识别/分类一次几十上百个请求，网络抖动（ECONNRESET/ERR_NETWORK_CHANGED
 * 等）若不重试，会把抖动窗口内的模型全部计入失败。判定器复用 net-fetch.js
 * 的 isTransientNetworkError 单一实现——只匹配连接建立/重置类特征，超时
 * 中止（重试会成倍拉长等待）与服务端 4xx/5xx（非网络层失败）不在此重试，
 * 由各自既有语义处理。
 */
const CIVITAI_TRANSIENT_MAX_RETRIES = 1
/** 瞬时错误重试的退避间隔（ms） */
const CIVITAI_TRANSIENT_RETRY_DELAY_MS = 500
/** 瞬时错误重试退避时长（测试可注入 0 避免真实等待） */
let civitaiTransientRetryDelayMs = CIVITAI_TRANSIENT_RETRY_DELAY_MS

/**
 * 注入瞬时错误重试退避时长（仅供单元测试使用；生产代码严禁调用）
 * @param {number} ms 毫秒
 */
export function setCivitaiTransientRetryDelayForTests(ms) {
  civitaiTransientRetryDelayMs =
    Number.isFinite(ms) && ms >= 0 ? ms : CIVITAI_TRANSIENT_RETRY_DELAY_MS
}

/** 上次 Civitai API 请求时刻（节流基准） */
let lastCivitaiApiAt = 0
/** 请求最小间隔（可经 setCivitaiApiInterval 注入，测试环境置 0 免真实等待） */
let civitaiApiIntervalMs = CIVITAI_API_MIN_INTERVAL_MS
/**
 * 节流串行链（V-06）：并发调用若各自「读时间戳 → 睡眠 → 写时间戳」，
 * 会同时睡醒后一起发请求，实际仍是一次突发。这里把间隔判定与时间戳
 * 更新串成一条链，保证请求起点按最小间隔严格排队。
 */
let throttleChain = Promise.resolve()

/**
 * 调整 Civitai API 请求最小间隔（测试钩子）：
 * 测试环境置 0 避免 vitest 真实等待节流间隔。
 * @param {number} ms 间隔毫秒数
 */
export function setCivitaiApiInterval(ms) {
  civitaiApiIntervalMs =
    Number.isFinite(ms) && ms >= 0 ? ms : CIVITAI_API_MIN_INTERVAL_MS
}

/**
 * @param {number} ms 毫秒
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 全局节流：相邻 Civitai API 请求至少间隔 civitaiApiIntervalMs（串行排队） */
function throttleCivitaiApi() {
  const run = throttleChain.then(async () => {
    const wait = lastCivitaiApiAt + civitaiApiIntervalMs - Date.now()
    if (wait > 0) await sleep(wait)
    lastCivitaiApiAt = Date.now()
  })
  // 链本身吞掉异常，避免一次失败让后续请求永久排队
  throttleChain = run.catch(() => {})
  return run
}

// 重定向跟随（V-06 逐跳白名单）与 Electron "Redirect was cancelled"
// 兼容探测统一由 services/net-fetch.js 提供（单一实现），本模块仅以
// Civitai 白名单回调 + 会话 Cookie 凭据语义调用

/**
 * 发起 Civitai API JSON 请求（全局节流 + 双层退避重试）：
 * - 429 时按 Retry-After 等待后重试（无头兜底 60s，等待上限 90s），
 *   超出重试次数后把最后一次 429 响应交回调用方按 HTTP 错误处理；
 * - 连接级瞬时网络错误（ECONNRESET/ERR_NETWORK_CHANGED 等）退避后重试
 *   1 次（OPT-01 同款：响应到达前 fetch 拒绝，本次无任何业务副作用，重试
 *   幂等）；超时中止与非瞬时错误不重试，按既有语义交回调用方。瞬时重试
 *   与 429 重试独立计数——抖动后重试再遇限流仍可获得完整的 429 退避预算。
 * 超时按 attempt 独立计时（Civitai 429 修复）：在全局节流等待之后创建
 * AbortSignal.timeout，避免等待 Retry-After（最长 90s）后复用第一次请求
 * 已过期的 signal，使重试必然以 AbortError 失败。
 * @param {string} url API 地址
 * @param {object} [options] net.fetch 选项（signal 由本函数按 attempt 注入）
 * @returns {Promise<{response: Response, networkError?: undefined} | {networkError: Error, response?: undefined}>}
 *   两属性互斥：成功时仅 response，网络/超时失败时仅 networkError
 */
export async function fetchCivitaiApi(url, options = {}) {
  let transientRetries = 0
  for (let attempt = 0; ; attempt++) {
    await throttleCivitaiApi()
    let response
    try {
      response = await fetchWithValidatedRedirects(
        url,
        { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        isAllowedCivitaiApiUrl,
        'Civitai 请求',
        { useSessionCookies: true },
      )
    } catch (err) {
      if (
        transientRetries < CIVITAI_TRANSIENT_MAX_RETRIES &&
        isTransientNetworkError(err)
      ) {
        transientRetries += 1
        logger.warn(
          `Civitai API 连接级失败，${civitaiTransientRetryDelayMs}ms 后重试: ${errorMessage(err)}`,
        )
        await sleep(civitaiTransientRetryDelayMs)
        continue
      }
      return {
        networkError: err instanceof Error ? err : new Error(String(err)),
      }
    }
    if (response.status === 429 && attempt < CIVITAI_429_MAX_RETRIES) {
      cancelResponseBody(response)
      const ra = Number(response.headers.get('retry-after'))
      const waitSec =
        Number.isFinite(ra) && ra >= 0
          ? Math.min(ra, CIVITAI_429_MAX_WAIT_S)
          : CIVITAI_429_FALLBACK_WAIT_S
      logger.warn(
        `Civitai API 限流（429），${waitSec}s 后重试（第 ${attempt + 1}/${CIVITAI_429_MAX_RETRIES} 次）`,
      )
      await sleep(waitSec * 1000)
      continue
    }
    return { response }
  }
}
