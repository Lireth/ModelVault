import { ipcMain } from 'electron'
import logger from '../../logger'
import { getModelMeta, setModelMeta } from '../../services/store'

/**
 * 元数据链路：详情页标注保存、快捷标记（收藏/NSFW/评分）。
 */

/**
 * 合并详情页保存的元数据字段（纯函数，不修改入参）。
 * 仅覆盖请求中显式传入（!== undefined）的字段，防止局部保存时将已有值静默清空。
 * note 显式传入时视为用户编辑，清除 sidecar 自动导入来源标记。
 * @param {object} existing 已有元数据
 * @param {{alias?: string, params?: object|null, note?: string, subCategory?: string}} patch 本次保存的字段
 * @returns {object} 合并后的新元数据
 */
export function mergeSaveModelData(existing, patch) {
  const merged = { ...existing }
  if (patch.alias !== undefined) merged.alias = patch.alias
  if (patch.params !== undefined) merged.params = patch.params
  if (patch.note !== undefined) {
    merged.note = patch.note
    merged.noteSource = ''
  }
  if (patch.subCategory !== undefined) merged.subCategory = patch.subCategory
  return merged
}

/** 注册元数据链路的 IPC 处理器 */
export function registerMetaHandlers() {
  // 保存单个模型的元数据（备注名 / 推荐参数 / 备注 / 二级分类标签 / 触发词）
  ipcMain.handle('models:saveModelData', (event, { id, alias, params, note, subCategory, triggerWords } = {}) => {
    if (typeof id !== 'string' || !id) {
      return { error: '无效的模型标识' }
    }
    // 合并已有元数据，避免覆盖丢失封面等未随本次请求传入的字段
    const existing = getModelMeta(id) || {}
    const merged = mergeSaveModelData(existing, { alias, params, note, subCategory })
    // 触发词仅 LoRA 详情页编辑：请求未携带该字段时不更新，避免误清空
    if (typeof triggerWords === 'string') {
      merged.triggerWords = triggerWords
      merged.triggerWordsSource = ''
    }
    const meta = setModelMeta(id, merged)
    if (!meta) {
      return { error: '模型元数据保存失败（模型需位于当前模型根目录内）' }
    }
    logger.info(`模型元数据已保存: ${id}`)
    return { meta }
  })

  // 更新模型快捷标记（收藏/NSFW/评分；仅更新传入的字段，即时落盘）
  ipcMain.handle('models:setMetaFlags', (event, { id, favorite, nsfw, rating } = {}) => {
    if (typeof id !== 'string' || !id) {
      return { error: '无效的模型标识' }
    }
    const patch = {}
    if (favorite !== undefined) {
      if (typeof favorite !== 'boolean') return { error: '无效的收藏状态' }
      patch.favorite = favorite
    }
    if (nsfw !== undefined) {
      if (typeof nsfw !== 'boolean') return { error: '无效的 NSFW 状态' }
      patch.nsfw = nsfw
    }
    if (rating !== undefined) {
      if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
        return { error: '评分需为 0-5 的整数' }
      }
      patch.rating = rating
    }
    if (Object.keys(patch).length === 0) {
      return { error: '无有效的更新字段' }
    }
    const existing = getModelMeta(id) || {}
    const meta = setModelMeta(id, { ...existing, ...patch })
    if (!meta) {
      return { error: '保存失败（模型需位于当前模型根目录内）' }
    }
    return { meta }
  })
}
