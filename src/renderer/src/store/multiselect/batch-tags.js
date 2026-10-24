import { state } from '../state'
import { toast } from '../toast'
import { applyMetaUpdates, mapWithConcurrency } from '../meta-apply'
import { modelById } from '../selectors'

/**
 * 批量自由标签编辑（FEAT-01）：
 * 对当前多选模型执行「添加 / 移除 / 替换」三种标签变更，复用单模型
 * setModelTags IPC（整体覆写语义）与批量并发池；结果经 applyMetaUpdates
 * 单趟同步本地列表，避免逐个元素替换导致全量派生反复失效。
 */

/** 单模型标签上限（与 IPC schema / store-meta 规范化保持一致） */
const MAX_TAGS = 20
/** 单个标签长度上限（与 IPC schema 保持一致） */
const MAX_TAG_LEN = 32
/** 批量标签 IPC 并发上限（与收藏/评分批量一致） */
const TAG_IPC_CONCURRENCY = 16

const MODE_LABELS = {
  add: '添加',
  remove: '移除',
  replace: '替换'
}
const MODE_KEYS = new Set(Object.keys(MODE_LABELS))

/**
 * 标签入参归一化：去空白、截断、精确去重；数组或逗号分隔字符串均接受。
 * 标签内部允许空格，因此不按空白拆分。
 * @param {unknown} raw 标签数组或逗号分隔字符串
 * @returns {string[]}
 */
export function normalizeBatchTags(raw) {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,，]/)
      : []
  const out = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const tag = item.trim().slice(0, MAX_TAG_LEN)
    if (!tag || out.includes(tag)) continue
    out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

/**
 * 计算单个模型在指定模式下的下一组标签。
 * @param {string[]} current 当前标签
 * @param {string[]} input 本次输入的标签
 * @param {'add'|'remove'|'replace'} mode 模式
 * @returns {{tags?: string[], unchanged?: boolean, overflow?: boolean}}
 */
function nextTagsFor(current, input, mode) {
  if (mode === 'add') {
    const set = new Set(current)
    for (const tag of input) set.add(tag)
    const next = [...set]
    if (next.length > MAX_TAGS) return { overflow: true }
    return next.length === current.length ? { unchanged: true } : { tags: next }
  }
  if (mode === 'remove') {
    const remove = new Set(input)
    const next = current.filter((tag) => !remove.has(tag))
    return next.length === current.length ? { unchanged: true } : { tags: next }
  }
  const replacesAll =
    current.length === input.length && current.every((tag, i) => tag === input[i])
  return replacesAll ? { unchanged: true } : { tags: [...input] }
}

/**
 * 批量编辑选中模型的自由标签。
 * @param {{mode?: 'add'|'remove'|'replace', tags?: string[]|string}} [options]
 *   模式与标签；输入为空或模式非法时直接提示并返回 false
 * @returns {Promise<boolean>} 是否至少成功更新一个模型
 */
export async function batchEditTags(options = {}) {
  const { mode = 'add', tags } = options
  if (!MODE_KEYS.has(mode)) {
    toast('error', '不支持的标签编辑模式')
    return false
  }
  const ids = [...state.multiSelect.ids]
  if (ids.length === 0 || state.multiSelect.busy) return false
  const input = normalizeBatchTags(tags)
  if (input.length === 0) {
    toast('warn', '请输入至少一个标签')
    return false
  }
  if (state.multiSelect.cancelRequested) return false

  const byId = modelById.value
  const updates = []
  let unchanged = 0
  let overflow = 0
  for (const id of ids) {
    const model = byId.get(id)
    if (!model) continue
    const current = Array.isArray(model.tags) ? model.tags : []
    const result = nextTagsFor(current, input, mode)
    if (result.unchanged) {
      unchanged += 1
      continue
    }
    if (result.overflow) {
      overflow += 1
      continue
    }
    updates.push({ id, tags: result.tags })
  }

  const modeLabel = MODE_LABELS[mode]
  if (updates.length === 0) {
    const notes = []
    if (unchanged > 0) notes.push(`标签无变化 ${unchanged} 个`)
    if (overflow > 0) notes.push(`超过 ${MAX_TAGS} 个标签上限 ${overflow} 个`)
    toast('info', `没有需要更新标签的模型${notes.length ? `（${notes.join('，')}）` : ''}`)
    return false
  }

  state.multiSelect.busy = true
  state.multiSelect.progress = ''
  try {
    let processed = 0
    const results = await mapWithConcurrency(
      updates,
      async (item) => {
        if (state.multiSelect.cancelRequested) return { canceled: true }
        processed += 1
        state.multiSelect.progress = `标签${modeLabel} ${processed}/${updates.length}`
        const res = await window.api.models.setModelTags(item.id, item.tags)
        if (res?.error) throw new Error(res.error)
        return res
      },
      TAG_IPC_CONCURRENCY
    )

    const metas = new Map()
    let failed = 0
    let canceled = 0
    results.forEach((result, i) => {
      if (result.status !== 'fulfilled') {
        failed += 1
        return
      }
      if (result.value?.canceled) {
        canceled += 1
        return
      }
      const meta = result.value?.meta
      if (meta) metas.set(updates[i].id, meta)
      else failed += 1
    })

    const ok = applyMetaUpdates(metas, (meta) => ({
      tags: Array.isArray(meta.tags) ? meta.tags : []
    }))
    const notes = []
    if (unchanged > 0) notes.push(`无变化 ${unchanged} 个`)
    if (overflow > 0) notes.push(`超上限跳过 ${overflow} 个`)
    if (failed > 0) notes.push(`失败 ${failed} 个`)
    const suffix = notes.length ? `（${notes.join('，')}）` : ''
    if (canceled > 0) {
      toast('warn', `标签${modeLabel}已取消：完成 ${ok}/${updates.length}，已完成部分已保存${suffix}`)
    } else if (failed > 0) {
      toast('warn', `标签${modeLabel}完成：成功 ${ok} 个${suffix}`)
    } else {
      toast('success', `已为 ${ok} 个模型${modeLabel}标签${suffix}`)
    }
    return ok > 0
  } finally {
    state.multiSelect.busy = false
    state.multiSelect.progress = ''
    state.multiSelect.cancelRequested = false
  }
}
