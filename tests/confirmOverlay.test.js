// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ConfirmOverlay from '../src/renderer/src/components/ConfirmOverlay.vue'
import { confirmDialog, state } from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * ConfirmOverlay 组件测试（C4 数据关键 UI 补齐）：
 * 自定义确认层此前 40% 覆盖率，但它是删除/覆盖/恢复等破坏性操作的最终
 * 确认关口。本文件覆盖打开文案与焦点、确定/取消/遮罩点击、Esc/Enter、
 * Tab 焦点陷阱与关闭后状态复位。
 */

setupComponentTest()

/** 打开确认层并挂载（Teleport 桩内联渲染） */
async function mountConfirm(text = '确定执行该操作？') {
  // 先挂载（visible=false）再打开：组件焦点 watcher 只在可见性变化时触发，
  // 与生产链路（根组件常驻、操作时才弹确认）一致
  const wrapper = mount(ConfirmOverlay, {
    attachTo: document.body,
    global: { stubs: { Teleport: true } },
  })
  await flushPromises()
  const result = confirmDialog(text)
  await flushPromises()
  return { wrapper, result }
}

describe('ConfirmOverlay 交互', () => {
  it('未打开时不渲染遮罩', () => {
    const wrapper = mount(ConfirmOverlay, {
      global: { stubs: { Teleport: true } },
    })
    expect(wrapper.find('.confirm-overlay').exists()).toBe(false)
    wrapper.unmount()
  })

  it('打开时展示文案并把焦点移到「取消」（安全默认）', async () => {
    const { wrapper } = await mountConfirm('删除 3 个模型？')

    expect(wrapper.find('.confirm-text').text()).toBe('删除 3 个模型？')
    expect(wrapper.find('[role="dialog"]').attributes('aria-modal')).toBe(
      'true',
    )
    const cancelBtn = wrapper.find('.confirm-actions .btn')
    expect(cancelBtn.text()).toBe('取消')
    expect(document.activeElement).toBe(cancelBtn.element)
    wrapper.unmount()
  })

  it('点击「确定」resolve(true) 并关闭', async () => {
    const { wrapper, result } = await mountConfirm()
    await wrapper.find('.confirm-ok').trigger('click')

    await expect(result).resolves.toBe(true)
    expect(state.confirm.visible).toBe(false)
    expect(wrapper.find('.confirm-overlay').exists()).toBe(false)
    wrapper.unmount()
  })

  it('点击「取消」resolve(false) 并关闭', async () => {
    const { wrapper, result } = await mountConfirm()
    await wrapper.find('.confirm-actions .btn').trigger('click')

    await expect(result).resolves.toBe(false)
    expect(state.confirm.visible).toBe(false)
    wrapper.unmount()
  })

  it('点击遮罩空白区视为取消', async () => {
    const { wrapper, result } = await mountConfirm()
    await wrapper.find('.confirm-overlay').trigger('click')

    await expect(result).resolves.toBe(false)
    wrapper.unmount()
  })

  it('Esc 取消并阻断冒泡（不触发下层详情/设置页 Esc 处理器）', async () => {
    const { wrapper, result } = await mountConfirm()
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    })
    const stopSpy = vi.spyOn(event, 'stopPropagation')
    wrapper.find('.confirm-overlay').element.dispatchEvent(event)
    await flushPromises()

    expect(stopSpy).toHaveBeenCalledTimes(1)
    await expect(result).resolves.toBe(false)
    expect(state.confirm.visible).toBe(false)
    wrapper.unmount()
  })

  it('焦点在非按钮区域时 Enter 视为确定', async () => {
    const { wrapper, result } = await mountConfirm()
    await wrapper.find('.confirm-overlay').trigger('keydown', { key: 'Enter' })

    await expect(result).resolves.toBe(true)
    wrapper.unmount()
  })

  it('焦点不在按钮上时 Tab 落到「取消」、Shift+Tab 落到「确定」', async () => {
    const { wrapper } = await mountConfirm()
    const overlay = wrapper.find('.confirm-overlay')
    const cancelBtn = wrapper.find('.confirm-actions .btn')
    const okBtn = wrapper.find('.confirm-ok')

    // jsdom 中 body 不可 focus：用 blur 让 activeElement 回到 body
    document.activeElement.blur()
    expect(document.activeElement).toBe(document.body)
    await overlay.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(cancelBtn.element)

    document.activeElement.blur()
    await overlay.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(okBtn.element)
    wrapper.unmount()
  })

  it('Tab 在「取消」与「确定」之间循环（Shift+Tab 反向）', async () => {
    const { wrapper } = await mountConfirm()
    const cancelBtn = wrapper.find('.confirm-actions .btn')
    const okBtn = wrapper.find('.confirm-ok')
    const overlay = wrapper.find('.confirm-overlay')

    await overlay.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(okBtn.element)

    await overlay.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(cancelBtn.element)
    wrapper.unmount()
  })
})
