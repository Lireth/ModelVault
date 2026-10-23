import { net } from 'electron'
import logger from '../logger'
import { readResponseBytesLimited, readResponseTextLimited } from '../utils'
import { computeFileHashOffThread } from './hash-worker-pool'

/**
 * Civitai 在线识别服务：
 * - 由模型文件流式计算 SHA256（复用元数据层的 hash/hashMtime 缓存字段），
 *   经 Civitai API 按哈希反查模型版本（by-hash 端点，社区通行做法）；
 * - 识别成功时生成 Civitai 页面 URL 与「一键补全」元数据补丁（纯函数）。
 * 网络请求走 Electron net.fetch（Chromium 网络栈，继承系统代理，项目约定，
 * 与 updater.js 同一模式）。本服务不做任何用户数据覆盖判断之外的写盘。
 */

const CIVITAI_API_BASE = 'https://civitai.com/api/v1'
/** 关闭 Civitai 开关时主进程统一拒绝文案（IPC 与 civimg 代理共用） */
export const CIVITAI_DISABLED_ERROR = 'Civitai 功能已关闭'
/** 请求超时（ms），与 updater.js 一致 */
const REQUEST_TIMEOUT_MS = 15000
/** 图片下载超时（ms）：示例图普遍数 MB，放宽到 30s */
const IMAGE_TIMEOUT_MS = 30000
/** 识别结果携带的示例图上限（Civitai 热门模型可达数百张，UI 无需全量） */
const MAX_IMAGES = 30
/** 示例图下载大小上限（与封面导入同一量级） */
const MAX_IMAGE_BYTES = 50 * 1024 * 1024
/** API JSON 响应上限（V-06）：正常响应含描述/图片列表也远小于此值 */
const MAX_API_JSON_BYTES = 8 * 1024 * 1024
/** 允许跟随的重定向次数上限（V-06：每一跳都重新校验白名单） */
const MAX_REDIRECTS = 3

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
  civitaiApiIntervalMs = Number.isFinite(ms) && ms >= 0 ? ms : CIVITAI_API_MIN_INTERVAL_MS
}

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

/** 是否为需要跟随的 HTTP 重定向状态 */
function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/**
 * 发起请求并手动跟随重定向（V-06）：
 * net.fetch 默认跟随 302 时只校验初始 URL，白名单主机可把请求引向任意
 * 站点。这里改为 redirect: 'manual'，每一跳都用 isAllowed 重新校验，
 * 超出次数上限即失败。
 * @param {string} url 初始 URL（调用方已校验）
 * @param {RequestInit} options fetch 选项
 * @param {(url: string) => boolean} isAllowed 每一跳的 URL 校验
 * @param {string} label 错误文案中的资源名
 * @returns {Promise<Response>} 最终响应
 */
async function fetchWithAllowedRedirects(url, options, isAllowed, label) {
  if (!isAllowed(url)) throw new Error(`${label}地址不在白名单内，已拒绝`)
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await net.fetch(current, { ...options, redirect: 'manual' })
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

/**
 * Civitai API 域名白名单（含子域）：API 初始地址固定，此校验只用于重定向。
 * @param {string} url 待校验 URL
 * @returns {boolean}
 */
function isAllowedCivitaiApiUrl(url) {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    return parsed.protocol === 'https:' && (host === 'civitai.com' || host.endsWith('.civitai.com'))
  } catch {
    return false
  }
}

/**
 * 发起 Civitai API JSON 请求（全局节流 + 429 退避重试）：
 * 429 时按 Retry-After 等待后重试（无头兜底 60s，等待上限 90s），
 * 超出重试次数后把最后一次 429 响应交回调用方按 HTTP 错误处理。
 * 超时按 attempt 独立计时（Civitai 429 修复）：在全局节流等待之后创建
 * AbortSignal.timeout，避免等待 Retry-After（最长 90s）后复用第一次请求
 * 已过期的 signal，使重试必然以 AbortError 失败。
 * @param {string} url API 地址
 * @param {object} [options] net.fetch 选项（signal 由本函数按 attempt 注入）
 * @returns {Promise<{response: Response} | {networkError: Error}>}
 */
