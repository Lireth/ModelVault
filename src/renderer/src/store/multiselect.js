import { computed } from 'vue'
import { state, replaceModels, tagsForType } from './state'
import { toast, confirmDialog } from './toast'
import { applyMetaUpdates } from './meta-apply'
import { filteredModels } from './filter'
import { modelById } from './selectors'

/**
 * 多选批量操作（E4/E6，A-04 自 appStore.js 拆出）。
 */

/**
 * 选中 id 集合（O4）：卡片选中态与全选判断 O(1) 命中，替代对 ids 数组的
 * includes 线性扫描（全选后每张可见卡片渲染均为 O(n)，整体 O(n²)）。
 */
export const multiSelectIdSet = computed(() => new Set(state.multiSelect.ids))

/** 多选模式下选中的模型对象列表（经 modelById O(k) 命中） */
export const multiSelectedModels = computed(() => {
  const byId = modelById.value
  const out = []
  for (const id of state.multiSelect.ids) {
    const m = byId.get(id)
    if (m) out.push(m)
  }
  return out
})

/** 选中模型的类型是否一致（批量设置分类标签仅在类型一致且可标注时提供） */
export const multiSelectUniformType = computed(() => {
  const sel = multiSelectedModels.value
  if (sel.length === 0) return null
  const type = sel[0].type
  return sel.every((m) => m.type === type) ? type : null
})

/** 批量编辑可用的分类标签（仅 other/lora 支持手动标注；checkpoint 为自动基底分类） */
export const multiSelectTags = computed(() => {
  const type = multiSelectUniformType.value
  if (type !== 'other' && type !== 'lora') return []
  return tagsForType(type) || []
})

/** 进入/退出多选模式（退出时清空选择） */
export function toggleMultiSelectMode() {
  state.multiSelect.active = !state.multiSelect.active
  state.multiSelect.ids = []
}

/** 退出多选模式 */
export function exitMultiSelect() {
  state.multiSelect.active = false
  state.multiSelect.ids = []
}

/** 切换单个模型的选中态 */
export function toggleSelect(id) {
  const ids = state.multiSelect.ids
  const idx = ids.indexOf(id)
  if (idx >= 0) ids.splice(idx, 1)
  else ids.push(id)
}

/** 当前筛选结果是否已全选（命中判断走 multiSelectIdSet，O4） */
export const allFilteredSelected = computed(
  () =>
    filteredModels.value.length > 0 &&
    filteredModels.value.every((m) => multiSelectIdSet.value.has(m.id))
)

/** 全选/取消全选（作用范围为当前筛选结果） */
export function toggleSelectAllFiltered() {
  if (allFilteredSelected.value) {
    state.multiSelect.ids = []
  } else {
    state.multiSelect.ids = filteredModels.value.map((m) => m.id)
  }
}

/**
 * 批量更新快捷标记（收藏/NSFW/评分，E6）：复用 setMetaFlags 既有校验与
 * 持久化管线，并发逐个调用；结果收集为 Map 后经 applyMetaUpdates 单趟
 * 同步本地状态（O2），避免逐个落定造成的多次响应式失效。
 * in-flight 防护（B6）：执行期间置 busy，批量操作栏按钮禁用，防止连点
 * 对同一批模型重复提交数百个 IPC。
 * @param {object} patch { favorite?/nsfw?/rating? }
 * @param {string} label 完成提示文案（如「收藏」）
 */
async function batchApplyFlags(patch, label) {
  const ids = [...state.multiSelect.ids]
  if (ids.length === 0 || state.multiSelect.busy) return
  state.multiSelect.busy = true
  try {
    const results = await Promise.allSettled(
      ids.map((id) => window.api.models.setMetaFlags({ id, ...patch }))
    )
    const metaMap = new Map()
    let fail = 0
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value?.meta) metaMap.set(ids[i], r.value.meta)
      else fail += 1
    })
    const ok = applyMetaUpdates(metaMap, (meta) => ({
      favorite: meta.favorite === true,
      nsfw: meta.nsfw === true,
      rating: meta.rating || 0
    }))
    if (fail === 0) toast('success', `已为 ${ok} 个模型${label}`)
    else toast('warn', `${label}完成：成功 ${ok} 个，失败 ${fail} 个`)
  } finally {
    state.multiSelect.busy = false
  }
}

/** 批量收藏/取消收藏 */
export function batchFavorite(favorite) {
  return batchApplyFlags({ favorite }, favorite ? '收藏' : '取消收藏')
}

/** 批量设置 NSFW 标记 */
export function batchNsfw(nsfw) {
  return batchApplyFlags({ nsfw }, nsfw ? '标记 NSFW' : '取消 NSFW')
}

/** 批量评分 */
export function batchRating(rating) {
  return batchApplyFlags({ rating }, `评分 ${rating} 星`)
}

/**
 * 批量设置分类标签（E6）：直连 saveModelData IPC（校验与合并保存在主进程
 * 服务端管线，其余字段不受影响），并发逐个调用；结果收集为 Map 后经
 * applyMetaUpdates 单趟同步本地状态（O2）。
 * @param {string} subCategory 分类标签 key
 */
