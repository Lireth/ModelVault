/**
 * 网络边界原语：
 * 外链白名单校验与响应体读取上限（含逐段空闲超时）。
 */

/**
 * 允许 shell.openExternal 拉起的域名白名单（B3）：
 * 应用外链出口为设置页的 GitHub 下载页与详情页的 Civitai 模型页
 * （civitai.red 为识别站点，civitai.com 兼容历史数据中的旧链接），
 * 新增外链场景时在此显式登记具体域名——禁止通配、禁止子域放行
 * （用户信息段伪装 github.com@evil.com 与外形相似域名
 * github.com.evil.com 均会因真实主机不匹配而被拒绝）。
 */
const ALLOWED_EXTERNAL_HOSTS = new Set([
  'github.com',
  'civitai.com',
  'civitai.red',
])

/**
 * 校验外部 URL 是否允许经 shell.openExternal 拉起（B3）：
 * 必须是 https 协议且主机名（含端口）命中白名单。
 * 主进程两个拉起入口共用本收口：setWindowOpenHandler（渲染进程
 * 可控的 window.open）与 updater 的下载页地址（上游 API 响应）。
 * @param {unknown} url 待校验 URL
 * @returns {boolean} 允许拉起返回 true
 */
export function isAllowedExternalUrl(url) {
  // 非字符串（渲染层可控入参/上游异常响应）一律拒绝，与解析失败同一语义
  if (typeof url !== 'string') return false
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'https:' && ALLOWED_EXTERNAL_HOSTS.has(parsed.host)
    )
  } catch {
    return false
  }
}

/** 字节上限的人类可读文案（错误提示用） */
function formatByteLimit(bytes) {
  return bytes >= 1024 * 1024
    ? `${Math.floor(bytes / 1024 / 1024)}MB`
    : `${Math.floor(bytes / 1024)}KB`
}

/**
 * 为单次异步读取套「空闲超时」（OPT-17①）：大体积响应体不能按总量计时
 * （慢链路的合法耗时远超任何总量阈值，必然假性超时），也不能不设防
 * （TCP 停滞时读取永久悬挂）。每收到一段字节由调用方对下一段读取重新
 * 调用本函数，即实现空闲计时逐段重置——持续传输时永不触发。
 * 超时先触发 onCancel（调用方用于取消底层流/读取器），再抛出
 * name=TimeoutError 的错误。
 * @template T
 * @param {Promise<T>} promise 单次异步读取
 * @param {number} ms 空闲上限（毫秒）
 * @param {string} message 超时错误文案
 * @param {() => void} [onCancel] 超时时的底层清理（如 reader.cancel()）
 * @returns {Promise<T>}
 */
export function raceIdleTimeout(promise, ms, message, onCancel) {
  let timer = null
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(message)
        err.name = 'TimeoutError'
        // 先落定竞速再清理：onCancel（如 reader.cancel()）会以 {done:true}
        // 落定挂起的读取——若先执行，竞速会被「正常完成」抢先判胜，
        // 停滞中止退化为静默提前结束
        reject(err)
        try {
          onCancel?.()
        } catch {
          /* 清理失败不影响中止 */
        }
      }, ms)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * 读取响应体并强制字节上限（V-06 网络边界）：
 * 先看 Content-Length 提前拒绝，再流式累计实际字节——上游缺失/伪造
 * Content-Length 时仍会在超限处取消读取，避免整包进入主进程堆。
 * @param {Response} response fetch 响应
 * @param {number} maxBytes 允许的最大字节数
 * @param {string} [label] 错误文案中的资源名
 * @param {{idleTimeoutMs?: number}} [options] 空闲超时（OPT-17①）：每收到
 *   一段字节重置；超过时限判定连接停滞，取消读取并抛 TimeoutError。
 *   不传则保持原语义（由调用方的请求级 signal 兜底）
 * @returns {Promise<Buffer>} 不超过上限的响应内容
 */
export async function readResponseBytesLimited(
  response,
  maxBytes,
  label = '响应',
  { idleTimeoutMs = 0 } = {},
) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`${label}过大（上限 ${formatByteLimit(maxBytes)}）`)
  }
  if (!response.body) {
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > maxBytes) {
      throw new Error(`${label}过大（上限 ${formatByteLimit(maxBytes)}）`)
    }
    return buf
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      // OPT-17①：逐段空闲计时——持续到达的数据不断重置，停滞即中止；
      // 未启用空闲超时（idleTimeoutMs<=0）时保持原语义
      const { done, value } =
        idleTimeoutMs > 0
          ? await raceIdleTimeout(
              reader.read(),
              idleTimeoutMs,
              `${label}停滞超过 ${Math.round(idleTimeoutMs / 1000)}s 无数据，已中止`,
              () => {
                reader.cancel().catch(() => {})
              },
            )
          : await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error(`${label}过大（上限 ${formatByteLimit(maxBytes)}）`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* 读取已结束时释放锁可能抛错，忽略 */
    }
  }
  return Buffer.concat(chunks, total)
}

/**
 * 读取文本响应并强制字节上限（语义同 readResponseBytesLimited）。
 * @param {Response} response fetch 响应
 * @param {number} maxBytes 允许的最大字节数
 * @param {string} [label] 错误文案中的资源名
 * @returns {Promise<string>} UTF-8 文本
 */
export async function readResponseTextLimited(
  response,
  maxBytes,
  label = '响应',
) {
  return (await readResponseBytesLimited(response, maxBytes, label)).toString(
    'utf8',
  )
}
