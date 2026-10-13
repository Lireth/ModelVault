import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { net } from 'electron'
import logger from '../logger'
import { abortError } from '../utils'

/**
 * Civitai 在线服务（F13/F14，远期战略功能）：
 * - matchByHash：按模型 SHA256 查询 modelVersion（AUTOV2 即 sha256 前 10 位，
 *   本服务始终用完整 64 位查询 /model-versions/by-hash），补全触发词/NSFW；
 * - parseCivitaiVersionId：模型页链接 → versionId（F14 下载入口）；
 * - fetchVersion：取版本详情（文件名/大小/官方 SHA256/下载地址）；
 * - downloadToFile：流式下载 + **下载中同步计算哈希**（一次读盘完成校验），
 *   与期望哈希不符即删文件报错（下载损坏/被篡改在此拦截）；
 * - downloadCoverImage：匹配结果的示例图落地封面目录（仅限 civitai 域）。
 *
 * 安全边界：
 * - 所有请求仅发往 civitai.com API（常量基址）；示例图 URL 来自 API 响应，
 *   落地前校验必须为 https 且主机为 civitai.com / *.civitai.com；
 * - 下载文件名强制 basename（防响应携带路径穿越段）；
 * - 封面图片走既有魔数校验与大小上限（covers.js）。
 * API Token 为可选项（设置页配置，明文存于本地 %APPDATA% settings.json，
 * 仅用于请求头 Authorization），NSFW 内容与部分下载须自备 Token。
 */

/** Civitai 公开 API 基址（导出供 IPC 层构造下载端点） */
export const CIVITAI_API = 'https://civitai.com/api/v1'

/** 单请求超时（ms） */
const REQUEST_TIMEOUT = 20000

/** 下载分块进度回调节流下限（ms）：流式分块频繁，进度最多 5 次/秒 */
const PROGRESS_INTERVAL = 200

/** 封面图片大小上限（与 covers.js 的 MAX_COVER_BYTES 保持一致量级） */
const COVER_MAX_BYTES = 50 * 1024 * 1024

/** 域名白名单校验：图片 URL 必须是 https 且主机为 civitai.com 或其子域 */
function isCivitaiHost(url) {
  try {
    const u = new URL(url)
    return (
      u.protocol === 'https:' &&
      (/^civitai\.com$/i.test(u.hostname) || /\.civitai\.com$/i.test(u.hostname))
    )
  } catch {
    return false
  }
}

/** 请求头（带可选 Token） */
function authHeaders(token) {
  const headers = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

/**
 * 通用 JSON GET（错误收敛：网络失败/非 2xx 不抛出，返回 { error }）。
 * @returns {Promise<{data?: object, notFound?: boolean, error?: string}>}
 */
async function fetchJson(url, token, signal) {
  try {
    const res = await net.fetch(url, {
      headers: authHeaders(token),
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT)
    })
    if (res.status === 404) return { notFound: true }
    if (!res.ok) return { error: `HTTP ${res.status}` }
    return { data: await res.json() }
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    return { error: err.message }
  }
}

/**
 * 从 API 响应裁剪出稳定形态（纯函数）：
 * 仅保留本应用消费的字段，屏蔽上游结构变化的波及面。
 * @param {object} raw /model-versions/by-hash 响应
 */
export function normalizeVersion(raw) {
  if (!raw || typeof raw !== 'object') return null
  const model = raw.model || {}
  const images = Array.isArray(raw.images) ? raw.images : []
  return {
    versionId: Number.isFinite(raw.id) ? raw.id : null,
    name: typeof raw.name === 'string' ? raw.name : '',
    baseModel: typeof raw.baseModel === 'string' ? raw.baseModel : '',
    trainedWords: Array.isArray(raw.trainedWords)
      ? raw.trainedWords.filter((w) => typeof w === 'string' && w.trim())
      : [],
    nsfw: raw.nsfw === true,
    modelName: typeof model.name === 'string' ? model.name : '',
    creator: model.creator?.username || '',
    /** 示例图 URL 列表（仅保留域名合法项，保持 API 顺序——SFW 已由 API 排前） */
    imageUrls: images
      .map((img) => (img && typeof img.url === 'string' ? img.url : ''))
      .filter((u) => u && isCivitaiHost(u))
  }
}

/**
 * 按完整 SHA256 匹配 Civitai modelVersion（F13）。
 * @param {string} sha256 64 位小写哈希
 * @returns {Promise<{matched: true, version: object} | {matched: false} | {error: string}>}
 */
export async function matchByHash(sha256, token, signal) {
  if (!/^[0-9a-f]{64}$/.test(sha256 || '')) return { error: '无效的哈希' }
  const r = await fetchJson(`${CIVITAI_API}/model-versions/by-hash/${sha256}`, token, signal)
  if (r.notFound) return { matched: false }
  if (r.error) return { error: r.error }
  const version = normalizeVersion(r.data)
  if (!version) return { matched: false }
  return { matched: true, version }
}

/**
 * 解析 Civitai 模型页链接为 versionId（纯函数，F14）：
 * 支持 https://civitai.com/models/{modelId}?modelVersionId={vid}
 * 与 https://civitai.com/models/{modelId}/{vid} 两种形态。
 * @returns {number|null} 无效返回 null
 */
export function parseCivitaiVersionId(url) {
  if (typeof url !== 'string') return null
  let parsed
  try {
    parsed = new URL(url.trim())
  } catch {
    return null
  }
  if (!isCivitaiHost(parsed.href)) return null
  const m = /^\/models\/(\d+)(?:\/(\d+))?/.exec(parsed.pathname)
  if (!m) return null
  if (m[2]) return Number(m[2])
  const qv = parsed.searchParams.get('modelVersionId')
  return qv && /^\d+$/.test(qv) ? Number(qv) : null
}