async function fetchCivitaiApi(url, options = {}) {
  for (let attempt = 0; ; attempt++) {
    await throttleCivitaiApi()
    let response
    try {
      response = await fetchWithAllowedRedirects(
        url,
        { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        isAllowedCivitaiApiUrl,
        'Civitai 请求'
      )
    } catch (err) {
      return { networkError: err instanceof Error ? err : new Error(String(err)) }
    }
    if (response.status === 429 && attempt < CIVITAI_429_MAX_RETRIES) {
      const ra = Number(response.headers.get('retry-after'))
      const waitSec = Number.isFinite(ra) && ra >= 0 ? Math.min(ra, CIVITAI_429_MAX_WAIT_S) : CIVITAI_429_FALLBACK_WAIT_S
      logger.warn(`Civitai API 限流（429），${waitSec}s 后重试（第 ${attempt + 1}/${CIVITAI_429_MAX_RETRIES} 次）`)
      await sleep(waitSec * 1000)
      continue
    }
    return { response }
  }
}

/**
 * Civitai 示例图 CDN 域名白名单：API 响应中的图片 URL 不可信，
 * 下载入口仅放行官方 CDN 主机（防 SSRF/任意文件落盘）。
 */
const CIVITAI_IMAGE_HOSTS = new Set(['image.civitai.com'])

/**
 * 校验示例图 URL 是否允许下载（纯函数，便于单测）：
 * 必须 https 协议且主机命中 Civitai CDN 白名单。
 * @param {unknown} url 待校验 URL
 * @returns {boolean}
 */
export function isAllowedCivitaiImageUrl(url) {
  try {
    const parsed = new URL(String(url))
    return parsed.protocol === 'https:' && CIVITAI_IMAGE_HOSTS.has(parsed.host)
  } catch {
    return false
  }
}

/** 下载响应的 Content-Type → 封面文件扩展名 */
const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp'
}

/**
 * 流式计算文件 SHA256（hex 小写）——P1 改造后为线程池委托入口：
 * 模型文件普遍 1-10GB，读盘与哈希 CPU 工作整体运行在 worker_threads
 * （hash-worker-pool，串行队列），主进程事件循环在数 GB 哈希期间保持空闲。
 * 语义与原主进程实现一致：分块读取、进度按块回调、AbortSignal 取消抛
 * AbortError。
 * @param {string} filePath 文件绝对路径
 * @param {import('electron').AbortSignal} [signal] 取消信号（可选）
 * @param {(hashedBytes: number, totalBytes: number) => void} [onProgress]
 *   哈希进度回调（可选，每块读取后触发；预热链路据此推送进度标识）
 * @param {{priority?: boolean}} [options] priority=true 为前台任务（OPT-08）
 * @returns {Promise<string>} 64 位十六进制哈希
 */
export async function computeFileHash(filePath, signal, onProgress, options = {}) {
  return computeFileHashOffThread(filePath, signal, onProgress, options)
}

/**
 * 按文件 SHA256 查询 Civitai 模型版本信息。
 * @param {string} hash 64 位十六进制 SHA256
 * @returns {Promise<{found: boolean, info?: object, error?: string}>}
 *   found=false 且无 error 表示哈希未被收录（不是失败）；
 *   info 为规范化后的 { url, modelName, versionName, baseModel, trainedWords, description }
 */
export async function fetchCivitaiVersionByHash(hash) {
  const { response, networkError } = await fetchCivitaiApi(
    `${CIVITAI_API_BASE}/model-versions/by-hash/${hash}`,
    {
      headers: { 'User-Agent': 'ModelVault', Accept: 'application/json' }
    }
  )
  if (networkError) {
    if (networkError.name === 'TimeoutError' || networkError.name === 'AbortError') {
      return { found: false, error: '请求超时，请检查网络后重试' }
    }
    return { found: false, error: `网络请求失败: ${networkError.message}` }
  }
  if (response.status === 404) {
    // 哈希未收录：Civitai 无此模型（自训/其他来源），不是错误
    return { found: false }
  }
  if (!response.ok) {
    return { found: false, error: `Civitai 查询失败（HTTP ${response.status}）` }
  }
  let raw
  try {
    raw = JSON.parse(
      await readResponseTextLimited(response, MAX_API_JSON_BYTES, 'Civitai 响应')
    )
  } catch (err) {
    return { found: false, error: `响应解析失败: ${err.message}` }
  }
  const info = normalizeVersionInfo(raw)
  if (!info) {
    return { found: false, error: '响应数据格式异常' }
  }
  return { found: true, info }
}

