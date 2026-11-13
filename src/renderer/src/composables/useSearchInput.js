import { onUnmounted, ref, watch } from 'vue'
import { state } from '../store/appStore'
import { ensurePinyinEngine } from '../store/pinyin'

/**
 * 搜索输入防抖（O-5 自 App.vue 拆出）：
 * - 输入防抖 200ms 写回 state.search，避免大量模型时每键触发过滤；
 * - 反向同步（智能视图应用等外部路径改写 state.search）：回填搜索框显示。
 *   不等才赋值——输入防抖链路随后写回同值，不会形成回环；
 * - 卸载时清理防抖定时器：回调为裸闭包（写 state.search），卸载后若仍到期
 *   会滞后覆写全局搜索词（测试中跨用例竞态的根源）。
 *
 * 由 LibraryToolbar 持有（搜索行随库视图挂载/卸载，状态随组件生灭；
 * state.search 为唯一持久真源）；全局快捷键（Ctrl+F / Esc）经组件
 * defineExpose 取用 searchFieldEl 与 clearSearch。
 */
export function useSearchInput() {
  const searchInput = ref(state.search)
  /** 搜索框 DOM 引用（Ctrl+F 聚焦用） */
  const searchFieldEl = ref(null)
  /** @type {ReturnType<typeof setTimeout> | null} */
  let searchTimer = null

  /**
   * FEAT-07：拉丁字母查询可能走拼音域，按需启动拼音引擎。
   * 动态分块在搜索防抖窗口内加载；就绪后过滤 computed 自动重算。
   */
  function maybeEnsurePinyin(value) {
    if (typeof value === 'string' && /[a-z]/i.test(value)) {
      void ensurePinyinEngine()
    }
  }
  // 智能视图恢复的搜索词可能已是拼音：挂载时补一次
  maybeEnsurePinyin(state.search)

  watch(searchInput, (value) => {
    maybeEnsurePinyin(value)
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => {
      state.search = value
    }, 200)
  })

  watch(
    () => state.search,
    (value) => {
      maybeEnsurePinyin(value)
      if (value !== searchInput.value) {
        if (searchTimer) clearTimeout(searchTimer)
        searchInput.value = value
      }
    },
  )

  function clearSearch() {
    if (searchTimer) clearTimeout(searchTimer)
    searchInput.value = ''
    state.search = ''
  }

  onUnmounted(() => {
    if (searchTimer) clearTimeout(searchTimer)
  })

  return { searchInput, searchFieldEl, clearSearch }
}
