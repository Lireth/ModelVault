/**
 * Civitai API 反查与查询：
 * by-hash 版本反查、按模型 id 查询类型/标签，及响应规范化纯函数；
 * 请求统一走 throttle.js 的节流 + 退避重试入口。
 */

import { readResponseTextLimited } from '../../utils'
import { errorMessage } from '../../../shared/error-text'
import { fetchCivitaiApi } from './throttle'

const CIVITAI_API_BASE = 'https://civitai.red/api/v1'
/** 识别结果携带的示例图上限（Civitai 热门模型可达数百张，UI 无需全量） */
const MAX_IMAGES = 30
/** API JSON 响应上限（V-06）：正常响应含描述/图片列表也远小于此值 */
const MAX_API_JSON_BYTES = 8 * 1024 * 1024

/**
 * 按文件 SHA256 查询 Civitai 模型版本信息。
 * @param {string} hash 64 位十六进制 SHA256
 * @returns {Promise<any>} found=false 且无 error 表示哈希未被收录（不是失败）；
 *   info 为规范化后的 { url, modelName, versionName, baseModel, trainedWords,
 *   description, images, videos }
 */
export async function fetchCivitaiVersionByHash(hash) {
  const result = await fetchCivitaiApi(
    `${CIVITAI_API_BASE}/model-versions/by-hash/${hash}`,
    {
      headers: { 'User-Agent': 'ModelVault', Accept: 'application/json' },
    },
  )
  if (result.networkError) {
    if (
      result.networkError.name === 'TimeoutError' ||
      result.networkError.name === 'AbortError'
    ) {
      return { found: false, error: '请求超时，请检查网络后重试' }
    }
    return {
      found: false,
      error: `网络请求失败: ${result.networkError.message}`,
    }
  }
  const response = result.response
  if (response.status === 404) {
    // 哈希未收录：Civitai 无此模型（自训/其他来源），不是错误
    return { found: false }
  }
  if (!response.ok) {
    return {
      found: false,
      error: `Civitai 查询失败（HTTP ${response.status}）`,
    }
  }
  let raw
  try {
    raw = JSON.parse(
      await readResponseTextLimited(
        response,
        MAX_API_JSON_BYTES,
        'Civitai 响应',
      ),
    )
  } catch (err) {
    return { found: false, error: `响应解析失败: ${errorMessage(err)}` }
  }
  const info = normalizeVersionInfo(raw)
  if (!info) {
    return { found: false, error: '响应数据格式异常' }
  }
  return { found: true, info }
}

/**
 * by-hash 端点响应经 normalizeVersionInfo 规范化后的信息结构
 * @typedef {object} CivitaiVersionInfo
 * @property {string} url 模型页链接（/models/{modelId}?modelVersionId={versionId}）
 * @property {string} modelName 模型名
 * @property {string} versionName 版本名
 * @property {string} baseModel 基底模型
 * @property {string[]} trainedWords 触发词
 * @property {string} description 描述（富文本 HTML 原文）
 * @property {{url: string, width: number, height: number, nsfw: boolean}[]} images 示例图片
 * @property {{url: string, thumbnailUrl: string, width: number, height: number, nsfw: boolean}[]} videos 示例视频
 */

/**
 * 由 by-hash 端点响应构造规范化信息与页面 URL（纯函数，便于单测）。
 * 页面链接格式与 Civitai 官方一致：/models/{modelId}?modelVersionId={versionId}。
 * 示例媒体按 API 默认顺序（热度）截断；图片与视频分别输出
 * （FN-02：视频用于详情页预览播放，不参与封面导入）。
 * @param {Record<string, any>} raw API 响应 JSON（逐字段运行时校验，不可信输入）
 * @returns {CivitaiVersionInfo|null}
 */
