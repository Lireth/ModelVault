import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import logger from '../../logger'
import { getModelMeta, setModelMeta, toRelKey } from '../../services/store'
import { classifyModel } from '../../services/scanner'
import { saveCoverBuffer } from '../../services/covers'
import {
  civitaiCompletePatch,
  downloadCivitaiImage,
  fetchCivitaiModelType,
  fetchCivitaiVersionByHash,
  parseCivitaiModelId
} from '../../services/civitai'
import { civitaiTagsToTag, civitaiTypeToTag } from '../../../shared/model-categories'
import { computeAndCacheHash, requestHashWarmup, setWarmupProgressListener } from '../../services/hash-warmup'
import {
  appendCoverMeta,
  buildCoverResponse,
  refreshCoverThumbnail
} from './covers'
import { resolveCoverSafe } from './decorate'
import { wrapHandler, checkModelIdInRoot } from '../handler'

/**
 * Civitai 在线识别链路：
 * - identify：按文件 SHA256 反查 Civitai 模型版本，成功时把页面 URL 写入
 *   元数据（civitaiUrl）并回传识别信息（含示例图列表）；
 * - complete：重新反查后对空缺字段（触发词/备注）生成补丁并落盘，
 *   绝不覆盖用户已有标注；
 * - importImages：下载勾选的 Civitai 示例图（仅官方 CDN 白名单）并追加
 *   到模型封面列表（复用封面上传的落盘/关联/缩略图刷新链路）。
 * 大文件哈希计算可能耗时数十秒，渲染层需提供忙碌提示；哈希结果缓存于
 * 元数据的 hash/hashMtime 字段（文件未变更时免重算，与 relink 履书共用）。
 */

/** 单次导入的示例图数量上限 */
const MAX_IMPORT_IMAGES = 20

/**
 * 确保拿到模型文件当前有效的 SHA256（命中 hashMtime 缓存时零读取），
 * 未命中时经预热服务统一入口计算（与后台预热共享进行中任务，同一模型
 * 同 mtime 只读盘计算一次，结果回写元数据缓存）。
 * @param {string} id 模型绝对路径
 * @param {object} meta 当前元数据（可为空对象）
 * @param {number} mtimeMs 文件当前 mtime
 * @returns {Promise<{hash: string, meta: object}>} 哈希与（可能已更新缓存字段的）最新元数据
 */
async function ensureHash(id, meta, mtimeMs) {
  if (meta.hash && meta.hashMtime === mtimeMs) {
    return { hash: meta.hash, meta }
  }
  const hash = await computeAndCacheHash(id, mtimeMs)
  // 重读最新元数据：哈希计算期间用户可能已并发保存其他字段
  return { hash, meta: getModelMeta(id) || meta }
}

