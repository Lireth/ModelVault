import { confirmDialog, deleteModel, state, toggleFavorite } from '../store/appStore'

/**
 * 焦点卡片/行快捷动作（网格与列表双视图共用，键盘导航体系）：
 * - F 收藏/取消收藏焦点模型（多选模式下同样只作用于焦点项本身，
 *   批量收藏走 App 层 Ctrl+D）；
 * - Delete 删除焦点模型（自带确认，移入系统回收站）；多选模式下不拦截，
 *   冒泡至 App 层批量删除。
 * Ctrl/Alt 组合键放行（Ctrl+F 等全局快捷键由 App 层处理）；
 * 详情/确认层/设置页打开时不作用于背景项（详情内快捷键由其自身处理）。
 *
 * @param {KeyboardEvent} e keydown 事件
 * @param {{models: Array, indexById: Map<string, number>, focusModel: Function}} ctx
 *   视图上下文：当前列表、id→索引映射、按 id 聚焦函数
 * @returns {boolean} 是否已消费该事件（已 preventDefault + 触发动作）
 */
export function handleModelActionKey(e, ctx) {
  if (e.ctrlKey || e.metaKey || e.altKey) return false
  if (state.confirm.visible || state.selectedId !== null || state.settingsOpen) return false
  const id = document.activeElement?.closest?.('[data-model-id]')?.dataset.modelId
  if (!id) return false
  if (e.key === 'f' || e.key === 'F') {
    e.preventDefault()
    toggleFavorite(id)
    return true
  }
  if (e.key === 'Delete' && !state.multiSelect.active) {
    e.preventDefault()
    deleteFocusedModel(id, ctx)
    return true
  }
  return false
}

/**
 * Delete 删除焦点模型：确认后走既有删除链路（移入回收站 + 关联数据清理），
 * 成功后焦点顺延到原位置项（越界取前一项），避免焦点丢回 body 中断键盘流。
 */
async function deleteFocusedModel(id, { models, indexById, focusModel }) {
  const idx = indexById.get(id)
  const m = idx !== undefined ? models[idx] : null
  if (!m) return
  // 删除前取好顺延目标：删除后列表前移，原位置即下一项
  const nextId = models[idx + 1]?.id ?? models[idx - 1]?.id
  if (!(await confirmDialog(`确定将「${m.alias || m.name}」移入系统回收站吗？`))) return
  if (!(await deleteModel(id))) return
  if (nextId) focusModel(nextId)
}
