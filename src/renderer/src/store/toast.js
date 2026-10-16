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
  // 逐字段赋值而非整体替换：state.confirm 是 reactive 代理，整体替换会以
  // 原始对象覆盖代理（shallowReactive 不做深代理），后续 confirmDialog 的
  // 逐字段赋值将失去响应性——第二次及以后的确认弹窗不再显示（await 永久挂起）
  state.confirm.visible = false
  state.confirm.text = ''
  state.confirm.resolve = null
  resolve?.(true)
}

export function rejectConfirm() {
  const resolve = state.confirm.resolve
  state.confirm.visible = false
  state.confirm.text = ''
  state.confirm.resolve = null
  resolve?.(false)
}
