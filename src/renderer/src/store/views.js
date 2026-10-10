import { computed, nextTick, watch } from 'vue'
import { state, typeInfo, subCategoryInfo } from './state'

/**
 * 多视图标签页（B-02）：
 * 每个标签页独立持有一套筛选/搜索/排序状态，切换标签页互不干扰，
 * 便于同时保留「全部 / 某分类 / 某搜索词 / 收藏」等多个浏览视图。
 *
 * 实现方式：state 上的平铺筛选字段（typeFilter/subFilter/showFavoritesOnly/
 * search/sortBy/sortAsc）始终是**活动视图的镜像**——既有组件全部
 * 继续读写 state.xxx，零改造；切换时快照旧视图、整体换入新视图，
 * 字段变更经侦听器自动回写活动视图。
 */

/** 每个视图持有的字段（平铺镜像字段全集） */
export const VIEW_FIELDS = [
  'typeFilter',
  'subFilter',
  'showFavoritesOnly',
  'search',
  'sortBy',
  'sortAsc'
]

/** 标签页数量上限，避免无限新建 */
export const MAX_VIEWS = 8

let viewSeq = 0

/** 新视图默认值：筛选全空，排序沿用当前应用设置（最近一次选择） */
export function createView(overrides = {}) {
  viewSeq += 1
  return {
    id: `view-${Date.now().toString(36)}-${viewSeq}`,
    typeFilter: 'all',
    subFilter: '',
    showFavoritesOnly: false,
    search: '',
    sortBy: state.settings.sortBy || state.sortBy || 'name',
    sortAsc: state.settings.sortAsc !== false,
    ...overrides
  }
}

/** 播种默认视图（模块加载时执行一次） */
export function initViews() {
  if (state.views.length > 0) return
  const view = createView()
  state.views = [view]
  state.activeViewId = view.id
}

/** 活动视图原始对象 */
export const activeView = computed(
  () => state.views.find((v) => v.id === state.activeViewId) || null
)

/** 切换期间抑制 filter.js 的「切主分类清空子分类」联动（目标视图自带子分类） */
let applying = false
export function isApplyingView() {
  return applying
}

/** 把当前平铺字段快照进指定视图 */
function snapshotInto(view) {
  if (!view) return
  for (const f of VIEW_FIELDS) view[f] = state[f]
}

/** 把视图字段铺到 state（nextTick 后解除抑制，等 pre 侦听器跑完） */
async function applyFrom(view) {
  applying = true
  try {
    for (const f of VIEW_FIELDS) state[f] = view[f]
    await nextTick()
  } finally {
    applying = false
  }
}

/**
 * 切换活动标签页：先快照当前视图，再整体换入目标视图字段。
 * @param {string} id 目标视图 id
 */
export function switchView(id) {
  if (id === state.activeViewId) return
  const target = state.views.find((v) => v.id === id)
  if (!target) return
  snapshotInto(activeView.value)
  state.activeViewId = id
  applyFrom(target)
}

/** 新建标签页（沿用当前排序，筛选条件为全新默认）；达到上限返回 null */
export function addView() {
  if (state.views.length >= MAX_VIEWS) return null
  snapshotInto(activeView.value)
  const view = createView()
  state.views.push(view)
  state.activeViewId = view.id
  applyFrom(view)
  return view
}

/** 关闭标签页（至少保留一个）；关闭活动页时激活前一个（否则首个） */
export function closeView(id) {
  if (state.views.length <= 1) return
  const idx = state.views.findIndex((v) => v.id === id)
  if (idx < 0) return
  const wasActive = state.activeViewId === id
  state.views.splice(idx, 1)
  if (wasActive) {
    const next = state.views[Math.max(0, idx - 1)]
    state.activeViewId = next.id
    applyFrom(next)
  }
}

/**
 * 视图自动命名（标签标题）：按最具区分度的条件取一个。
 * 搜索词 > 收藏 > LoRA 子分类 > 主分类 > 视图序号。
 * @param {object} view 视图对象
 * @param {number} index 视图序号（从 0 开始）
 */
export function viewLabel(view, index) {
  if (view.search) return `搜索：${view.search.slice(0, 12)}`
  if (view.showFavoritesOnly) return '★ 收藏'
  if (view.subFilter) {
    const info = subCategoryInfo(view.subFilter)
    return info ? info.label : '分类'
  }
  if (view.typeFilter && view.typeFilter !== 'all') {
    return typeInfo(view.typeFilter).label
  }
  return `视图 ${index + 1}`
}

/** 测试用：复位为单一默认视图并把平铺字段恢复默认 */
export function resetViews() {
  viewSeq = 0
  state.views = []
  initViews()
  const view = activeView.value
  applying = true
  try {
    for (const f of VIEW_FIELDS) state[f] = view[f]
  } finally {
    applying = false
  }
}

// 平铺字段任意变化时自动回写活动视图（组件直接 mutate state 即可持久到标签页）
watch(
  () => VIEW_FIELDS.map((f) => state[f]),
  () => {
    snapshotInto(activeView.value)
  }
)

initViews()
