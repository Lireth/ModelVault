import { state } from './state'

/**
 * 轻提示与自定义确认层（A-04 自 appStore.js 拆出）。
 * 仅依赖响应式 state，无业务逻辑。
 */

let toastSeq = 0

/** 弹出轻提示 */
export function toast(type, text, duration = 3200) {
  const id = ++toastSeq
  state.toasts.push({ id, type, text })
  setTimeout(() => {
    dismissToast(id)
  }, duration)
}

/** 手动关闭轻提示（U6：Toast 关闭按钮） */
export function dismissToast(id) {
  const idx = state.toasts.findIndex((t) => t.id === id)
  if (idx >= 0) state.toasts.splice(idx, 1)
}

/**
 * 弹出自定义确认层（U4），resolve(true) 确认 / resolve(false) 取消。
 * 同时仅允许一个确认（后者覆盖前者的 resolve，前一个静默取消）。
 * @param {string} text 确认提示文案
 * @returns {Promise<boolean>}
 */
export function confirmDialog(text) {
  return new Promise((resolve) => {
    state.confirm.resolve?.(false)
    state.confirm.visible = true
    state.confirm.text = text
    state.confirm.resolve = resolve
  })
}

/** 确认层按钮回调（U4） */
export function acceptConfirm() {
  const resolve = state.confirm.resolve
  state.confirm = { visible: false, text: '', resolve: null }
  resolve?.(true)
}

export function rejectConfirm() {
  const resolve = state.confirm.resolve
  state.confirm = { visible: false, text: '', resolve: null }
  resolve?.(false)
}
