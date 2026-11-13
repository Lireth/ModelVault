import { state } from '../state'
import { toast } from '../toast'
import { applyMetaUpdates } from '../meta-apply'
import { modelById } from '../selectors'
import { beginBatchTagsWrite } from '../model-actions'
import { reportBatchFailures, clearBatchFailures } from './batch-failures'
import {
  MAX_BATCH_META_IDS,
  MAX_TAG_LEN,
  MAX_TAGS,
} from '../../../../shared/app-enums'
import { errorMessage } from '../../../../shared/error-text'

/**
 * 批量自由标签编辑（FEAT-01，C1 批量 IPC 改造）：
 * 对当前多选模型执行「添加 / 移除 / 替换」三种标签变更。目标列表在
 * 等待既有 per-id 队列落定后基于最新标签重算（B2），再按
 * MAX_BATCH_META_IDS 分块、单次 IPC 提交整块；主进程逐项校验/规范化后
 * 单次落盘调度，返回成功项的规范化标签与逐项失败原因。
 *
 * 相比旧实现（逐模型 setModelTags + 并发 16）：万级选中时 IPC 往返从
 * N 次降到 ceil(N/5000) 次，回包从「每模型完整 meta」降为「标签数组 +
 * 失败明细」，并保留「无变化/超上限跳过」的逐项语义。
 */

const MODE_LABELS = {
  add: '添加',
  remove: '移除',
  replace: '替换',
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
    current.length === input.length &&
    current.every((tag, i) => tag === input[i])
  return replacesAll ? { unchanged: true } : { tags: [...input] }
}

/** 读取当前模型的最新标签（执行时取值，供意图式增删基于最新状态计算） */
function currentTagsOf(model) {
  return Array.isArray(model?.tags) ? model.tags : []
}

/**
 * 计算本批需要提交的标签变更（预判与执行共用同一实现）：
 * 无变化的模型计入 unchanged，超过上限的计入 overflow，其余进入 items。
 * @param {string[]} ids 选中模型 id
 * @param {string[]} input 归一化后的输入标签
 * @param {'add'|'remove'|'replace'} mode 模式
 * @param {{get: (id: string) => any}} byId id → 模型映射（预判用列表快照，执行用最新映射）
 * @returns {{items: Array<{id: string, tags: string[]}>, unchanged: number,
 *   overflow: number}}
 */
function collectTagChanges(ids, input, mode, byId) {
  const items = []
  let unchanged = 0
  let overflow = 0
  for (const id of ids) {
    const model = byId.get(id)
    if (!model) continue
    const result = nextTagsFor(currentTagsOf(model), input, mode)
    if (result.unchanged) {
      unchanged += 1
      continue
    }
    if (result.overflow) {
      overflow += 1
      continue
    }
    items.push({ id, tags: result.tags })
  }
  return { items, unchanged, overflow }
}

/**
 * 「没有需要更新的模型」提示后缀（无变化/超上限计数）。
 * @param {number} unchanged 无变化数量
 * @param {number} overflow 超上限数量
 * @returns {string} 形如「（标签无变化 2 个，超过 20 个标签上限 1 个）」；无计数为空串
 */
function skippedSuffix(unchanged, overflow) {
  const notes = []
  if (unchanged > 0) notes.push(`标签无变化 ${unchanged} 个`)
  if (overflow > 0) notes.push(`超过 ${MAX_TAGS} 个标签上限 ${overflow} 个`)
  return notes.length ? `（${notes.join('，')}）` : ''
}

/**
 * 分块提交标签变更并汇总结果。
 * @param {Array<{id: string, tags: string[]}>} items 待提交项
 * @param {string} modeLabel 模式展示文案
 * @param {Map<string, any>} metas 成功项元数据收集表
 * @param {Array<{id: string, error: string}>} failedItems 失败明细收集表
 * @returns {Promise<number>} 因取消而未提交的条目数
 */
