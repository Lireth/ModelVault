import { reactive } from 'vue'

/**
 * 跨库存储总览状态（FN-01）：
 * 数据由主进程只读汇总各库索引/元数据，属于「按需拉取」的弱实时视图，
 * 不进入全局 state.models 的派生链，避免影响当前库的筛选/渲染热路径。
 */

/** 缓存有效期：统计页反复开关时不重复读取各库索引 */
const CACHE_TTL_MS = 60 * 1000

export const libraryOverview = reactive({
  loading: false,
  data: null,
  warnings: [],
  error: '',
  loadedAt: 0
})

/** 请求代际：并发/切库时丢弃过期响应 */
let requestToken = 0

/**
 * 拉取跨库总览。
 * @param {boolean} [force] 忽略缓存强制刷新
 * @returns {Promise<boolean>} 是否成功取得数据
 */
export async function loadLibraryOverview(force = false) {
  if (libraryOverview.loading) return false
  if (
    !force &&
    libraryOverview.data &&
    Date.now() - libraryOverview.loadedAt < CACHE_TTL_MS
  ) {
    return true
  }
  const token = ++requestToken
  libraryOverview.loading = true
  libraryOverview.error = ''
  try {
    const res = await window.api.models.crossLibraryOverview()
    if (token !== requestToken) return false
    if (res?.error) {
      libraryOverview.error = res.error
      return false
    }
    libraryOverview.data = res?.overview || null
    libraryOverview.warnings = Array.isArray(res?.warnings) ? res.warnings : []
    libraryOverview.loadedAt = Date.now()
    return true
  } catch (err) {
    if (token === requestToken) libraryOverview.error = err.message
    return false
  } finally {
    if (token === requestToken) libraryOverview.loading = false
  }
}

/** 清空缓存（切库/退出等场景可显式调用） */
export function resetLibraryOverview() {
  requestToken += 1
  libraryOverview.data = null
  libraryOverview.warnings = []
  libraryOverview.error = ''
  libraryOverview.loadedAt = 0
  libraryOverview.loading = false
}
