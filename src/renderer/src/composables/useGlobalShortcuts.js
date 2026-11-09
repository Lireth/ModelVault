import { onMounted, onUnmounted } from 'vue'
import {
  allFilteredSelected,
  batchDeleteModels,
  batchFavorite,
  exitMultiSelect,
  openAdjacentDetail,
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

  /**
   * Ctrl+F：只要网格区可用就聚焦搜索（输入态同样适用，便于随时跳转检索）。
   * 命中按键即消费（即使当前不可动作），避免落到后续列表快捷键。
   * @param {KeyboardEvent} e 键盘事件
   * @param {{key: string, ctrl: boolean}} ctx 归一化按键信息
   * @returns {boolean} 是否已消费
   */
  function handleFocusSearch(e, ctx) {
    if (!ctx.ctrl || ctx.key !== 'f') return false
    if (!isOverlayPanelOpen() && !state.scanning && state.folder) {
      const el = /** @type {any} */ (searchFieldEl.value)
      if (el) {
        e.preventDefault()
        el.focus()
        el.select?.()
      }
    }
    return true
  }

  /**
   * Esc：多选模式优先退出；再次 Esc 才清空搜索词。
   * 详情打开时 Esc 由 ModelDetail 处理（可能涉及脏表单确认）。
   * @param {KeyboardEvent} e 键盘事件
   * @returns {boolean} 是否已消费
   */
  function handleEscape(e) {
    if (e.key !== 'Escape') return false
    if (state.selectedId === null) {
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
      } else if (state.search) {
        clearSearch()
        e.preventDefault()
      }
    }
    return true
  }

  /**
   * 详情打开时：←/→ 序列导航（FEA-01，逐个审阅标注的核心工作流）；
   * Ctrl+D 收藏当前模型；其余按键让位详情自有逻辑。
   * @param {KeyboardEvent} e 键盘事件
   * @param {{key: string, ctrl: boolean}} ctx 归一化按键信息
   * @returns {boolean} 是否处于详情态（详情态下后续列表快捷键不再参与）
   */
  function handleDetailKeys(e, ctx) {
    if (state.selectedId === null) return false
    if (
      (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey
    ) {
      e.preventDefault()
      openAdjacentDetail(e.key === 'ArrowRight' ? 1 : -1)
    } else if (ctx.ctrl && ctx.key === 'd') {
      e.preventDefault()
      toggleFavorite(state.selectedId)
    }
    return true
  }

  /**
   * 列表态多选快捷键：Ctrl+A 全选 / Ctrl+D 批量收藏 /
   * Delete 批量删除（自带确认层，不会直接删文件）。
   * @param {KeyboardEvent} e 键盘事件
   * @param {{key: string, ctrl: boolean}} ctx 归一化按键信息
   */
  function handleListKeys(e, ctx) {
    const hasSelection =
      state.multiSelect.active && state.multiSelect.ids.length > 0
    if (ctx.ctrl && ctx.key === 'a' && state.models.length > 0) {
      e.preventDefault()
      if (!state.multiSelect.active) toggleMultiSelectMode()
      if (!allFilteredSelected.value) toggleSelectAllFiltered()
      return
    }
    if (ctx.ctrl && ctx.key === 'd' && hasSelection) {
      e.preventDefault()
      batchFavorite(true)
      return
    }
    if (e.key === 'Delete' && hasSelection) {
      e.preventDefault()
      batchDeleteModels()
    }
  }

  function onGlobalKeydown(e) {
    const ctx = {
      key: e.key.toLowerCase(),
      ctrl: e.ctrlKey || e.metaKey,
    }
    // 有序分发：Ctrl+F 在各态均优先；随后输入态/确认层/面板整键让位，
    // 最后按详情态/列表态分流（详情态消费全部按键，不落到列表快捷键）
    if (handleFocusSearch(e, ctx)) return
    if (isEditableTarget(e) || state.confirm.visible || isOverlayPanelOpen())
      return
    if (handleEscape(e)) return
    if (handleDetailKeys(e, ctx)) return
    handleListKeys(e, ctx)
  }

  onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
  onUnmounted(() => window.removeEventListener('keydown', onGlobalKeydown))
}
