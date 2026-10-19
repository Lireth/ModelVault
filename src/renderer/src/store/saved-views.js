import { computed, nextTick } from 'vue'
import { SORT_OPTIONS, sortDirectional, state, subCategoryInfo, typeInfo } from './state'
import { BASE_FAMILIES } from '../../../shared/model-categories'
import { saveSettings } from './library'
import { toast } from './toast'

/**
 * 智能视图（组合筛选收藏）：
 * 将当前「搜索词 + 分类 + LoRA 子分类 + 基底模型 + 收藏筛选 + 排序」组合
 * 保存为命名视图，侧栏一键切换。视图是平铺筛选字段的命名快照——state
 * 平铺字段始终为活动视图的镜像（B-02 约定），应用视图即整体覆写这些字段，
 * 不引入额外派生筛选态；视图列表持久化在应用设置（settings.savedViews）。
 */

/** 视图上限（与主进程 normalizeSavedViews 的截断一致，先在前置校验拦截） */
const MAX_VIEWS = 20
/** 视图名称长度上限（与主进程一致） */
const MAX_NAME = 30

/** 已保存的视图列表（设置项镜像；无该字段的旧数据回退空数组） */
export const savedViews = computed(() => state.settings.savedViews || [])

/** 当前筛选/排序状态的快照（视图载荷与平铺字段一一对应） */
function snapshotFilters() {
  return {
    search: state.search,
    typeFilter: state.typeFilter,
    subFilter: state.subFilter,
    baseFilter: state.baseFilter,
    showFavoritesOnly: state.showFavoritesOnly,
    showDuplicatesOnly: state.showDuplicatesOnly,
    sortBy: state.sortBy,
    sortAsc: state.sortAsc
  }
}

/** 视图与当前筛选状态逐项一致 */
function viewMatchesCurrent(v) {
  return (
    v.search === state.search &&
    v.typeFilter === state.typeFilter &&
    v.subFilter === state.subFilter &&
    // 旧视图缺省基底筛选时按 '' 参与（F-2）
    (v.baseFilter || '') === state.baseFilter &&
    v.showFavoritesOnly === state.showFavoritesOnly &&
    // 旧视图缺省该字段时按 false 参与（=== true 与 undefined 比较）
    (v.showDuplicatesOnly === true) === state.showDuplicatesOnly &&
    v.sortBy === state.sortBy &&
    v.sortAsc === state.sortAsc
  )
}

/** 当前状态命中的视图 id（侧栏高亮用；无命中为空串） */
export const activeSavedViewId = computed(() => {
  const hit = savedViews.value.find(viewMatchesCurrent)
  return hit ? hit.id : ''
})

/** 视图摘要（侧栏 tooltip）：筛选条件 + 排序；无筛选条件时以「全部模型」兜底 */
export function viewSummary(v) {
  const parts = []
  if (v.typeFilter && v.typeFilter !== 'all') parts.push(typeInfo(v.typeFilter).label)
  if (v.subFilter) parts.push(subCategoryInfo(v.subFilter)?.label || v.subFilter)
  if (v.baseFilter) parts.push(`基底：${BASE_FAMILIES.find((b) => b.key === v.baseFilter)?.label || v.baseFilter}`)
  if (v.showFavoritesOnly) parts.push('仅收藏')
  if (v.showDuplicatesOnly) parts.push('仅重复')
  if (v.search) parts.push(`搜索“${v.search}”`)
  if (parts.length === 0) parts.push('全部模型')
  const sort = SORT_OPTIONS.find((s) => s.key === v.sortBy)
  if (sort) {
    parts.push(sortDirectional(v.sortBy) ? `${sort.label}${v.sortAsc ? '↑' : '↓'}` : sort.label)
  }
  return parts.join(' · ')
}

/** 生成视图 id（时间戳 + 随机段，列表内唯一由保存时同名/上限校验兜底） */
function makeViewId() {
  return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * 将当前筛选组合保存为命名视图（即时持久化到应用设置）。
 * @param {string} name 视图名称（去空白；非空、≤30 字、不区分大小写不重名）
 * @returns {Promise<boolean>} 是否保存成功
 */
export async function saveCurrentAsView(name) {
  const trimmed = String(name || '').trim()
  if (!trimmed) {
    toast('warn', '请输入视图名称')
    return false
  }
  if (trimmed.length > MAX_NAME) {
    toast('warn', `视图名称最长 ${MAX_NAME} 字`)
    return false
  }
  if (savedViews.value.length >= MAX_VIEWS) {
    toast('warn', `最多保存 ${MAX_VIEWS} 个视图，可先删除不常用的`)
    return false
  }
  const lower = trimmed.toLowerCase()
  if (savedViews.value.some((v) => v.name.toLowerCase() === lower)) {
    toast('warn', '已存在同名视图，请换个名称')
    return false
  }
  const view = { id: makeViewId(), name: trimmed, ...snapshotFilters() }
  const ok = await saveSettings({ savedViews: [...savedViews.value, view] })
  if (ok) toast('success', `已保存视图「${trimmed}」`)
  return ok
}

/**
 * 应用视图：整体覆写平铺筛选字段（B-02 镜像），排序随手动改排序的
 * 既有行为持久化，其余筛选条件保持会话态不落盘。
 * @param {string} id 视图 id
 */
export async function applySavedView(id) {
  const v = savedViews.value.find((x) => x.id === id)
  if (!v) return
  state.search = v.search
  state.showFavoritesOnly = v.showFavoritesOnly
  // 旧视图缺省该字段时回退 false（=== true 规避 undefined）
  state.showDuplicatesOnly = v.showDuplicatesOnly === true
  state.sortBy = v.sortBy
  state.sortAsc = v.sortAsc
  // typeFilter 变更会触发 filter.js 的 watcher 清空 subFilter/baseFilter
  // （flush 在微任务）：先切主分类并等该 watcher 落定，再恢复视图携带的
  // 子分类与基底筛选
  state.typeFilter = v.typeFilter
  await nextTick()
  state.subFilter = v.subFilter
  state.baseFilter = v.baseFilter || ''
  await saveSettings({ sortBy: v.sortBy, sortAsc: v.sortAsc })
}

/**
 * 删除视图（即时持久化）。
 * @param {string} id 视图 id
 * @returns {Promise<boolean>} 是否删除成功
 */
export async function deleteSavedView(id) {
  const next = savedViews.value.filter((v) => v.id !== id)
  if (next.length === savedViews.value.length) return false
  const ok = await saveSettings({ savedViews: next })
  if (ok) toast('success', '已删除视图')
  return ok
}
