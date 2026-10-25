import { onMounted, onUnmounted } from 'vue'
import {
  allFilteredSelected,
  batchDeleteModels,
  batchFavorite,
  exitMultiSelect,
  requestBatchCancel,
  state,
  toast,
  toggleFavorite,
  toggleMultiSelectMode,
  toggleSelectAllFiltered,
} from '../store/appStore'

/**
 * 全局窗口快捷键（B-03，O-4 自 App.vue 按域拆出）：
 * - Ctrl+F 聚焦搜索（面板打开/未选文件夹时无效）；
 * - Esc 逐层退出：多选模式 → 清空搜索词（面板/详情/确认层打开时让位其自有 Esc 逻辑）；
 * - Ctrl+A 进入多选并全选当前筛选结果；Delete 批量移入回收站（自带确认）；
 * - Ctrl+D 多选时批量收藏，详情打开时收藏当前模型；
 * - 网格内焦点卡片快捷键（方向键导航 / F 收藏 / Delete 单卡删除）由 VirtualModelGrid 处理。
 * 输入控件内除 Ctrl+F 外不拦截，避免破坏文本编辑。
 *
 * @param {import('vue').Ref<HTMLElement|null>} searchFieldEl 搜索框 DOM 引用（Ctrl+F 聚焦）
 * @param {() => void} clearSearch 清空搜索（Esc 逐层退出的最后一层）
 */
export function useGlobalShortcuts(searchFieldEl, clearSearch) {
  /** 事件目标是否为可编辑控件（打字场景，除 Ctrl+F 外交由原生行为） */
  function isEditableTarget(e) {
    const t = e.target
    if (!t || !t.tagName) return false
    return (
      t.tagName === 'INPUT' ||
      t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' ||
      t.isContentEditable === true
    )
  }

  /** 内容区被页面占用（设置页/统计页，该场景搜索框不在 DOM 中） */
  function isOverlayPanelOpen() {
    return state.settingsOpen || state.statsOpen
  }

  function onGlobalKeydown(e) {
    const key = e.key.toLowerCase()
    const ctrl = e.ctrlKey || e.metaKey

    // Ctrl+F：只要网格区可用就聚焦搜索（输入态同样适用，便于随时跳转检索）
    if (ctrl && key === 'f') {
      if (isOverlayPanelOpen() || state.scanning || !state.folder) return
      const el = /** @type {any} */ (searchFieldEl.value)
      if (el) {
        e.preventDefault()
        el.focus()
        el.select?.()
      }
      return
    }

    // 输入态保留原生编辑行为；确认层/面板打开时整键让位（F1 独占策略）
    if (isEditableTarget(e) || state.confirm.visible || isOverlayPanelOpen())
      return

    const detailOpen = state.selectedId !== null

    if (e.key === 'Escape') {
      // 详情打开时 Esc 由 ModelDetail 处理（可能涉及脏表单确认）
      if (!detailOpen) {
        // 多选为模式态，优先退出；再次 Esc 才轮到清空搜索词
        if (state.multiSelect.active) {
          // 长耗时批量进行中：Esc 先请求取消而非直接退出多选（防误退丢上下文），
          // 批量收尾后再次 Esc 才退出
          if (state.multiSelect.busy) {
            requestBatchCancel()
            toast('info', '已请求取消批量操作，完成后可再次按 Esc 退出多选')
          } else {
            exitMultiSelect()
          }
          e.preventDefault()
          return
        }
        if (state.search) {
          clearSearch()
          e.preventDefault()
        }
      }
      return
    }

    // 详情打开时仅保留 Ctrl+D 收藏当前模型，其余让位详情
    if (detailOpen) {
      if (ctrl && key === 'd') {
        e.preventDefault()
        toggleFavorite(state.selectedId)
      }
      return
    }

    if (ctrl && key === 'a' && state.models.length > 0) {
      e.preventDefault()
      if (!state.multiSelect.active) toggleMultiSelectMode()
      if (!allFilteredSelected.value) toggleSelectAllFiltered()
      return
    }

    if (
      ctrl &&
      key === 'd' &&
      state.multiSelect.active &&
      state.multiSelect.ids.length > 0
    ) {
      e.preventDefault()
      batchFavorite(true)
      return
    }

    // Delete 仅在多选且有选中时触发（批量删除自带确认层，不会直接删文件）
    if (
      e.key === 'Delete' &&
      state.multiSelect.active &&
      state.multiSelect.ids.length > 0
    ) {
      e.preventDefault()
      batchDeleteModels()
    }
  }

  onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
  onUnmounted(() => window.removeEventListener('keydown', onGlobalKeydown))
}
