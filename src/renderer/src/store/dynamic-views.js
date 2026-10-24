import { computed } from 'vue'
import { state } from './state'

/**
 * 内置动态智能视图（FN-07）：
 * 与「保存当前筛选组合」的静态快照不同，这里提供随模型变化实时求值的
 * 规则视图（未评分 / 近 30 天更新 / 30 天未更新），计数与命中始终最新。
 * 规则复用 OP-06 的搜索语法（score/mtime），不引入额外筛选状态。
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** 动态视图定义（search 为应用时写入搜索框的规则） */
const DEFINITIONS = [
  { key: 'unrated', label: '未评分', search: 'score:0', title: '评分仍为 0 的模型' },
  {
    key: 'recent',
    label: '近 30 天更新',
    search: 'mtime:<30d',
    title: '文件修改时间在最近 30 天内的模型'
  },
  {
    key: 'stale',
    label: '30 天未更新',
    search: 'mtime:>30d',
    title: '文件超过 30 天未修改的模型'
  }
]

/** 规则命中判定（与 search-query 的对应 token 语义保持一致） */
function matches(def, m, now) {
  if (def.key === 'unrated') return !(m.rating > 0)
  const mtime = Number(m.mtimeMs)
  if (!Number.isFinite(mtime) || mtime <= 0) return false
  const age = now - mtime
  return def.key === 'recent' ? age < 30 * DAY_MS : age > 30 * DAY_MS
}

/** 动态视图列表（含实时计数） */
export const dynamicViews = computed(() => {
  const now = Date.now()
  const counts = new Map(DEFINITIONS.map((d) => [d.key, 0]))
  for (const m of state.models) {
    for (const def of DEFINITIONS) {
      if (matches(def, m, now)) counts.set(def.key, counts.get(def.key) + 1)
    }
  }
  return DEFINITIONS.map((def) => ({
    key: def.key,
    label: def.label,
    search: def.search,
    title: def.title,
    count: counts.get(def.key) || 0
  }))
})

/** 当前筛选状态是否恰好等于某条动态规则（侧栏高亮；其他筛选须全部复位） */
export const activeDynamicViewKey = computed(() => {
  if (
    state.typeFilter !== 'all' ||
    state.subFilter ||
    state.baseFilter ||
    state.tagFilters.length > 0 ||
    state.showFavoritesOnly ||
    state.showDuplicatesOnly
  ) {
    return ''
  }
  const hit = DEFINITIONS.find((def) => state.search.trim() === def.search)
  return hit ? hit.key : ''
})

/**
 * 应用动态视图（再次点击当前规则则清除搜索）。
 * 动态视图是「全库规则」，应用时复位分类/标签/收藏等窄化筛选，
 * 避免与规则叠加后计数与结果不一致。
 * @param {string} key 动态视图 key
 */
export function applyDynamicView(key) {
  const def = DEFINITIONS.find((d) => d.key === key)
  if (!def) return
  state.typeFilter = 'all'
  state.subFilter = ''
  state.baseFilter = ''
  state.tagFilters = []
  state.showFavoritesOnly = false
  state.showDuplicatesOnly = false
  state.search = state.search.trim() === def.search ? '' : def.search
}