/**
 * 由 by-hash 端点响应构造规范化信息与页面 URL（纯函数，便于单测）。
 * 页面链接格式与 Civitai 官方一致：/models/{modelId}?modelVersionId={versionId}。
 * 示例图仅保留静态图片（视频/混合媒体剔除），按 API 默认顺序（热度）截断。
 * @param {object} raw API 响应 JSON
 * @returns {object|null} { url, modelName, versionName, baseModel, trainedWords,
 *   description, images: [{url, width, height, nsfw}] }
 */
export function normalizeVersionInfo(raw) {
  if (!raw || typeof raw !== 'object') return null
  const modelId = Number.isFinite(raw.modelId) ? raw.modelId : raw?.model?.id
  const versionId = Number.isFinite(raw.id) ? raw.id : null
  if (!Number.isFinite(modelId) || !Number.isFinite(versionId)) return null
  const trainedWords = Array.isArray(raw.trainedWords)
    ? raw.trainedWords.filter((w) => typeof w === 'string' && w.trim()).map((w) => w.trim())
    : []
  const images = Array.isArray(raw.images)
    ? raw.images
        .filter((img) => img && typeof img === 'object' && img.type === 'image' &&
          typeof img.url === 'string' && img.url.startsWith('https://'))
        .slice(0, MAX_IMAGES)
        .map((img) => ({
          url: img.url,
          width: Number.isFinite(img.width) ? img.width : 0,
          height: Number.isFinite(img.height) ? img.height : 0,
          nsfw: img.nsfw === true || (Array.isArray(img.nsfwLevel) && img.nsfwLevel.length > 0)
        }))
    : []
  return {
    url: `https://civitai.com/models/${modelId}?modelVersionId=${versionId}`,
    modelName: typeof raw.model?.name === 'string' ? raw.model.name : '',
    versionName: typeof raw.name === 'string' ? raw.name : '',
    baseModel: typeof raw.baseModel === 'string' ? raw.baseModel : '',
    trainedWords,
    description: typeof raw.description === 'string' ? raw.description : '',
    images
  }
}

/**
 * 由 Civitai 模型页 URL 提取模型 id（纯函数，便于单测）：
 * 仅接受 https://civitai.com/models/{数字id} 形式（与元数据层
 * civitaiUrl 的写入校验同源），可选尾段（slug/query）忽略。
 * @param {string} url Civitai 模型页 URL
 * @returns {string|null} 模型 id 字符串，格式不符返回 null
 */
