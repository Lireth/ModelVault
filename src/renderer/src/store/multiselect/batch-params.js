import { state } from '../state'
import { toast } from '../toast'
import { applyMetaUpdates } from '../meta-apply'
import { modelById } from '../selectors'
import { beginBatchTagsWrite } from '../model-actions'
import { reportBatchFailures, clearBatchFailures } from './batch-failures'
import { MAX_BATCH_META_IDS } from '../../../../shared/app-enums'
import { PARAM_LIMITS } from '../../constants/modelParams'
import { errorMessage } from '../../../../shared/error-text'

/**
 * 批量推荐参数编辑（F5）：
 *
 * 详情页的推荐参数此前只能逐模型录入；同基底家族的模型通常共享步数/CFG/
 * 采样器/分辨率，批量场景下重复录入既慢又容易不一致。本模块把「只填需要
 * 修改的字段」的补丁合并进每个选中模型的已有参数，未填写字段保持原值，
 * 不做整包覆写（与批量标签的整体覆写语义刻意区分）。
 *
 * 性能与一致性沿用 C1 批量标签范式：
 * - 执行时基于最新模型参数重算变更集（等待在途单模型操作落定后取快照）；
 * - 按 MAX_BATCH_META_IDS 分块、单次 IPC 提交整块，主进程逐项合并后
 *   单次落盘调度；
 * - 逐项失败保留真实原因，供失败明细面板定位与重建选区重试；
 * - 支持 Esc 取消（已完成分块保留）。
 */

/**
 * 数值字段与校验文案（与详情页 PARAM_LIMITS 同源）
 * @type {Array<[string, string, number, number]>}
 */
const NUMBER_FIELDS = [
  ['steps', '采样步数', PARAM_LIMITS.steps.min, PARAM_LIMITS.steps.max],
  ['cfgMin', 'CFG 最小值', PARAM_LIMITS.cfg.min, PARAM_LIMITS.cfg.max],
  ['cfgMax', 'CFG 最大值', PARAM_LIMITS.cfg.min, PARAM_LIMITS.cfg.max],
  ['resMin', '最小分辨率', PARAM_LIMITS.res.min, PARAM_LIMITS.res.max],
  ['resMax', '最大分辨率', PARAM_LIMITS.res.min, PARAM_LIMITS.res.max],
]

/** 文本字段（trim 后为空表示不修改） */
const TEXT_FIELDS = ['sampler', 'scheduler', 'precision']

/**
 * 归一化批量参数补丁（纯函数，供组件预检与执行链路共用）：
 * - 空白数值/文本字段直接忽略（留空 = 保持各模型原值）；
 * - 数值必须可解析且落在 PARAM_LIMITS 内；
 * - 只有同时填写 min/max 时才校验区间顺序；
 * - 至少需要一个有效字段。
 * @param {Record<string, any>} raw 表单原始值（数字或字符串）
 * @returns {{patch?: Record<string, number|string>, error?: string}}
 */
export function normalizeBatchParamsPatch(raw) {
  if (!raw || typeof raw !== 'object') {
    return { error: '请至少填写一个推荐参数' }
  }
  const patch = {}
  /** 空白 → undefined；可解析 → number；非法 → NaN */
  const num = (v) => {
    if (v === null || v === undefined) return undefined
    if (typeof v === 'string' && v.trim() === '') return undefined
    const n = Number(v)
    return Number.isFinite(n) ? n : NaN
  }
  for (const [key, label, min, max] of NUMBER_FIELDS) {
    const value = num(raw[key])
    if (value === undefined) continue
    if (Number.isNaN(value)) return { error: `${label} 请输入有效数字` }
    if (value < min || value > max) {
      return { error: `${label} 超出合理范围（${min} ~ ${max}）` }
    }
    patch[key] = value
  }
  for (const key of TEXT_FIELDS) {
    const value = typeof raw[key] === 'string' ? raw[key].trim() : ''
    if (value) patch[key] = value
  }
  if (
    patch.cfgMin !== undefined &&
    patch.cfgMax !== undefined &&
    patch.cfgMin > patch.cfgMax
  ) {
    return { error: 'CFG 最小值不能大于最大值' }
  }
  if (
    patch.resMin !== undefined &&
    patch.resMax !== undefined &&
    patch.resMin > patch.resMax
  ) {
    return { error: '最小分辨率不能大于最大分辨率' }
  }
  if (Object.keys(patch).length === 0) {
    return { error: '请至少填写一个推荐参数' }
  }
  return { patch }
}

/** 当前参数是否已完全包含补丁值（无变化模型不进 IPC） */
function isPatchApplied(params, patch) {
  if (!params || typeof params !== 'object') return false
  return Object.entries(patch).every(([key, value]) => params[key] === value)
}