export async function batchSetSubCategory(subCategory) {
  const ids = [...state.multiSelect.ids]
  if (ids.length === 0 || state.multiSelect.busy) return
  state.multiSelect.busy = true
  try {
    const results = await Promise.allSettled(
      ids.map((id) => window.api.models.saveModelData({ id, subCategory }))
    )
    const metaMap = new Map()
    let fail = 0
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value?.meta) metaMap.set(ids[i], r.value.meta)
      else fail += 1
    })
    const ok = applyMetaUpdates(metaMap, (meta) => ({
      params: meta.params,
      alias: meta.alias || '',
      note: meta.note,
      subCategory: meta.subCategory || '',
      triggerWords: meta.triggerWords || ''
    }))
    if (fail === 0) toast('success', `已为 ${ok} 个模型设置标签`)
    else toast('warn', `标签设置完成：成功 ${ok} 个，失败 ${fail} 个`)
  } finally {
    state.multiSelect.busy = false
  }
}

/**
 * 批量填入自动触发词（F3）：把各模型 safetensors 头部解析出的训练标签
 * 候选（ss_tag_frequency 高频词）写入其触发词字段。触发词是 LoRA 的
 * 「使用说明」，画图时找不到触发词是该品类最高频挫败点。
 * 仅处理「触发词为空且有候选」的模型——绝不覆盖用户已有标注
 * （与 sidecar 自动导入的「空字段才写入」同一原则）。
 */
export async function batchApplyTriggers() {
  const ids = [...state.multiSelect.ids]
  if (ids.length === 0 || state.multiSelect.busy) return
  const byId = modelById.value
  // 目标：有候选且当前无触发词的模型；其余静默跳过（汇总提示）
  const targets = []
  for (const id of ids) {
    const m = byId.get(id)
    const candidates = Array.isArray(m?.autoInfo?.triggerCandidates) ? m.autoInfo.triggerCandidates : []
    if (!m || m.triggerWords || candidates.length === 0) continue
    targets.push({ id, triggerWords: candidates.join(', ') })
  }
  if (targets.length === 0) {
    toast('info', '选中模型均已有触发词或无自动解析候选')
    return
  }
  state.multiSelect.busy = true
  try {
    const results = await Promise.allSettled(
      targets.map(({ id, triggerWords }) =>
        window.api.models.saveModelData({ id, triggerWords })
      )
    )
    const metaMap = new Map()
    let fail = 0
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value?.meta) metaMap.set(targets[i].id, r.value.meta)
      else fail += 1
    })
    const ok = applyMetaUpdates(metaMap, (meta) => ({
      triggerWords: meta.triggerWords || '',
      triggerWordsSource: meta.triggerWordsSource || ''
    }))
    const skipped = ids.length - targets.length
    const suffix = skipped > 0 ? `（${skipped} 个已有触发词或无候选，未改动）` : ''
    if (fail === 0) toast('success', `已为 ${ok} 个模型填入触发词${suffix}`)
    else toast('warn', `触发词填入完成：成功 ${ok} 个，失败 ${fail} 个${suffix}`)
  } finally {
    state.multiSelect.busy = false
  }
}

/**
 * 批量禁用/启用（F10）：逐个调用 toggleDisabled 改名（主进程按文件独立
 * 处理，顺序执行避免同目录大量并发 rename），全部完成后重扫刷新列表
 * （文件 id 全部已变）并统一提示。禁用是可逆操作（去后缀即恢复）。
 * @param {boolean} disabled 目标状态
 */
export async function batchToggleDisabled(disabled) {
  const ids = [...state.multiSelect.ids]
  if (ids.length === 0 || state.multiSelect.busy) return
  state.multiSelect.busy = true
  let ok = 0
  let fail = 0
  try {
    for (const id of ids) {
      const res = await window.api.models.toggleDisabled(id, disabled).catch(() => null)
      if (res && !res.error) ok += 1
      else fail += 1
    }
    if (ok > 0) {
      // id 已全部变化，整表重扫收敛（含元数据键已即时迁移的验证）
      const { scanModels } = await import('./library')
      if (!state.scanning) await scanModels()
    }
    const label = disabled ? '禁用' : '启用'
    if (fail === 0) toast('success', `已${label} ${ok} 个模型`)
    else toast('warn', `${label}完成：成功 ${ok} 个，失败 ${fail} 个`)
  } finally {
    state.multiSelect.busy = false
  }
}

/**
 * 批量移入回收站（E4）：并发调用既有删除链路（含 sidecar 清理与元数据移除，
 * 主进程按文件独立处理、元数据走防抖原子持久化，可安全并发），全部 IPC
 * 结束后单趟移除已删除模型（O2）并统一提示。
 */
export async function batchDeleteModels() {
  const ids = [...state.multiSelect.ids]
  if (ids.length === 0 || state.multiSelect.busy) return
  state.multiSelect.busy = true
  try {
    if (
      !(await confirmDialog(
        `确定将选中的 ${ids.length} 个模型移入系统回收站吗？可在系统回收站恢复。`
      ))
    ) {
      return
    }
    const results = await Promise.allSettled(ids.map((id) => window.api.models.deleteModel(id)))
    const deletedIds = new Set()
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && !r.value?.error) deletedIds.add(ids[i])
    })
    if (deletedIds.size > 0) {
      // 单趟移除：整体替换数组（须经 replaceModels 保持数组代理），selectedId 与多选选区同步按 Set 清理
      replaceModels(state.models.filter((m) => !deletedIds.has(m.id)))
      if (deletedIds.has(state.selectedId)) state.selectedId = null
      state.multiSelect.ids = state.multiSelect.ids.filter((id) => !deletedIds.has(id))
    }
    const ok = deletedIds.size
    const fail = ids.length - ok
    if (fail === 0) toast('success', `已将 ${ok} 个模型移入回收站，可在系统回收站恢复`)
    else toast('warn', `删除完成：成功 ${ok} 个，失败 ${fail} 个`)
  } finally {
    state.multiSelect.busy = false
  }
}
