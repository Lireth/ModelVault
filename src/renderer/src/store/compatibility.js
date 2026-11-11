import { computed, nextTick } from 'vue'
import { BASE_MODEL_FAMILIES, state } from './state'
import { visibleModels } from './filter'
import { closeDetail, selectedModel } from './detail'
import { toast } from './toast'
import { normalizeBaseModel } from '../../../shared/model-categories'

/**
 * 基底兼容性（F6）：
 *
 * LoRA 能否与某个 Checkpoint 搭配，取决于二者归一化后的基底家族
 * （Pony / Illustrious / SDXL / SD1.5 / Flux…）。本模块基于库内已有模型
 * 建立「家族 → LoRA / Checkpoint」派生索引，详情页据此展示兼容对象，
 * 并支持一键在列表中筛选同基底模型——纯本地、零网络。
 *
 * 判定口径刻意保守，避免给出虚假确定性：
 * - 未解析到基底文本（''）→ unknown，不猜兼容；
 * - 非空但归入「其他基底」（'other'）→ unclassified，不展示兼容列表
 *   （Hunyuan/Wan/Kolors 等不同生态被统一归类时彼此并不兼容）；
 * - 仅 LoRA / Checkpoint 参与判断，VAE/TextEncoders/其他模型返回 unsupported；
 * - 隐藏 NSFW 开关开启时，兼容列表同样只统计当前可见模型。
 */

/** 家族 key → 展示名（与侧栏基底筛选同一来源） */
const FAMILY_LABELS = Object.fromEntries(
  BASE_MODEL_FAMILIES.map((family) => [family.key, family.label]),
)

/** 显示名：别名优先，回退文件名 */
function displayNameOf(model) {
  return model?.alias || model?.name || ''
}

/** 中文名称排序比较器（模块级复用，避免每次排序构造 Intl） */
const zhCollator = new Intl.Collator('zh-CN')

/** 模型的有效基底文本（Civitai 回填优先于空值；autoInfo 为头部解析） */
function baseTextOf(model) {
  return String(model?.baseModel || model?.autoInfo?.baseModel || '').trim()
}

/**
 * 基底家族派生索引：family → { checkpoint: [], lora: [] }。
 * 只收录可可靠判定（非空且非 other）的 LoRA/Checkpoint；列表按显示名排序。
 * @type {import('vue').ComputedRef<Map<string, {checkpoint: any[], lora: any[]}>>}
 */
const familyIndex = computed(() => {
  /** @type {Map<string, {checkpoint: any[], lora: any[]}>} */
  const map = new Map()
  for (const model of visibleModels.value) {
    if (model.type !== 'lora' && model.type !== 'checkpoint') continue
    const family = normalizeBaseModel(baseTextOf(model))
    if (!family || family === 'other') continue
    let entry = map.get(family)
    if (!entry) {
      entry = { checkpoint: [], lora: [] }
      map.set(family, entry)
    }
    if (model.type === 'lora') entry.lora.push(model)
    else entry.checkpoint.push(model)
  }
  for (const entry of map.values()) {
    entry.checkpoint.sort((a, b) =>
      zhCollator.compare(displayNameOf(a), displayNameOf(b)),
    )
    entry.lora.sort((a, b) =>
      zhCollator.compare(displayNameOf(a), displayNameOf(b)),
    )
  }
  return map
})

/**
 * 当前选中模型的兼容性派生：
 * @returns {{
 *   supported: boolean,
 *   status: 'none'|'unsupported'|'unknown'|'unclassified'|'no-match'|'ok',
 *   family: string,
 *   familyLabel: string,
 *   rawBaseModel: string,
 *   counterpartType: 'checkpoint'|'lora'|'',
 *   counterpartLabel: string,
 *   counterparts: any[],
 *   total: number
 * }}
 */
export const compatibilityInfo = computed(() => {
  const empty = {
    supported: false,
    status: 'none',
    family: '',
    familyLabel: '',
    rawBaseModel: '',
    counterpartType: '',
    counterpartLabel: '',
    counterparts: [],
    total: 0,
  }
  const model = selectedModel.value
  if (!model) return empty

  const rawBaseModel = baseTextOf(model)
  const type = model.type
  if (type !== 'lora' && type !== 'checkpoint') {
    return { ...empty, rawBaseModel, status: 'unsupported' }
  }

  const counterpartType = type === 'lora' ? 'checkpoint' : 'lora'
  const counterpartLabel =
    counterpartType === 'checkpoint' ? 'Checkpoint' : 'LoRA'
  const family = normalizeBaseModel(rawBaseModel)
  const common = {
    supported: true,
    family,
    familyLabel: FAMILY_LABELS[family] || '',
    rawBaseModel,
    counterpartType,
    counterpartLabel,
  }
  if (!family) {
    return { ...empty, ...common, status: 'unknown' }
  }
  if (family === 'other') {
    return { ...empty, ...common, status: 'unclassified' }
  }

  const entry = familyIndex.value.get(family)
  const counterparts = entry
    ? counterpartType === 'checkpoint'
      ? entry.checkpoint
      : entry.lora
    : []
  return {
    ...common,
    supported: true,
    status: counterparts.length > 0 ? 'ok' : 'no-match',
    counterparts,
    total: counterparts.length,
  }
})

/**
 * 「在列表中筛选兼容项」（F6）：关闭详情后把侧栏筛选切到对向模型类型 +
 * 当前基底家族，并清空其它会收窄结果的筛选/搜索，确保用户看到完整兼容集。
 * 详情有未保存修改且用户取消关闭时不改动任何筛选。
 * @returns {Promise<boolean>} 是否已应用筛选
 */
export async function filterCompatibleModels() {
  const info = compatibilityInfo.value
  if (info.status !== 'ok' || !info.family || !info.counterpartType)
    return false
  await closeDetail()
  // 脏表单确认被取消：详情仍打开，保持原筛选不动
  if (state.selectedId) return false
  state.typeFilter = info.counterpartType
  // filter.js 的 typeFilter watcher 会清空 subFilter/baseFilter；等它落定后
  // 再写入基底家族，避免刚设置的 baseFilter 被异步 watcher 抹掉
  await nextTick()
  state.subFilter = ''
  state.baseFilter = info.family
  state.tagFilters = []
  state.showFavoritesOnly = false
  state.showDuplicatesOnly = false
  state.showSuspectOnly = false
  state.search = ''
  toast(
    'info',
    `已筛选 ${info.familyLabel} 的${info.counterpartLabel}（${info.total} 个）`,
  )
  return true
}