/**
 * 从版本文件列表挑选下载目标（纯函数）：优先 primary 的模型文件。
 * @param {object} raw /model-versions/{id} 响应
 * @returns {{filename: string, sizeBytes: number, sha256: string} | null}
 */
export function pickVersionFile(raw) {
  const files = Array.isArray(raw?.files) ? raw.files : []
  const modelFiles = files.filter(
    (f) => f && typeof f.name === 'string' && /\.safetensors$/i.test(f.name)
  )
  const chosen = modelFiles.find((f) => f.primary === true) || modelFiles[0]
  if (!chosen) return null
  const sha = typeof chosen.hashes?.SHA256 === 'string' ? chosen.hashes.SHA256.toLowerCase() : ''
  return {
    filename: path.basename(chosen.name), // 防 API 响应携带路径段
    sizeBytes: Number.isFinite(chosen.size) ? chosen.size : 0,
    sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : ''
  }
}

/**
 * 取版本详情（F14 预览与下载依据）。
 * @returns {Promise<{version: object} | {error: string}>}
 */
export async function fetchVersion(versionId, token, signal) {
  if (!Number.isInteger(versionId) || versionId <= 0) return { error: '无效的版本号' }
  const r = await fetchJson(`${CIVITAI_API}/model-versions/${versionId}`, token, signal)
  if (r.notFound) return { error: '版本不存在' }
  if (r.error) return { error: r.error }
  const version = normalizeVersion(r.data)
  if (!version) return { error: '响应无法解析' }
  const file = pickVersionFile(r.data)
  if (!file) return { error: '该版本没有可下载的模型文件' }
  version.versionId = versionId
  return { version: { ...version, ...file } }
}

/**
 * 流式下载到目标路径（F14）：
 * - 'wx' 打开：目标已存在时直接失败（绝不覆盖用户文件）；
 * - 下载分块同步喂入 SHA256：下载完成即得摘要，与期望值不符删文件抛错
 *   （省去二次读盘校验 GB 级文件）；
 * - 任何失败（含取消/哈希不符）清理半成品文件。
 * @param {string} url 下载地址（civitai 域）
 * @param {string} destPath 目标绝对路径
 * @param {{token?: string, expectedSha256?: string, onProgress?: (p: {received: number, total: number}) => void, signal?: AbortSignal}} opts
 * @returns {Promise<{received: number, sha256: string}>}
 */
export async function downloadToFile(url, destPath, opts = {}) {
  if (!isCivitaiHost(url)) throw new Error('下载地址不在允许的域名内')
  const headers = {}
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  let res
  try {
    res = await net.fetch(url, { headers, signal: opts.signal })
  } catch (err) {
    throw err?.name === 'AbortError' ? err : new Error(`下载请求失败: ${err.message}`)
  }
  if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || 0
  const fh = await fs.open(destPath, 'wx')
  const hash = createHash('sha256')
  let received = 0
  let lastProgressAt = 0
  try {
    const reader = res.body.getReader()
    for (;;) {
      if (opts.signal?.aborted) throw abortError()
      const { done, value } = await reader.read()
      if (done) break
      const buf = Buffer.from(value)
      hash.update(buf)
      await fh.write(buf)
      received += buf.byteLength
      const now = Date.now()
      if (opts.onProgress && now - lastProgressAt >= PROGRESS_INTERVAL) {
        lastProgressAt = now
        opts.onProgress({ received, total })
      }
    }
    const sha256 = hash.digest('hex')
    if (opts.expectedSha256 && sha256 !== opts.expectedSha256) {
      throw new Error('哈希校验失败：下载内容与官方 SHA256 不符（可能下载损坏），已丢弃')
    }
    opts.onProgress?.({ received, total: total || received })
    return { received, sha256 }
  } catch (err) {
    // 半成品不留：失败/取消/哈希不符一律清理
    await fs.rm(destPath, { force: true }).catch(() => {})
    logger.warn(`模型下载未完成，已清理: ${destPath} ${err.message}`)
    throw err
  } finally {
    await fh.close().catch(() => {})
  }
}

/**
 * 下载匹配结果的示例图为封面（F13）：仅当元数据尚无任何封面时调用
 * （「空字段才写入」原则）。落地为临时文件后经魔数校验转正，
 * 不通过则删除（响应可能是错误页 HTML）。
 * @returns {Promise<string>} 封面绝对路径；失败返回 ''
 */
export async function downloadCoverImage(imageUrl, coversDir, hasImageMagic, opts = {}) {
  if (!isCivitaiHost(imageUrl)) return ''
  try {
    const headers = {}
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`
    const res = await net.fetch(imageUrl, {
      headers,
      signal: opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT)
    })
    if (!res.ok) return ''
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength === 0 || buf.byteLength > COVER_MAX_BYTES) return ''
    const urlPath = new URL(imageUrl).pathname
    const ext = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(
      path.extname(urlPath).toLowerCase()
    )
      ? path.extname(urlPath).toLowerCase()
      : '.png'
    const tmp = path.join(coversDir, `${Date.now()}-civitai-tmp${ext}`)
    await fs.mkdir(coversDir, { recursive: true })
    await fs.writeFile(tmp, buf)
    if (!(await hasImageMagic(tmp))) {
      await fs.rm(tmp, { force: true }).catch(() => {})
      return ''
    }
    const finalPath = path.join(coversDir, `${Date.now()}-civitai${ext}`)
    await fs.rename(tmp, finalPath)
    return finalPath
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    logger.warn(`封面下载失败（跳过）: ${err.message}`)
    return ''
  }
}
