import fs from 'node:fs/promises'
import logger from '../../logger'
import { getModelMeta, setModelMeta } from '../../services/store'
import {
  civitaiCompletePatch,
  computeFileHash,
  fetchCivitaiVersionByHash
} from '../../services/civitai'
import { wrapHandler, checkModelIdInRoot } from '../handler'

/**
 * Civitai 在线识别链路：
 * - identify：按文件 SHA256 反查 Civitai 模型版本，成功时把页面 URL 写入
 *   元数据（civitaiUrl）并回传识别信息；
 * - complete：重新反查后对空缺字段（触发词/备注）生成补丁并落盘，
 *   绝不覆盖用户已有标注。
 * 大文件哈希计算可能耗时数十秒，渲染层需提供忙碌提示；哈希结果缓存于
 * 元数据的 hash/hashMtime 字段（文件未变更时免重算，与 relink 履书共用）。
 */

/**
 * 确保拿到模型文件当前有效的 SHA256（命中 hashMtime 缓存时零读取），
 * 新计算的结果回写元数据缓存。
 * @param {string} id 模型绝对路径
 * @param {object} meta 当前元数据（可为空对象）
 * @param {number} mtimeMs 文件当前 mtime
 * @returns {Promise<{hash: string, meta: object}>} 哈希与（可能已更新缓存字段的）最新元数据
 */
async function ensureHash(id, meta, mtimeMs) {
  if (meta.hash && meta.hashMtime === mtimeMs) {
    return { hash: meta.hash, meta }
  }
  const hash = await computeFileHash(id)
  // 重读最新元数据后再写缓存：哈希计算期间用户可能已并发保存其他字段
  const latest = getModelMeta(id) || meta
  const updated = setModelMeta(id, { ...latest, hash, hashMtime: mtimeMs }) || latest
  return { hash, meta: updated }
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
    // URL 写盘前重读最新元数据，避免覆盖哈希计算期间的用户并发保存
    const latest = getModelMeta(id) || meta
    const saved = setModelMeta(id, { ...latest, civitaiUrl: res.info.url })
    logger.info(`Civitai 识别成功: ${id} -> ${res.info.url}`)
    return {
      found: true,
      url: res.info.url,
      info: {
        modelName: res.info.modelName,
        versionName: res.info.versionName,
        baseModel: res.info.baseModel,
        trainedWords: res.info.trainedWords,
        description: res.info.description
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
    const saved = setModelMeta(id, { ...latest, civitaiUrl: res.info.url, ...patch })
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
}