export function normalizeVersionInfo(raw) {
  if (!raw || typeof raw !== 'object') return null
  const modelId = Number.isFinite(raw.modelId) ? raw.modelId : raw?.model?.id
  const versionId = Number.isFinite(raw.id) ? raw.id : null
  if (!Number.isFinite(modelId) || !Number.isFinite(versionId)) return null
  const trainedWords = Array.isArray(raw.trainedWords)
    ? raw.trainedWords
        .filter((w) => typeof w === 'string' && w.trim())
        .map((w) => w.trim())
    : []
  const media = Array.isArray(raw.images)
    ? raw.images
        .filter(
          (item) =>
            item &&
            typeof item === 'object' &&
            (item.type === 'image' || item.type === 'video') &&
            typeof item.url === 'string' &&
            item.url.startsWith('https://'),
        )
        .slice(0, MAX_IMAGES)
    : []
  const images = media
    .filter((item) => item.type === 'image')
    .map((img) => ({
      url: img.url,
      width: Number.isFinite(img.width) ? img.width : 0,
      height: Number.isFinite(img.height) ? img.height : 0,
      nsfw:
        img.nsfw === true ||
        (Array.isArray(img.nsfwLevel) && img.nsfwLevel.length > 0),
    }))
  const videos = media
    .filter((item) => item.type === 'video')
    .map((video) => ({
      url: video.url,
      width: Number.isFinite(video.width) ? video.width : 0,
      height: Number.isFinite(video.height) ? video.height : 0,
      nsfw:
        video.nsfw === true ||
        (Array.isArray(video.nsfwLevel) && video.nsfwLevel.length > 0),
      // Civitai 部分视频条目提供缩略图；不可信 URL 仅接受 https 字符串
      thumbnailUrl:
        typeof video.thumbnailUrl === 'string' &&
        video.thumbnailUrl.startsWith('https://')
          ? video.thumbnailUrl
          : '',
    }))
  return {
    url: `https://civitai.red/models/${modelId}?modelVersionId=${versionId}`,
    modelName: typeof raw.model?.name === 'string' ? raw.model.name : '',
    versionName: typeof raw.name === 'string' ? raw.name : '',
    baseModel: typeof raw.baseModel === 'string' ? raw.baseModel : '',
    trainedWords,
    description: typeof raw.description === 'string' ? raw.description : '',
    images,
    videos,
  }
}

/**
 * 由 Civitai 模型页 URL 提取模型 id（纯函数，便于单测）：
 * 仅接受 https://civitai.{com|red}/models/{数字id} 形式（与元数据层
 * civitaiUrl 的写入校验同源），可选尾段（slug/query）忽略。
 * @param {string} url Civitai 模型页 URL
 * @returns {string|null} 模型 id 字符串，格式不符返回 null
 */
export function parseCivitaiModelId(url) {
  if (typeof url !== 'string') return null
  const m = url.match(
    /^https:\/\/civitai\.(?:com|red)\/models\/(\d+)(?:[/?#]|$)/,
  )
  return m ? /** @type {string} */ (m[1]) : null
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
  const result = await fetchCivitaiApi(
    `${CIVITAI_API_BASE}/models/${modelId}`,
    {
      headers: { 'User-Agent': 'ModelVault', Accept: 'application/json' },
    },
  )
  if (result.networkError) {
    if (
      result.networkError.name === 'TimeoutError' ||
      result.networkError.name === 'AbortError'
    ) {
      return { found: false, error: '请求超时，请检查网络后重试' }
    }
    return {
      found: false,
      error: `网络请求失败: ${result.networkError.message}`,
    }
  }
  const response = result.response
  if (response.status === 404) {
    return { found: false }
  }
  if (!response.ok) {
    return {
      found: false,
      error: `Civitai 查询失败（HTTP ${response.status}）`,
    }
  }
  let raw
  try {
    raw = JSON.parse(
      await readResponseTextLimited(
        response,
        MAX_API_JSON_BYTES,
        'Civitai 响应',
      ),
    )
  } catch (err) {
    return { found: false, error: `响应解析失败: ${errorMessage(err)}` }
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    typeof raw.type !== 'string' ||
    !raw.type.trim()
  ) {
    return { found: false, error: '响应数据格式异常' }
  }
  const tags = Array.isArray(raw.tags)
    ? raw.tags
        .filter((/** @type {any} */ t) => typeof t === 'string' && t.trim())
        .map((/** @type {any} */ t) => t.trim())
    : []
  return { found: true, type: raw.type.trim(), tags }
}
