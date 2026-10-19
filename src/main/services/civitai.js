import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { net } from 'electron'

/**
 * Civitai 在线识别服务：
 * - 由模型文件流式计算 SHA256（复用元数据层的 hash/hashMtime 缓存字段），
 *   经 Civitai API 按哈希反查模型版本（by-hash 端点，社区通行做法）；
 * - 识别成功时生成 Civitai 页面 URL 与「一键补全」元数据补丁（纯函数）。
 * 网络请求走 Electron net.fetch（Chromium 网络栈，继承系统代理，项目约定，
 * 与 updater.js 同一模式）。本服务不做任何用户数据覆盖判断之外的写盘。
 */

const CIVITAI_API_BASE = 'https://civitai.com/api/v1'
/** 请求超时（ms），与 updater.js 一致 */
const REQUEST_TIMEOUT_MS = 15000
/** 图片下载超时（ms）：示例图普遍数 MB，放宽到 30s */
const IMAGE_TIMEOUT_MS = 30000
/** 流式哈希的读取块大小（8MB：大文件吞吐与内存占用的平衡点） */
const HASH_CHUNK_SIZE = 8 * 1024 * 1024
/** 识别结果携带的示例图上限（Civitai 热门模型可达数百张，UI 无需全量） */
const MAX_IMAGES = 30
/** 示例图下载大小上限（与封面导入同一量级） */
const MAX_IMAGE_BYTES = 50 * 1024 * 1024

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
 * 流式计算文件 SHA256（hex 小写）。
 * 模型文件普遍 1-10GB，必须分块读取避免一次性载入内存。
 * @param {string} filePath 文件绝对路径
 * @param {import('electron').AbortSignal} [signal] 取消信号（可选）
 * @param {(hashedBytes: number, totalBytes: number) => void} [onProgress]
 *   哈希进度回调（可选，每块读取后触发；预热链路据此推送进度标识）
 * @returns {Promise<string>} 64 位十六进制哈希
 */
export async function computeFileHash(filePath, signal, onProgress) {
  const handle = await fs.open(filePath, 'r')
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(HASH_CHUNK_SIZE)
    const totalBytes = (await handle.stat()).size
    let position = 0
    for (;;) {
      if (signal?.aborted) {
        const err = new Error('已取消')
        err.name = 'AbortError'
        throw err
      }
      const { bytesRead } = await handle.read(buffer, 0, HASH_CHUNK_SIZE, position)
      if (bytesRead === 0) break
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
      if (typeof onProgress === 'function') {
        onProgress(position, totalBytes)
      }
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

/**
 * 按文件 SHA256 查询 Civitai 模型版本信息。
 * @param {string} hash 64 位十六进制 SHA256
 * @returns {Promise<{found: boolean, info?: object, error?: string}>}
 *   found=false 且无 error 表示哈希未被收录（不是失败）；
 *   info 为规范化后的 { url, modelName, versionName, baseModel, trainedWords, description }
 */
export async function fetchCivitaiVersionByHash(hash) {
  let response
  try {
    response = await net.fetch(`${CIVITAI_API_BASE}/model-versions/by-hash/${hash}`, {
      headers: { 'User-Agent': 'ModelVault', Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { found: false, error: '请求超时，请检查网络后重试' }
    }
    return { found: false, error: `网络请求失败: ${err.message}` }
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
    raw = await response.json()
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
  let response
  try {
    response = await net.fetch(`${CIVITAI_API_BASE}/models/${modelId}`, {
      headers: { 'User-Agent': 'ModelVault', Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { found: false, error: '请求超时，请检查网络后重试' }
    }
    return { found: false, error: `网络请求失败: ${err.message}` }
  }
  if (response.status === 404) {
    return { found: false }
  }
  if (!response.ok) {
    return { found: false, error: `Civitai 查询失败（HTTP ${response.status}）` }
  }
  let raw
  try {
    raw = await response.json()
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
 * @param {string} url 已通过 isAllowedCivitaiImageUrl 校验的图片地址
 * @returns {Promise<Response>}
 */
export function fetchCivitaiImage(url) {
  return net.fetch(url, {
    headers: {
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      Referer: 'https://civitai.com/'
    },
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS)
  })
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
    buf = Buffer.from(await response.arrayBuffer())
  } catch (err) {
    return { error: `图片内容读取失败: ${err.message}` }
  }
  if (buf.length === 0) {
    return { error: '图片内容为空' }
  }
  if (buf.length > MAX_IMAGE_BYTES) {
    return { error: `图片过大（上限 ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB）` }
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
