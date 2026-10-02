import crypto from 'node:crypto'
import fs from 'node:fs'
import { net } from 'electron'
import logger from '../logger'

/**
 * Civitai 匹配服务：
 * - 对模型文件计算 SHA256（Civitai AutoV2 哈希），查询 Civitai API
 *   匹配对应的模型版本，获取模型名/作者/触发词/推荐参数/精度等信息；
 * - 大文件哈希耗时较长（GB 级约数秒），结果按「路径+修改时间」做
 *   进程内缓存；已计算的哈希持久化到模型元数据（store.js），
 *   应用重启后同一文件无需重新计算；
 * - 网络请求使用 Electron net.fetch（走 Chromium 网络栈，
 *   自动继承系统代理设置，Node 原生 fetch 不支持代理）；
 * - 请求超时与网络错误统一抛出，由 IPC 层转换为 { error } 返回。
 */

const API_BASE = 'https://civitai.com/api/v1'
const REQUEST_TIMEOUT_MS = 15000
/** 进程内匹配结果缓存：key 为「绝对路径:mtime」 */
const matchCache = new Map()
/** 缓存容量上限：超出后按插入顺序淘汰最旧条目（S3，与装饰缓存的治理策略一致）。
 *  匹配结果（含版本信息/触发词/示例参数）随大库全量匹配持续累积，须限容防内存膨胀 */
const MATCH_CACHE_MAX = 1000

/** 写入匹配缓存（容量超限时按插入顺序淘汰最旧条目） */
function cacheMatchResult(key, result) {
  matchCache.set(key, result)
  if (matchCache.size > MATCH_CACHE_MAX) {
    matchCache.delete(matchCache.keys().next().value)
  }
}

/** 流式计算文件 SHA256（大文件友好，内存占用恒定） */
function sha256File(absPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(absPath, { highWaterMark: 8 * 1024 * 1024 })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** 从版本示例图的生成参数中提取推荐参数（取第一张含参数的图） */
function extractExampleParams(images) {
  for (const img of images || []) {
    const meta = img?.meta
    if (!meta || !(meta.steps || meta.cfgScale || meta.sampler)) continue
    const w = Number.isFinite(meta.width) ? meta.width : null
    const h = Number.isFinite(meta.height) ? meta.height : null
    return {
      steps: Number.isFinite(meta.steps) ? meta.steps : null,
      cfgMin: Number.isFinite(meta.cfgScale) ? meta.cfgScale : null,
      cfgMax: Number.isFinite(meta.cfgScale) ? meta.cfgScale : null,
      sampler: typeof meta.sampler === 'string' ? meta.sampler : '',
      scheduler: typeof meta.scheduler === 'string' ? meta.scheduler : '',
      // 分辨率区间：宽高取 min/max（与详情页单值区间输入约定一致）
      resMin: w && h ? Math.min(w, h) : null,
      resMax: w && h ? Math.max(w, h) : null
    }
  }
  return null
}

/** 将 Civitai 版本响应映射为渲染进程使用的精简结构 */
function mapVersion(v) {
  const file = Array.isArray(v.files) ? v.files[0] : null
  return {
    modelName: typeof v.model?.name === 'string' ? v.model.name : '',
    modelType: typeof v.model?.type === 'string' ? v.model.type : '',
    versionName: typeof v.name === 'string' ? v.name : '',
    baseModel: typeof v.baseModel === 'string' ? v.baseModel : '',
    creator: typeof v.model?.creator?.username === 'string' ? v.model.creator.username : '',
    trainedWords: Array.isArray(v.trainedWords)
      ? v.trainedWords.filter((w) => typeof w === 'string' && w).slice(0, 20)
      : [],
    precision: typeof file?.metadata?.fp === 'string' ? file.metadata.fp : '',
    exampleParams: extractExampleParams(v.images),
    pageUrl: v.model?.id
      ? `https://civitai.com/models/${v.model.id}?modelVersionId=${v.id}`
      : ''
  }
}

/**
 * 匹配 Civitai 模型版本。
 * @param {string} absPath 模型文件绝对路径
 * @param {string} [knownHash] 已持久化的哈希（文件未变化时直接复用，跳过耗时计算）
 * @returns {Promise<{matched: false, hash: string} | {matched: true, hash: string, info: object}>}
 */
export async function matchCivitai(absPath, knownHash = '') {
  const stat = await fs.promises.stat(absPath)
  const cacheKey = `${absPath}:${Math.round(stat.mtimeMs)}`
  const cached = matchCache.get(cacheKey)
  if (cached) return cached

  const hash = typeof knownHash === 'string' && /^[0-9a-f]{64}$/i.test(knownHash)
    ? knownHash.toLowerCase()
    : await sha256File(absPath)
  const useKnownHash = hash === knownHash?.toLowerCase()
  if (!useKnownHash) {
    logger.info(`Civitai 匹配：开始计算文件哈希 ${absPath}`)
  }

  let response
  try {
    // net.fetch 走 Chromium 网络栈，自动继承系统代理（含 PAC），
    // 解决 Node 原生 fetch 不支持代理导致国内网络环境无法访问 Civitai 的问题
    response = await net.fetch(`${API_BASE}/model-versions/by-hash/${hash}`, {
      headers: { 'User-Agent': 'ModelVault/0.1.0' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error('请求 Civitai 超时，请检查网络后重试', { cause: err })
    }
    throw new Error(`网络请求失败: ${err.message}`, { cause: err })
  }

  if (response.status === 404) {
    logger.info(`Civitai 匹配：未找到匹配的模型版本 (${hash.slice(0, 12)}…)` )
    const result = { matched: false, hash }
    cacheMatchResult(cacheKey, result)
    return result
  }
  if (!response.ok) {
    throw new Error(`Civitai API 返回 ${response.status}`)
  }

  let version
  try {
    version = await response.json()
  } catch (err) {
    // 响应体非 JSON（如网关返回 HTML 错误页）时转为友好错误（S6），
    // 避免原始 SyntaxError 直接透给用户
    throw new Error(`Civitai 响应解析失败（响应体损坏）: ${err.message}`, { cause: err })
  }
  const result = { matched: true, hash, info: mapVersion(version) }
  cacheMatchResult(cacheKey, result)
  logger.info(`Civitai 匹配成功：${result.info.modelName} / ${result.info.versionName}`)
  return result
}
