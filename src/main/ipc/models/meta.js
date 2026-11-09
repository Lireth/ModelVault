import logger from '../../logger'
import {
  flushStoreSave,
  getMetaMapByAbsPath,
  getModelMeta,
  setModelMeta,
  setModelMetaMany,
} from '../../services/store'
import { wrapHandler, checkModelId, checkModelIdInRoot } from '../handler'
import { MAX_TAGS } from '../../../shared/app-enums'

/**
 * 元数据链路：详情页标注保存、快捷标记（收藏/NSFW/评分）、自由标签（F-5）。
 * C1：批量标记/标签由单次 IPC 合并处理（逐项校验 + 逐项失败原因），避免
 * 万级选中时产生万次 invoke 与完整 meta 回包。
 */

/** 标签名称校验（F4 全库操作入口）：非空字符串（长度上限由 schema 门禁约束） */
function checkTagName(tag) {
  return typeof tag === 'string' && tag.trim() ? '' : '标签名称不能为空'
}

/**
 * 归一化快捷标记 patch（单/批量共用）：仅接受显式传入的字段；
 * 类型与取值范围在此 fail-fast，文案与既有单模型通道一致。
 * @param {{favorite?: boolean, nsfw?: boolean, rating?: number}} raw 入参
 * @returns {{patch?: object, error?: string}} 合法 patch 或错误文案
 */
function normalizeFlagsPatch({ favorite, nsfw, rating } = {}) {
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
  if (Object.keys(patch).length === 0) return { error: '无有效的更新字段' }
  return { patch }
}

/** 单模型快捷标记更新（合并已有元数据后整条落盘） */
function applyMetaFlags(id, patch) {
  const existing = getModelMeta(id) || {}
  const meta = setModelMeta(id, { ...existing, ...patch })
  if (!meta) return { error: '保存失败（模型需位于当前模型根目录内）' }
  return { meta }
}

/** 单模型标签整体覆写（合并已有元数据后整条落盘） */
function applyModelTags(id, tags) {
  const invalid = checkModelIdInRoot(id)
  if (invalid) return { error: invalid }
  if (!Array.isArray(tags)) return { error: '无效的标签列表' }
  if (tags.length > MAX_TAGS) return { error: `标签最多 ${MAX_TAGS} 个` }
  const existing = getModelMeta(id) || {}
  const meta = setModelMeta(id, { ...existing, tags })
  if (!meta) return { error: '标签保存失败（模型需位于当前模型根目录内）' }
  return { meta }
}

