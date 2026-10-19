import { computed } from 'vue'
import { state } from '../state'
import { filteredModels, duplicateGroups } from '../filter'
import { modelById } from '../selectors'

/**
 * 多选选择机制（E4，O-4 自 multiselect.js 按域拆出）：
 * 多选模式开关、单选/全选/范围选择/反选（资源管理器同语义）、
 * 重复模型冗余副本选择（FEAT-1）。批量操作见 batch-*.js 兄弟模块，
 * 对外经 multiselect.js 门面统一导出（appStore 与测试的导入路径不变）。
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

/** 选中模型的类型是否一致（仅 re-export 保留，供上层判断选区构成） */
export const multiSelectUniformType = computed(() => {
  const sel = multiSelectedModels.value
  if (sel.length === 0) return null
  const type = sel[0].type
  return sel.every((m) => m.type === type) ? type : null
})

/** 进入/退出多选模式（退出时清空选择） */
export function toggleMultiSelectMode() {
  state.multiSelect.active = !state.multiSelect.active
  state.multiSelect.ids = []
  clearSelectionAnchor()
}

/** 退出多选模式 */
export function exitMultiSelect() {
  state.multiSelect.active = false
  state.multiSelect.ids = []
  clearSelectionAnchor()
}

/** 切换单个模型的选中态 */
export function toggleSelect(id) {
  const ids = state.multiSelect.ids
  const idx = ids.indexOf(id)
  if (idx >= 0) ids.splice(idx, 1)
  else ids.push(id)
  selectionAnchorId = id
}

/** 当前筛选结果是否已全选（命中判断走 multiSelectIdSet，O4） */
export const allFilteredSelected = computed(() => {
  const filtered = filteredModels.value
  // 快速路径：选中数少于筛选结果数必不全选，免去 O(n) 逐项扫描（部分选中时每次点击都触发）
  if (filtered.length === 0 || state.multiSelect.ids.length < filtered.length) return false
  return filtered.every((m) => multiSelectIdSet.value.has(m.id))
})

/** 全选/取消全选（作用范围为当前筛选结果） */
export function toggleSelectAllFiltered() {
  if (allFilteredSelected.value) {
    state.multiSelect.ids = []
  } else {
    state.multiSelect.ids = filteredModels.value.map((m) => m.id)
  }
  clearSelectionAnchor()
}

/* ---------------- 选择范围与反选（文件管理器惯例语义） ---------------- */

/**
 * Shift 范围选择的锚点 id（上次点击选中的项）。非响应式：仅作为点击
 * 间的记忆，不参与渲染；经 filteredModels 实时解析索引以适应重排序。
 */
let selectionAnchorId = ''

function clearSelectionAnchor() {
  selectionAnchorId = ''
}

/**
 * Shift+点击范围选择（仅多选模式）：选中锚点到目标项之间的全部模型，
 * 并**替换**现有选区（与资源管理器同语义）。锚点无效（从未点击过、
 * 已退出多选、或锚项不在当前筛选结果中）时退化为普通切换并以目标项
 * 重新锚定。
 * @param {string} id Shift+点击的目标模型 id
 */
export function selectRangeTo(id) {
  const filtered = filteredModels.value
  const anchorIdx = filtered.findIndex((m) => m.id === selectionAnchorId)
  const targetIdx = filtered.findIndex((m) => m.id === id)
  if (anchorIdx < 0 || targetIdx < 0) {
    // 锚失效或目标不在筛选范围内：退化为普通切换（并重建锚）
    toggleSelect(id)
    return
  }
  const [from, to] = anchorIdx <= targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx]
  const range = []
  for (let i = from; i <= to; i++) range.push(filtered[i].id)
  state.multiSelect.ids = range
}

/** 当前筛选结果 id 集合（反选保留判断用，随 filteredModels 缓存） */
const filteredSet = computed(() => new Set(filteredModels.value.map((m) => m.id)))

/**
 * 反选（仅多选模式，文件管理器惯例）：当前筛选范围内选中态取反，
 * 筛选范围外已选中的项保留不动。
 */
export function invertSelectionFiltered() {
  const selected = multiSelectIdSet.value
  const inverted = []
  for (const m of filteredModels.value) {
    if (!selected.has(m.id)) inverted.push(m.id)
  }
  // 筛选范围外的已选项原样保留（用户可能在别的筛选下选过）
  for (const id of state.multiSelect.ids) {
    if (!filteredSet.value.has(id)) inverted.push(id)
  }
  state.multiSelect.ids = inverted
}

/* ---------------- 重复清理辅助（FEAT-1） ---------------- */

/**
 * 组内「最优保留」比较：a 是否优于 b。
 * 语义：评分高 > 已收藏 > 文件最新（下载/修改时间）；同哈希文件大小必然
 * 一致，无需参与；id 兜底保证完全平手时的确定性。
 */
function betterDuplicate(a, b) {
  if (a.rating !== b.rating) return a.rating > b.rating
  if (a.favorite !== b.favorite) return a.favorite
  if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs > b.mtimeMs
  return a.id < b.id
}

/**
 * 重复清理向导入口（FEAT-1）：为每个重复组保留最优一份，其余（冗余副本）
 * 全部加入多选——用户复核后经既有批量删除（移入回收站并清理关联数据）
 * 完成清理。进入多选但保留模式状态；无重复组时不动作。
 * @returns {number} 加入多选的冗余副本数量
 */
export function selectRedundantDuplicates() {
  const groups = duplicateGroups.value
  if (groups.length === 0) return 0
  const keep = new Set()
  for (const g of groups) {
    let best = g.models[0]
    for (const m of g.models) {
      if (betterDuplicate(m, best)) best = m
    }
    keep.add(best.id)
  }
  const redundant = []
  for (const g of groups) {
    for (const m of g.models) {
      if (!keep.has(m.id)) redundant.push(m.id)
    }
  }
  if (redundant.length === 0) return 0
  if (!state.multiSelect.active) state.multiSelect.active = true
  state.multiSelect.ids = redundant
  clearSelectionAnchor()
  return redundant.length
}

/* ---------------- 批量取消（Esc 防误退：长批量先取消而非退出多选） ---------------- */

/**
 * 请求取消当前进行中的批量操作：仅 busy 期间生效，串行批量循环
 * （识别/示例图/禁用）每轮顶部检查后提前收尾；并发型批量
 * （收藏/评分等 Promise.allSettled）无中途取消点，不受影响。
 * 标志位由各批量操作的 finally 统一复位。
 */
export function requestBatchCancel() {
  if (state.multiSelect.busy) state.multiSelect.cancelRequested = true
}
