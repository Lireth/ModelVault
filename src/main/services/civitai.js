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
/** 流式哈希的读取块大小（8MB：大文件吞吐与内存占用的平衡点） */
const HASH_CHUNK_SIZE = 8 * 1024 * 1024

/**
 * 流式计算文件 SHA256（hex 小写）。
 * 模型文件普遍 1-10GB，必须分块读取避免一次性载入内存。
 * @param {string} filePath 文件绝对路径
 * @param {import('electron').AbortSignal} [signal] 取消信号（可选）
 * @returns {Promise<string>} 64 位十六进制哈希
 */
export async function computeFileHash(filePath, signal) {
  const handle = await fs.open(filePath, 'r')
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(HASH_CHUNK_SIZE)
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
 * @param {object} raw API 响应 JSON
 * @returns {object|null} { url, modelName, versionName, baseModel, trainedWords, description }
 */
export function normalizeVersionInfo(raw) {
  if (!raw || typeof raw !== 'object') return null
  const modelId = Number.isFinite(raw.modelId) ? raw.modelId : raw?.model?.id
  const versionId = Number.isFinite(raw.id) ? raw.id : null
  if (!Number.isFinite(modelId) || !Number.isFinite(versionId)) return null
  const trainedWords = Array.isArray(raw.trainedWords)
    ? raw.trainedWords.filter((w) => typeof w === 'string' && w.trim()).map((w) => w.trim())
    : []
  return {
    url: `https://civitai.com/models/${modelId}?modelVersionId=${versionId}`,
    modelName: typeof raw.model?.name === 'string' ? raw.model.name : '',
    versionName: typeof raw.name === 'string' ? raw.name : '',
    baseModel: typeof raw.baseModel === 'string' ? raw.baseModel : '',
    trainedWords,
    description: typeof raw.description === 'string' ? raw.description : ''
  }
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