export function parseCivitaiModelId(url) {
  if (typeof url !== 'string') return null
  const m = url.match(/^https:\/\/civitai\.com\/models\/(\d+)(?:[/?#]|$)/)
  return m ? m[1] : null
}

/**
 * 按 Civitai 模型 id 查询模型信息（一键分配标签用）。
 * API 的 model.type 只有 Lora/Checkpoint 等模型种类，character/style 等
 * 7 类分类挂在 model.tags 里，一并返回供映射层回退查询。
 * @param {string} modelId Civitai 模型 id（parseCivitaiModelId 的结果）
 * @returns {Promise<{found: boolean, type?: string, tags?: string[], error?: string}>}
 *   found=false 且无 error 表示 id 不存在或已下架（不是失败）
 */
export async function fetchCivitaiModelType(modelId) {
  const { response, networkError } = await fetchCivitaiApi(
    `${CIVITAI_API_BASE}/models/${modelId}`,
    {
      headers: { 'User-Agent': 'ModelVault', Accept: 'application/json' }
    }
  )
  if (networkError) {
    if (networkError.name === 'TimeoutError' || networkError.name === 'AbortError') {
      return { found: false, error: '请求超时，请检查网络后重试' }
    }
    return { found: false, error: `网络请求失败: ${networkError.message}` }
  }
  if (response.status === 404) {
    return { found: false }
  }
  if (!response.ok) {
    return { found: false, error: `Civitai 查询失败（HTTP ${response.status}）` }
  }
  let raw
  try {
    raw = JSON.parse(
      await readResponseTextLimited(response, MAX_API_JSON_BYTES, 'Civitai 响应')
    )
  } catch (err) {
    return { found: false, error: `响应解析失败: ${err.message}` }
  }
  if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string' || !raw.type.trim()) {
    return { found: false, error: '响应数据格式异常' }
  }
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim())
    : []
  return { found: true, type: raw.type.trim(), tags }
}

/**
 * 剥离 Civitai 描述中的 HTML 标签并压缩空白（描述为富文本 HTML，
 * 备注为纯文本；实体仅处理常见命名实体，其余由浏览器渲染时自然容错）。
 * 纯函数，便于单测。
 * @param {string} html HTML 文本
 * @returns {string} 纯文本（已修剪）
 */
export function stripHtml(html) {
  if (typeof html !== 'string') return ''
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 由 Civitai 版本信息与当前元数据构造「一键补全」补丁（纯函数）：
 * 仅补空缺字段——触发词为空时导入 trainedWords，备注为空时导入描述纯文本，
 * 绝不覆盖任何用户已有标注（与 sidecar/civitai.info 导入同一原则）。
 * @param {object} meta 当前模型元数据（判空基准）
 * @param {object} info normalizeVersionInfo 的规范化结果
 * @returns {{patch: object, applied: string[]}} patch 可合并到元数据；
 *   applied 为实际补全的字段名列表（渲染层据此提示）
 */
export function civitaiCompletePatch(meta, info) {
  const patch = {}
  if (!info || typeof info !== 'object' || !meta) return { patch, applied: [] }
  if (!meta.triggerWords && info.trainedWords?.length > 0) {
    const words = info.trainedWords.join(', ').slice(0, 1000)
    if (words.trim()) {
      patch.triggerWords = words
    }
  }
  if (!meta.note && info.description) {
    const text = stripHtml(info.description).slice(0, 2000)
    if (text) {
      patch.note = text
    }
  }
  return { patch, applied: Object.keys(patch) }
}

/**
 * 发起 Civitai 图片请求（协议代理与导入下载共用）：
 * 不自定义 UA（保持 Electron 的 Chromium 默认 UA，规避 CDN 反爬挑战），
 * 携带 Referer 与 Accept 提高直连成功率。
 * 重定向改为手动跟随并逐跳校验 CDN 白名单（V-06），返回最终响应。
 * @param {string} url 已通过 isAllowedCivitaiImageUrl 校验的图片地址
 * @returns {Promise<Response>}
 */
export async function fetchCivitaiImage(url) {
  return fetchWithAllowedRedirects(
    url,
    {
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: 'https://civitai.com/'
      },
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS)
    },
    isAllowedCivitaiImageUrl,
    'Civitai 图片请求'
  )
}

/**
 * 读取 Civitai 图片响应体并强制大小上限（V-06）。
 * 协议代理与图片导入共用，避免任意大小响应进入主进程堆。
 * @param {Response} response fetch 响应
 * @returns {Promise<Buffer>} 图片字节
 */
export function readCivitaiImageBody(response) {
  return readResponseBytesLimited(response, MAX_IMAGE_BYTES, '图片内容')
}

/**
 * 下载 Civitai 示例图并做内容校验（仅下载白名单 CDN 的图片）。
 * 返回图片字节与按 Content-Type 推断的扩展名，落盘由封面保存层负责。
 * @param {string} url 图片 URL（必须命中 isAllowedCivitaiImageUrl）
 * @returns {Promise<{buf: Buffer, ext: string} | {error: string}>}
 */
export async function downloadCivitaiImage(url) {
  if (!isAllowedCivitaiImageUrl(url)) {
    return { error: '图片地址不在 Civitai CDN 白名单内，已拒绝下载' }
  }
  let response
  try {
    response = await fetchCivitaiImage(url)
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { error: '图片下载超时' }
    }
    return { error: `图片下载失败: ${err.message}` }
  }
  if (!response.ok) {
    return { error: `图片下载失败（HTTP ${response.status}）` }
  }
  let buf
  try {
    buf = await readCivitaiImageBody(response)
  } catch (err) {
    return { error: `图片内容读取失败: ${err.message}` }
  }
  if (buf.length === 0) {
    return { error: '图片内容为空' }
  }
  // 内容校验：按响应 Content-Type 推断扩展名，URL 路径扩展名兜底
  const mime = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  let ext = MIME_EXT[mime] || ''
  if (!ext) {
    const m = new URL(url).pathname.match(/\.(jpe?g|png|webp|gif|bmp)$/i)
    ext = m ? `.${m[1].toLowerCase().replace('jpeg', 'jpg')}` : '.jpg'
  }
  return { buf, ext }
}
