// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount } from '@vue/test-utils'
import {
  escStackDepth,
  isComposingKey,
  useEscStack,
} from '../src/renderer/src/composables/useEscStack'

/**
 * 浮层 Esc 模态栈单元测试（P0-1）：
 * - 挂载即入栈 / 卸载出栈、active 源随打开态同步入出栈（flush sync）；
 * - LIFO 派发：Esc 整键归栈顶，栈顶出栈后回落次顶；
 * - 独占消费：栈非空时阻断全局层（stopPropagation），busy 守卫拦截时同样独占；
 * - IME 组合态让位：不派发也不阻断（Esc 取消候选词属原生语义）。
 */

/** window 直派 Esc（真实按键以焦点元素为目标，capture 派发器先行） */
function pressEsc(init = {}) {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
    ...init,
  })
  window.dispatchEvent(event)
  return event
}

/** 以最小宿主组件挂载一个 Esc 作用域 */
function mountScope(onClose, active) {
  const host = defineComponent({
    setup() {
      useEscStack(onClose, active ? { active } : {})
      return () => h('div')
    },
  })
  return mount(host)
}

beforeEach(() => {
  // 前序用例的作用域必须已随卸载出栈，杜绝跨用例栈泄漏
  expect(escStackDepth()).toBe(0)
})

describe('useEscStack 模态栈（P0-1）', () => {
  it('isComposingKey：isComposing 与 keyCode 229 判组合态', () => {
    expect(isComposingKey({ isComposing: true })).toBe(true)
    expect(isComposingKey({ keyCode: 229 })).toBe(true)
    expect(isComposingKey({ isComposing: false, keyCode: 0 })).toBe(false)
  })

  it('挂载即打开：Esc 归本作用域，卸载后不再派发', () => {
    const onClose = vi.fn()
    const wrapper = mountScope(onClose)
    pressEsc()
    expect(onClose).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    pressEsc()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('LIFO：后开者持有 Esc，栈顶出栈后回落次顶', () => {
    const bottom = vi.fn()
    const top = vi.fn()
    const bottomWrapper = mountScope(bottom)
    const topWrapper = mountScope(top)
    pressEsc()
    expect(top).toHaveBeenCalledTimes(1)
    expect(bottom).not.toHaveBeenCalled()
    topWrapper.unmount()
    pressEsc()
    expect(bottom).toHaveBeenCalledTimes(1)
    expect(top).toHaveBeenCalledTimes(1)
    bottomWrapper.unmount()
  })

  it('active 源：随打开态同步入/出栈（flush sync，同 tick 生效）', () => {
    const onClose = vi.fn()
    const open = ref(false)
    const wrapper = mountScope(onClose, () => open.value)
    pressEsc()
    expect(onClose).not.toHaveBeenCalled()
    open.value = true
    pressEsc()
    expect(onClose).toHaveBeenCalledTimes(1)
    open.value = false
    pressEsc()
    expect(onClose).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('栈非空独占消费：全局层收不到 Esc', () => {
    const onClose = vi.fn()
    const globalListener = vi.fn()
    window.addEventListener('keydown', globalListener)
    const wrapper = mountScope(onClose)
    pressEsc()
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(globalListener).not.toHaveBeenCalled()
    wrapper.unmount()
    window.removeEventListener('keydown', globalListener)
  })

  it('busy 守卫拦截时事件同样被独占消费（浮层打开期间全局 Esc 不参与）', () => {
    // 守卫型 onClose：被调用但不产生实际关闭（如 multiSelect.busy）
    const guardedClose = vi.fn(() => {})
    const globalListener = vi.fn()
    window.addEventListener('keydown', globalListener)
    const wrapper = mountScope(guardedClose)
    pressEsc()
    expect(guardedClose).toHaveBeenCalledTimes(1)
    expect(globalListener).not.toHaveBeenCalled()
    wrapper.unmount()
    window.removeEventListener('keydown', globalListener)
  })

  it('IME 组合态让位：不派发也不阻断（Esc 取消候选词属原生语义）', () => {
    const onClose = vi.fn()
    const globalListener = vi.fn()
    window.addEventListener('keydown', globalListener)
    const wrapper = mountScope(onClose)
    const composing = pressEsc({ isComposing: true })
    expect(onClose).not.toHaveBeenCalled()
    expect(globalListener).toHaveBeenCalledTimes(1)
    expect(composing.defaultPrevented).toBe(false)
    wrapper.unmount()
    window.removeEventListener('keydown', globalListener)
  })

  it('同作用域幂等 push/pop，卸载兜底出栈（active 停留打开态直接卸载）', () => {
    const open = ref(true)
    const wrapper = mountScope(vi.fn(), () => open.value)
    expect(escStackDepth()).toBe(1)
    open.value = true // 重复赋同值：watch 不触发，无重复入栈
    expect(escStackDepth()).toBe(1)
    wrapper.unmount() // active 仍为 true 时卸载：onScopeDispose 兜底出栈
    expect(escStackDepth()).toBe(0)
  })
})
