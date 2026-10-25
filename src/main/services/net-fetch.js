import { net } from 'electron'

/**
 * 跨服务共享的网络请求基元（V-06 逐跳白名单的单一实现）：
 * 此前「手动跟随重定向 + Electron 兼容探测」在 civitai.js 与
 * update-download.js 各有一份逐字实现（civitai 侧重定向兼容探测先行，
 * 更新链路为修复更新必坏的重定向问题后补），两份常量与样板各自漂移
 * （超时 10s/15s、跳数 3/5、isRedirectStatus 双份），安全关键路径双份
 * 维护易失同步。收敛后：
 * - fetchWithValidatedRedirects：手动跟随重定向 + 每跳 isAllowed 校验 +
 *   Electron "Redirect was cancelled" 时经 net.request 探测跳转目标；
 * - isTransientNetworkError：连接级瞬时错误特征（更新链路安全重试用）；
 * - REQUEST_TIMEOUT_MS / MAX_REDIRECTS：统一常量（原 civitai 3 跳放宽
 *   为统一的 5 跳，原 updater 10s 超时放宽为统一的 15s，均为安全方向）。
 */

/** 通用请求超时（ms）：API 查询/校验和等小体积请求的统一基线 */
export const REQUEST_TIMEOUT_MS = 15000
/** 手动重定向跟随的最大跳数（每一跳都过白名单校验） */
export const MAX_REDIRECTS = 5

/** 是否为需要跟随的 HTTP 重定向状态 */
function isRedirectStatus(status) {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  )
}

/** Electron 网络栈对 fetch manual 重定向不支持时的特征错误 */
function isRedirectCancelledError(err) {
  return err instanceof Error && err.message.includes('Redirect was cancelled')
}

/**
 * 探测一跳重定向目标（Electron 兼容层）：
 * net.fetch 的 redirect:'manual' 在 Electron 网络栈中不被支持——上游返回
 * 3xx 时直接以 "Redirect was cancelled"（ERR_REDIRECT_CANCELLED）抛错，
 * 而非规范语义的不透明响应（Location 不可读）。这里改用 net.request 的
 * manual 模式：redirect 事件读出跳转目标后立即取消请求，主传输仍走
 * net.fetch（流式 body / 超时/续传信号语义不变）。
 * @param {string} url 当前跳点 URL（调用方已校验白名单）
 * @param {RequestInit} options 与主请求一致的选项（headers/signal）
 * @param {boolean} useSessionCookies 探测是否携带会话 Cookie（凭据语义
 *   由调用方决定：Civitai 图片 CDN 需要会话态，GitHub 公开资产不需要）
 * @returns {Promise<{status: number, location: string, headers: Headers}>}
 */
function probeRedirectTarget(url, options, useSessionCookies) {
  return new Promise((resolve, reject) => {
    // HeadersInit → net.request 要求的普通头记录（Accept/Referer 等简单值，
    // 单值字符串化即可；探测请求不携带 body，无多值头语义）
    const headersRecord = {}
    for (const [name, value] of new Headers(options.headers || {})) {
      headersRecord[name] = value
    }
    const request = net.request({
      method: 'GET',
      url,
      redirect: 'manual',
      useSessionCookies,
      headers: headersRecord,
    })
    let settled = false
    const finish = (ok, value) => {
      if (settled) return
      settled = true
      ok ? resolve(value) : reject(value)
    }
    /** Electron 响应头对象（Record<string, string|string[]>）→ Headers */
    const headersOf = (record) => {
      const headers = new Headers()
      for (const [name, values] of Object.entries(record || {})) {
        for (const value of [].concat(values)) headers.append(name, value)
      }
      return headers
    }
    request.on(
      'redirect',
      (statusCode, _method, redirectUrl, responseHeaders) => {
        const headers = headersOf(responseHeaders)
        // ClientRequest 的取消方法是 abort（无 cancel/destroy；用可选链防御
        // Electron 版本 API 差异，避免事件处理器内抛错演变成主进程致命错误）
        request.abort?.()
        finish(true, {
          status: statusCode,
          location: headers.get('location') || redirectUrl || '',
          headers,
        })
      },
    )
    request.on('response', (incoming) => {
      // 未发 redirect 事件直接拿到响应（3xx 且无跳转目标等）：按终态返回空体
      // （IncomingMessage 无 destroy 方法，经 request.abort 中止 body 传输）
      request.abort?.()
      finish(true, {
        status: incoming.statusCode || 0,
        location: '',
        headers: headersOf(incoming.headers),
      })
    })
    request.on('error', (err) => finish(false, err))
    const { signal } = options
    if (signal) {
      if (signal.aborted) {
        request.abort?.()
        finish(false, new DOMException('已终止', 'AbortError'))
        return
      }
      signal.addEventListener(
        'abort',
        () => {
          request.abort?.()
          finish(false, new DOMException('已终止', 'AbortError'))
        },
        { once: true },
      )
    }
    request.end()
  })
}