/**
 * 计算本批需要提交的参数补丁（预判与执行共用）：
 * @param {string[]} ids 选中模型 id
 * @param {Record<string, any>} patch 归一化后的参数补丁
 * @param {{get: (id: string) => any}} byId id → 模型映射
 * @returns {{items: Array<{id: string, params: Record<string, any>}>, unchanged: number}}
 */
function collectParamChanges(ids, patch, byId) {
  const items = []
  let unchanged = 0
  for (const id of ids) {
    const model = byId.get(id)
    if (!model) continue
    if (isPatchApplied(model.params, patch)) {
      unchanged += 1
      continue
    }
    items.push({ id, params: { ...patch } })
  }
  return { items, unchanged }
}

/** 记录一条失败明细 */
function failuresPush(list, id, error) {
  list.push({ id, error: error || '未返回结果' })
}

/**
 * 分块提交参数补丁并汇总结果。
 * @param {Array<{id: string, params: Record<string, any>}>} items 待提交项
 * @param {Map<string, any>} metas 成功项参数收集表
 * @param {Array<{id: string, error: string}>} failedItems 失败明细收集表
 * @returns {Promise<number>} 因取消而未提交的条目数
 */
async function submitParamChunks(items, metas, failedItems) {
  let canceled = 0
  let processed = 0
  for (let offset = 0; offset < items.length; offset += MAX_BATCH_META_IDS) {
    if (state.multiSelect.cancelRequested) {
      canceled = items.length - processed
      break
    }
    const chunk = items.slice(offset, offset + MAX_BATCH_META_IDS)
    processed += chunk.length
    state.multiSelect.progress = `推荐参数 ${Math.min(processed, items.length)}/${items.length}`

    let res
    try {
      res = await window.api.models.setModelParamsBulk(chunk)
    } catch (err) {
      for (const item of chunk) {
        failuresPush(failedItems, item.id, errorMessage(err))
      }
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
 * 批量更新选中模型的推荐参数（仅覆盖填写的字段）。
 * @param {Record<string, any>} rawPatch 表单原始值（数字/字符串，空白表示不修改）
 * @returns {Promise<boolean>} 是否至少成功更新一个模型
 */
export async function batchEditParams(rawPatch) {
  const { patch, error } = normalizeBatchParamsPatch(rawPatch)
  if (error) {
    toast('error', error)
    return false
  }
  const ids = [...state.multiSelect.ids]
  if (ids.length === 0 || state.multiSelect.busy) return false
  if (state.multiSelect.cancelRequested) return false

  // 预判参与集：已具备相同参数值的模型不进 IPC
  const preview = collectParamChanges(ids, patch, modelById.value)
  if (preview.items.length === 0) {
    toast(
      'info',
      `没有需要更新推荐参数的模型（${preview.unchanged} 个已具有相同值）`,
    )
    return false
  }

  state.multiSelect.busy = true
  state.multiSelect.progress = ''
  clearBatchFailures()
  let releaseBulkMeta = null
  try {
    // 复用批量元数据写入锁：等待选中模型在途标记/标签操作落定，锁生效
    // 期间新发起的单模型操作排在本批之后，避免旧快照反向覆盖
    releaseBulkMeta = await beginBatchTagsWrite(ids)
    const { items, unchanged } = collectParamChanges(
      ids,
      patch,
      modelById.value,
    )
    if (items.length === 0) {
      toast('info', `没有需要更新推荐参数的模型（${unchanged} 个已具有相同值）`)
      return false
    }

    const metas = new Map()
    const failedItems = []
    const canceled = await submitParamChunks(items, metas, failedItems)

    const failed = reportBatchFailures('批量推荐参数', failedItems)
    const ok = applyMetaUpdates(metas, (meta) => ({
      params: meta.params || null,
    }))
    const notes = []
    if (unchanged > 0) notes.push(`无变化 ${unchanged} 个`)
    if (failed > 0) notes.push(`失败 ${failed} 个`)
    const suffix = notes.length ? `（${notes.join('，')}）` : ''
    if (canceled > 0) {
      toast(
        'warn',
        `推荐参数更新已取消：完成 ${ok}/${items.length}，已完成部分已保存${suffix}`,
      )
    } else if (failed > 0) {
      toast('warn', `推荐参数更新完成：成功 ${ok} 个${suffix}`)
    } else {
      toast('success', `已为 ${ok} 个模型更新推荐参数${suffix}`)
    }
    return ok > 0
  } finally {
    releaseBulkMeta?.()
    state.multiSelect.busy = false
    state.multiSelect.progress = ''
    state.multiSelect.cancelRequested = false
  }
}