/**
 * 合并详情页保存的元数据字段（纯函数，不修改入参）。
 * 仅覆盖请求中显式传入（!== undefined）的字段，防止局部保存时将已有值静默清空。
 * note 显式传入时视为用户编辑，清除 sidecar 自动导入来源标记。
 * @param {Record<string, any>} existing 已有元数据
 * @param {{alias?: string, params?: object|null, note?: string, subCategory?: string}} patch 本次保存的字段
 * @returns {Record<string, any>} 合并后的新元数据
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
  wrapHandler(
    'models:saveModelData',
    (event, { id, alias, params, note, subCategory, triggerWords } = {}) => {
      const invalid = checkModelId(id)
      if (invalid) return { error: invalid }
      // 合并已有元数据，避免覆盖丢失封面等未随本次请求传入的字段
      const existing = getModelMeta(id) || {}
      const merged = mergeSaveModelData(existing, {
        alias,
        params,
        note,
        subCategory,
      })
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
    },
    { errorPrefix: '元数据保存失败' },
  )

  // 更新模型快捷标记（收藏/NSFW/评分；仅更新传入的字段，即时落盘）
  wrapHandler(
    'models:setMetaFlags',
    (event, { id, favorite, nsfw, rating } = {}) => {
      const invalid = checkModelId(id)
      if (invalid) return { error: invalid }
      const normalized = normalizeFlagsPatch({ favorite, nsfw, rating })
      if (normalized.error) return normalized
      return applyMetaFlags(id, normalized.patch)
    },
    { errorPrefix: '标记保存失败' },
  )

  // C1：批量快捷标记（单次 IPC、单次落盘调度）
  // 逐项合并已有元数据后交给 setModelMetaMany；返回成功项的有效三元组与
  // 逐项失败原因（渲染层据此写标注覆盖层并填充失败明细面板）。
  wrapHandler(
    'models:setMetaFlagsBulk',
    (event, { ids, favorite, nsfw, rating } = {}) => {
      if (!Array.isArray(ids) || ids.length === 0) {
        return { error: '缺少待更新的模型' }
      }
      const normalized = normalizeFlagsPatch({ favorite, nsfw, rating })
      if (normalized.error) return normalized
      const patch = normalized.patch
      // 去重防止重复 id 在结果中重复出现（渲染层 Map 写入前也会去重）
      const uniqueIds = [...new Set(ids)]
      const entries = uniqueIds.map((id) => ({
        id,
        meta: { ...(getModelMeta(id) || {}), ...patch },
      }))
      const result = setModelMetaMany(entries)
      return {
        updated: result.updated.map(({ id, meta }) => ({
          id,
          favorite: meta.favorite,
          nsfw: meta.nsfw,
          rating: meta.rating,
        })),
        failed: result.failed,
      }
    },
    { errorPrefix: '批量标记保存失败' },
  )

  // 整体覆写模型自由标签（F-5）：渲染层详情页标签编辑器每次增删提交全量列表
  // （与 setMetaFlags 的即时保存语义一致）；规范化（去重/截断）在 normalizeTags
  wrapHandler(
    'models:setModelTags',
    (event, { id, tags } = {}) => applyModelTags(id, tags),
    { errorPrefix: '标签保存失败' },
  )

  // C1：批量标签整体覆写（单次 IPC、单次落盘调度）
  // 逐项做归属/长度前置校验，失败项单独返回；成功项返回规范化后的标签，
  // 渲染层据此单趟同步列表（不逐项替换元素）。
  wrapHandler(
    'models:setModelTagsBulk',
    (event, { items } = {}) => {
      if (!Array.isArray(items) || items.length === 0) {
        return { error: '缺少待更新的模型' }
      }
      const failed = []
      // 同 id 多次出现时以最后一次为准（意图式整体覆写）
      const tagsById = new Map()
      for (const item of items) {
        const id = item?.id
        const invalid = checkModelIdInRoot(id)
        if (invalid) {
          failed.push({ id: typeof id === 'string' ? id : '', error: invalid })
          continue
        }
        if (!Array.isArray(item.tags)) {
          failed.push({ id, error: '无效的标签列表' })
          continue
        }
        if (item.tags.length > MAX_TAGS) {
          failed.push({ id, error: `标签最多 ${MAX_TAGS} 个` })
          continue
        }
        tagsById.set(id, item.tags)
      }
      const entries = [...tagsById].map(([id, tags]) => ({
        id,
        meta: { ...(getModelMeta(id) || {}), tags },
      }))
      const result = setModelMetaMany(entries)
      return {
        updated: result.updated.map(({ id, meta }) => ({
          id,
          tags: meta.tags,
        })),
        failed: [...failed, ...result.failed],
      }
    },
    { errorPrefix: '批量标签保存失败' },
  )

  // 全库重命名自由标签（F4）：把当前库所有模型上的 from 替换为 to；
  // 目标名已存在（或仅大小写不同）时自然合并——normalizeTags 的大小写
  // 不敏感去重会收敛变体。仅在确有改动时等待落盘，避免无谓的磁盘写入
  wrapHandler(
    'models:renameTag',
    async (event, { from, to } = {}) => {
      const invalid = checkTagName(from) || checkTagName(to)
      if (invalid) return { error: invalid }
      if (from === to) return { changed: 0 }
      let changed = 0
      for (const [id, meta] of Object.entries(getMetaMapByAbsPath())) {
        if (!(meta.tags || []).includes(from)) continue
        setModelMeta(id, {
          ...meta,
          tags: meta.tags.map((t) => (t === from ? to : t)),
        })
        changed += 1
      }
      if (changed > 0) {
        await flushStoreSave()
        logger.info(`全库标签重命名: ${from} -> ${to}（${changed} 个模型）`)
      }
      return { changed }
    },
    { errorPrefix: '标签重命名失败' },
  )

  // 全库移除自由标签（F4）：仅摘除标签，不触碰其他标注
  wrapHandler(
    'models:removeTag',
    async (event, { tag } = {}) => {
      const invalid = checkTagName(tag)
      if (invalid) return { error: invalid }
      let changed = 0
      for (const [id, meta] of Object.entries(getMetaMapByAbsPath())) {
        if (!(meta.tags || []).includes(tag)) continue
        setModelMeta(id, { ...meta, tags: meta.tags.filter((t) => t !== tag) })
        changed += 1
      }
      if (changed > 0) {
        await flushStoreSave()
        logger.info(`全库标签移除: ${tag}（${changed} 个模型）`)
      }
      return { changed }
    },
    { errorPrefix: '标签移除失败' },
  )
}