async function submitTagChunks(items, modeLabel, metas, failedItems) {
  let canceled = 0
  let processed = 0
  for (let offset = 0; offset < items.length; offset += MAX_BATCH_META_IDS) {
    if (state.multiSelect.cancelRequested) {
      canceled = items.length - processed
      break
    }
    const chunk = items.slice(offset, offset + MAX_BATCH_META_IDS)
    processed += chunk.length
    state.multiSelect.progress = `标签${modeLabel} ${Math.min(processed, items.length)}/${items.length}`

    let res
    try {
      res = await window.api.models.setModelTagsBulk(chunk)
    } catch (err) {
      for (const item of chunk)
        failuresPush(failedItems, item.id, errorMessage(err))
      continue
    }
    if (res?.error) {
      for (const item of chunk) failuresPush(failedItems, item.id, res.error)
      continue
    }

    const updated = Array.isArray(res?.updated) ? res.updated : []
    const updatedIds = new Set()
    for (const item of updated) {
      if (!item || typeof item.id !== 'string') continue
      updatedIds.add(item.id)
      metas.set(item.id, item)
    }
    const failed = Array.isArray(res?.failed) ? res.failed : []
    const failedIds = new Set()
    for (const item of failed) {
      if (!item || typeof item.id !== 'string') continue
      failedIds.add(item.id)
      failuresPush(failedItems, item.id, item.error || '未返回失败原因')
    }
    // 契约防御：既未成功也未显式失败的条目必须显形，不得静默丢失
    for (const item of chunk) {
      if (!updatedIds.has(item.id) && !failedIds.has(item.id)) {
        failuresPush(failedItems, item.id, '未返回结果')
      }
    }
  }
  return canceled
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

  const modeLabel = MODE_LABELS[mode]
  // 预判参与集：无变化/超上限的模型不进 IPC；最终载荷在执行时按最新标签重算
  const preview = collectTagChanges(ids, input, mode, modelById.value)
  if (preview.items.length === 0) {
    toast(
      'info',
      `没有需要更新标签的模型${skippedSuffix(preview.unchanged, preview.overflow)}`,
    )
    return false
  }

  state.multiSelect.busy = true
  state.multiSelect.progress = ''
  clearBatchFailures()
  /** @type {(() => void) | null} */
  let releaseBulkTags = null
  try {
    // B2/C1：等待全部选中模型的在途操作落定并持有批量锁；锁生效期间新发起
    // 的单模型编辑会排在本批之后，避免批量 IPC 在途时用旧快照反向覆盖
    releaseBulkTags = await beginBatchTagsWrite(ids)
    const { items, unchanged, overflow } = collectTagChanges(
      ids,
      input,
      mode,
      modelById.value,
    )
    if (items.length === 0) {
      toast(
        'info',
        `没有需要更新标签的模型${skippedSuffix(unchanged, overflow)}`,
      )
      return false
    }

    const metas = new Map()
    // B20/F3：逐项失败保留真实原因，供失败明细面板定位与重建选区重试
    const failedItems = []
    const canceled = await submitTagChunks(items, modeLabel, metas, failedItems)

    const failed = reportBatchFailures(`批量标签${modeLabel}`, failedItems)
    const ok = applyMetaUpdates(metas, (meta) => ({
      tags: Array.isArray(meta.tags) ? meta.tags : [],
    }))
    const notes = []
    if (unchanged > 0) notes.push(`无变化 ${unchanged} 个`)
    if (overflow > 0) notes.push(`超上限跳过 ${overflow} 个`)
    if (failed > 0) notes.push(`失败 ${failed} 个`)
    const suffix = notes.length ? `（${notes.join('，')}）` : ''
    if (canceled > 0) {
      toast(
        'warn',
        `标签${modeLabel}已取消：完成 ${ok}/${items.length}，已完成部分已保存${suffix}`,
      )
    } else if (failed > 0) {
      toast('warn', `标签${modeLabel}完成：成功 ${ok} 个${suffix}`)
    } else {
      toast('success', `已为 ${ok} 个模型${modeLabel}标签${suffix}`)
    }
    return ok > 0
  } finally {
    releaseBulkTags?.()
    state.multiSelect.busy = false
    state.multiSelect.progress = ''
    state.multiSelect.cancelRequested = false
  }
}

/** 记录一条失败明细（契约防御与 IPC 异常共用） */
function failuresPush(list, id, error) {
  list.push({ id, error: error || '未返回结果' })
}