/**
 * 发起请求并手动跟随重定向（V-06 单一实现）：
 * net.fetch 默认跟随 302 时只校验初始 URL，白名单主机可把请求引向任意
 * 站点。这里改为 redirect: 'manual'，每一跳都用 isAllowed 重新校验，
 * 超出次数上限即失败。Electron 网络栈对 manual 模式不支持（3xx 直接抛
 * "Redirect was cancelled"，Location 不可读），此时经 probeRedirectTarget
 * 探测跳转目标后逐跳继续。
 * @param {string} url 初始 URL（调用方已校验）
 * @param {RequestInit} options fetch 选项
 * @param {(url: string) => boolean} isAllowed 每一跳的 URL 校验
 * @param {string} label 错误文案中的资源名（如 'Civitai 图片请求'/'更新下载'）
 * @param {{useSessionCookies?: boolean}} [opts] 探测请求的凭据语义
 * @returns {Promise<Response>} 最终响应
 */
export async function fetchWithValidatedRedirects(
  url,
  options,
  isAllowed,
  label,
  opts = {},
) {
  const useSessionCookies = opts.useSessionCookies === true
  if (!isAllowed(url)) throw new Error(`${label}地址不在白名单内，已拒绝`)
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response
    try {
      response = await net.fetch(current, { ...options, redirect: 'manual' })
    } catch (err) {
      if (!isRedirectCancelledError(err)) throw err
      const probe = await probeRedirectTarget(
        current,
        options,
        useSessionCookies,
      )
      // 无跳转目标的 3xx 按终态响应处理（调用方按非 ok 分支报错，与
      // 规范的 manual 语义一致；body 恒为空——3xx 本就无有效载荷）
      response = new Response('', {
        status: probe.status,
        headers: probe.headers,
      })
    }
    if (!isRedirectStatus(response.status)) return response
    const location = response.headers.get('location')
    if (!location) return response
    const next = new URL(location, current).toString()
    if (!isAllowed(next)) {
      throw new Error(`${label}重定向目标不在白名单内，已拒绝`)
    }
    current = next
  }
  throw new Error(`${label}重定向次数过多，已拒绝`)
}

/** 连接级瞬时错误特征（请求未建立或被重置，重试无副作用） */
const TRANSIENT_NET_MARKS = [
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_CLOSED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_TIMED_OUT',
  'ERR_NETWORK_CHANGED',
  'ERR_ADDRESS_UNREACHABLE',
]

/**
 * 是否为连接级瞬时网络错误（可安全重试）：
 * 只匹配连接建立/重置类特征，不含超时中止（重试会成倍拉长等待，由
 * 调用方按自身语义决定）与 4xx/5xx（服务端响应，非网络层失败）。
 * @param {unknown} err 捕获的错误（可能带 cause 链）
 * @returns {boolean}
 */
export function isTransientNetworkError(err) {
  if (!(err instanceof Error)) return false
  // errno 类错误码不在 Error 标准类型上、cause 为 unknown（Node 网络栈
  // 可能抛 Error + {code} / Error + cause:{code,message} 两种形态），
  // 逐字段安全取值后拼接待匹配文本
  const errWithCode = /** @type {Error & {code?: unknown}} */ (err)
  const causeRaw = errWithCode.cause
  const cause =
    causeRaw && typeof causeRaw === 'object'
      ? /** @type {{code?: unknown, message?: unknown}} */ (causeRaw)
      : {}
  const text = (v) => (typeof v === 'string' ? v : '')
  const haystack = `${err.message} ${text(errWithCode.code)} ${text(cause.code)} ${text(cause.message)}`
  return TRANSIENT_NET_MARKS.some((mark) => haystack.includes(mark))
}