/** 注册 Civitai 识别链路的 IPC 处理器 */
export function registerCivitaiHandlers() {
  // 在线识别：哈希反查 Civitai，成功时保存模型页 URL
  wrapHandler('models:civitaiIdentify', async (event, { id } = {}) => {
    const invalid = checkModelIdInRoot(id)
    if (invalid) return { error: invalid }
    const stat = await fs.stat(id)
    const { hash, meta } = await ensureHash(id, getModelMeta(id) || {}, stat.mtimeMs)
    const res = await fetchCivitaiVersionByHash(hash)
    if (res.error) return { error: res.error }
    if (!res.found) {
      logger.info(`Civitai 无匹配记录: ${id}`)
      return { found: false }
    }
    // URL 写盘前重读最新元数据，避免覆盖哈希计算期间的用户并发保存。
    // baseModel 一并回填（F-2 筛选数据源）：已有值不覆盖（宁留旧不覆盖）
    const latest = getModelMeta(id) || meta
    const saved = setModelMeta(id, {
      ...latest,
      civitaiUrl: res.info.url,
      baseModel: latest.baseModel || res.info.baseModel || ''
    })
    logger.info(`Civitai 识别成功: ${id} -> ${res.info.url}`)
    return {
      found: true,
      url: res.info.url,
      info: {
        modelName: res.info.modelName,
        versionName: res.info.versionName,
        baseModel: res.info.baseModel,
        trainedWords: res.info.trainedWords,
        description: res.info.description,
        images: res.info.images
      },
      meta: saved || null
    }
  }, { errorPrefix: 'Civitai 识别失败' })

  // 一键补全：反查后仅填充空缺字段（触发词/备注），不覆盖任何用户标注
  wrapHandler('models:civitaiComplete', async (event, { id } = {}) => {
    const invalid = checkModelIdInRoot(id)
    if (invalid) return { error: invalid }
    const stat = await fs.stat(id)
    const { hash, meta } = await ensureHash(id, getModelMeta(id) || {}, stat.mtimeMs)
    const res = await fetchCivitaiVersionByHash(hash)
    if (res.error) return { error: res.error }
    if (!res.found) return { found: false }
    const latest = getModelMeta(id) || meta
    const { patch, applied } = civitaiCompletePatch(latest, res.info)
    const saved = setModelMeta(id, {
      ...latest,
      civitaiUrl: res.info.url,
      baseModel: latest.baseModel || res.info.baseModel || '',
      ...patch
    })
    logger.info(`Civitai 一键补全完成（${applied.length ? applied.join('/') : '无空缺字段'}）: ${id}`)
    return {
      found: true,
      applied,
      meta: saved || null,
      info: {
        modelName: res.info.modelName,
        versionName: res.info.versionName
      }
    }
  }, { errorPrefix: 'Civitai 补全失败' })

  // 一键分配标签（按 Civitai 分类，仅 LoRA 模型）：读取已保存的模型页链接，
  // 查询 Civitai 模型信息并映射为本地分类标签写盘。仅对扫描分类为 lora 的
  // 模型生效（7 类标签是 LoRA 专属维度）；Civitai API 的 type 字段只有
  // Lora/Checkpoint 等模型种类，character/style 等 7 类分类挂在 tags 里，
  // 故先查 type 再回退 tags。无链接/非 LoRA/未映射/失败的模型不做改动
  // （渲染层汇总提示）；映射成功时覆盖已有标签（分配语义）。
  wrapHandler('models:civitaiCategory', async (event, { id } = {}) => {
    const invalid = checkModelIdInRoot(id)
    if (invalid) return { error: invalid }
    // 模型类型限制：按相对路径复算扫描分类，非 LoRA 直接跳过
    const rel = toRelKey(id)
    const segments = rel ? rel.split('/') : []
    if (classifyModel(segments.slice(0, -1), path.basename(id)) !== 'lora') {
      return { skipped: true, reason: 'not-lora' }
    }
    const meta = getModelMeta(id) || {}
    if (!meta.civitaiUrl) {
      return { skipped: true }
    }
    const modelId = parseCivitaiModelId(meta.civitaiUrl)
    if (!modelId) {
      return { skipped: true, reason: 'invalid-url' }
    }
    const res = await fetchCivitaiModelType(modelId)
    if (res.error) return { error: res.error }
    if (!res.found) return { found: false }
    const tag = civitaiTypeToTag(res.type) || civitaiTagsToTag(res.tags)
    if (!tag) {
      // Civitai 模型的 type/tags 均不属于 7 个分类标签：保持现状
      return { found: true, unmapped: true, type: res.type }
    }
    // 写盘前重读最新元数据，避免覆盖查询期间的用户并发保存
    const latest = getModelMeta(id) || meta
    const saved = setModelMeta(id, { ...latest, subCategory: tag })
    logger.info(`Civitai 分类标签分配: ${id} -> ${tag}（${res.type}）`)
    return { found: true, subCategory: tag, type: res.type, meta: saved || null }
  }, { errorPrefix: 'Civitai 分类标签分配失败' })

  // 示例图导入：下载勾选的图片（仅 Civitai CDN 白名单域名）并追加到封面列表。
  // 逐张串行下载/落盘/关联；单张失败不中断整批，结果按图反馈
  wrapHandler('models:civitaiImportImages', async (event, { id, images } = {}) => {
    const invalid = checkModelIdInRoot(id)
    if (invalid) return { error: invalid }
    if (!Array.isArray(images) || images.length === 0) {
      return { error: '未选择要导入的示例图' }
    }
    if (images.length > MAX_IMPORT_IMAGES) {
      return { error: `单次最多导入 ${MAX_IMPORT_IMAGES} 张示例图` }
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const failed = []
    let added = 0
    let lastMeta = null
    for (const item of images) {
      const url = item && typeof item.url === 'string' ? item.url : ''
      const dl = await downloadCivitaiImage(url)
      if (dl.error) {
        failed.push({ url, error: dl.error })
        continue
      }
      const saved = await saveCoverBuffer(dl.buf, dl.ext)
      if (saved.error) {
        failed.push({ url, error: saved.error })
        continue
      }
      const applied = appendCoverMeta(id, saved.cover)
      if (applied.error) {
        failed.push({ url, error: applied.error })
        continue
      }
      added += 1
      lastMeta = applied.meta
    }
    if (added === 0) {
      return { error: failed[0]?.error || '示例图导入失败', failed }
    }
    logger.info(`Civitai 示例图导入完成: ${id}（成功 ${added} / 失败 ${failed.length}）`)
    await refreshCoverThumbnail(win, id, resolveCoverSafe(lastMeta.cover))
    return {
      added,
      failed,
      ...buildCoverResponse(resolveCoverSafe(lastMeta.cover), lastMeta)
    }
  }, { errorPrefix: '示例图导入失败' })

  // 哈希预热（详情页打开时由渲染层触发）：优先入队并立即开始后台计算，
  // 用户随后点击识别时哈希多半已缓存，识别秒回。入队即返回，不等待计算。
  wrapHandler('models:warmupHash', (event, { id } = {}) => {
    const invalid = checkModelIdInRoot(id)
    if (invalid) return { error: invalid }
    requestHashWarmup([id], { priority: true })
    return { ok: true }
  })
}

/**
 * 注册预热进度的跨窗口广播（与 setupStoreErrorForwarding 同一副作用注册模式）：
 * 预热在主进程后台进行，进度快照经 models:warmupProgress 事件推送渲染进程，
 * 渲染层据此在详情页展示当前模型的哈希进度标识。
 * 副作用注册：仅可由 registerModelIpcHandlers 调用时触发，严禁漂移到模块 import 时。
 */
export function setupWarmupProgressForwarding() {
  setWarmupProgressListener((progress) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('models:warmupProgress', progress)
      }
    }
  })
}
