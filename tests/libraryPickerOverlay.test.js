// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import LibraryPickerOverlay from '../src/renderer/src/components/LibraryPickerOverlay.vue'
import { state, transferState } from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * LibraryPickerOverlay 组件测试（C4 数据关键 UI 补齐）：
 * 跨库传输浮层此前 34.2% 覆盖率。本文件覆盖目标库过滤与选择、复制/移动
 * 模式切换、确认载荷（含取消令牌）、忙碌进度、Esc 关闭/中止、错误保留浮层。
 */

setupComponentTest()

/** 复位跨库传输浮层并挂载（Teleport 桩内联渲染便于 wrapper 查询） */
function mountPicker(overrides = {}) {
  state.folder = 'D:\\models\\A'
  state.settings.modelsFolders = [
    'D:\\models\\A',
    'D:\\models\\B',
    'D:\\models\\C',
  ]
  Object.assign(transferState, {
    visible: true,
    ids: ['a', 'b'],
    mode: 'copy',
    busy: false,
    progress: null,
    ...overrides,
  })
  return mount(LibraryPickerOverlay, {
    attachTo: document.body,
    global: { stubs: { Teleport: true } },
  })
}

/** 最近一条 toast */
function lastToast() {
  return state.toasts[state.toasts.length - 1]
}

beforeEach(() => {
  window.api.models.scan.mockResolvedValue({
    models: [],
    errors: [],
    byType: {},
    durationMs: 1,
  })
})

describe('LibraryPickerOverlay 选择与传输', () => {
  it('隐藏时不渲染浮层', () => {
    const wrapper = mountPicker({ visible: false })
    expect(wrapper.find('.transfer-overlay').exists()).toBe(false)
    wrapper.unmount()
  })

  it('打开时重置上次选择并聚焦「取消」（安全默认）', async () => {
    const wrapper = mountPicker({ visible: false })
    await flushPromises()

    transferState.visible = true
    await flushPromises()
    expect(document.activeElement).toBe(
      wrapper.find('.transfer-actions .btn').element,
    )

    await wrapper.findAll('.transfer-item')[0].trigger('click')
    expect(wrapper.findAll('.transfer-item.selected')).toHaveLength(1)
    await wrapper.find('.transfer-actions .btn').trigger('click')
    expect(transferState.visible).toBe(false)

    // 再次打开：上次选择不残留，确认按钮回到禁用态
    transferState.visible = true
    await flushPromises()
    expect(wrapper.findAll('.transfer-item.selected')).toHaveLength(0)
    expect(
      wrapper.find('.transfer-actions .btn-primary').attributes('disabled'),
    ).toBeDefined()
    wrapper.unmount()
  })

  it('复制/移动单选与传输模式双向绑定', async () => {
    const wrapper = mountPicker({ mode: 'move' })
    const copyRadio = wrapper
      .findAll('input[type="radio"]')
      .find((r) => r.attributes('value') === 'copy')
    expect(copyRadio.element.checked).toBe(false)

    await copyRadio.setValue(true)
    expect(transferState.mode).toBe('copy')
    expect(wrapper.find('.transfer-title').text()).toContain('复制')
    wrapper.unmount()
  })

  it('目标库排除当前库，未选择时确认按钮禁用', () => {
    const wrapper = mountPicker()
    expect(wrapper.find('.transfer-title').text()).toContain(
      '复制 2 个模型到其他库',
    )
    const items = wrapper.findAll('.transfer-item')
    expect(items.map((i) => i.text())).toEqual(['B', 'C'])
    expect(items.every((i) => i.attributes('aria-selected') === 'false')).toBe(
      true,
    )
    expect(
      wrapper.find('.transfer-actions .btn-primary').attributes('disabled'),
    ).toBeDefined()
    wrapper.unmount()
  })

  it('选择目标后确认：载荷携带 ids/目标库/模式/取消令牌', async () => {
    state.scanning = true // 跳过传输后的整表重扫，聚焦浮层载荷断言
    const wrapper = mountPicker()
    await wrapper.findAll('.transfer-item')[0].trigger('click')
    expect(wrapper.findAll('.transfer-item')[0].classes()).toContain('selected')

    window.api.models.transferToLibrary.mockResolvedValue({
      transferred: 2,
      mode: 'copy',
      skipped: [],
      failed: [],
    })
    await wrapper.find('.transfer-actions .btn-primary').trigger('click')
    await flushPromises()

    expect(window.api.models.transferToLibrary).toHaveBeenCalledWith({
      ids: ['a', 'b'],
      targetRoot: 'D:\\models\\B',
      mode: 'copy',
      opId: expect.any(String),
    })
    expect(lastToast()).toMatchObject({ type: 'success' })
    expect(lastToast().text).toContain('跨库传输完成：复制 2 个')
    expect(transferState.visible).toBe(false)
    expect(transferState.busy).toBe(false)
    wrapper.unmount()
  })

  it('切换为移动模式后标题/按钮文案与载荷一致', async () => {
    state.scanning = true
    const wrapper = mountPicker()
    const moveRadio = wrapper
      .findAll('input[type="radio"]')
      .find((r) => r.attributes('value') === 'move')
    await moveRadio.setValue(true)
    expect(wrapper.find('.transfer-title').text()).toContain(
      '移动 2 个模型到其他库',
    )

    await wrapper.findAll('.transfer-item')[1].trigger('click')
    window.api.models.transferToLibrary.mockResolvedValue({
      transferred: 2,
      mode: 'move',
      skipped: [],
      failed: [],
    })
    const confirmBtn = wrapper.find('.transfer-actions .btn-primary')
    expect(confirmBtn.text()).toBe('移动')
    await confirmBtn.trigger('click')
    await flushPromises()

    expect(window.api.models.transferToLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ targetRoot: 'D:\\models\\C', mode: 'move' }),
    )
    wrapper.unmount()
  })

  it('列表项 Enter 直接确认该目标（无需先点击选中）', async () => {
    state.scanning = true
    const wrapper = mountPicker()
    window.api.models.transferToLibrary.mockResolvedValue({
      transferred: 1,
      mode: 'copy',
      skipped: [],
      failed: [],
    })

    await wrapper.findAll('.transfer-item')[1].trigger('keydown', {
      key: 'Enter',
    })
    await flushPromises()

    expect(window.api.models.transferToLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ targetRoot: 'D:\\models\\C' }),
    )
    wrapper.unmount()
  })

  it('主进程返回 error 时保留浮层并提示，便于重试', async () => {
    const wrapper = mountPicker()
    await wrapper.findAll('.transfer-item')[0].trigger('click')
    window.api.models.transferToLibrary.mockResolvedValue({
      error: '目标库不可用',
    })
    await wrapper.find('.transfer-actions .btn-primary').trigger('click')
    await flushPromises()

    expect(transferState.visible).toBe(true)
    expect(transferState.busy).toBe(false)
    expect(lastToast()).toMatchObject({
      type: 'error',
      text: '目标库不可用',
    })
    wrapper.unmount()
  })
})

describe('LibraryPickerOverlay 关闭与中止', () => {
  it('点击遮罩空白区或「取消」按钮均可关闭浮层', async () => {
    const wrapper = mountPicker()
    await wrapper.find('.transfer-overlay').trigger('click')
    expect(transferState.visible).toBe(false)

    transferState.visible = true
    await flushPromises()
    await wrapper.find('.transfer-actions .btn').trigger('click')
    expect(transferState.visible).toBe(false)
    wrapper.unmount()
  })

  it('焦点在非按钮区域时 Enter 确认已选目标', async () => {
    state.scanning = true
    const wrapper = mountPicker()
    await wrapper.findAll('.transfer-item')[0].trigger('click')
    window.api.models.transferToLibrary.mockResolvedValue({
      transferred: 2,
      mode: 'copy',
      skipped: [],
      failed: [],
    })

    await wrapper.find('.transfer-overlay').trigger('keydown', {
      key: 'Enter',
    })
    await flushPromises()

    expect(window.api.models.transferToLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ targetRoot: 'D:\\models\\B' }),
    )
    wrapper.unmount()
  })

  it('空闲时 Esc 关闭并清空待传输 id', async () => {
    const wrapper = mountPicker()
    await wrapper.find('.transfer-overlay').trigger('keydown', {
      key: 'Escape',
    })

    expect(transferState.visible).toBe(false)
    expect(transferState.ids).toEqual([])
    wrapper.unmount()
  })

  it('传输中展示进度，Esc 改为中止传输（不关闭浮层）', async () => {
    let resolveTransfer
    window.api.models.transferToLibrary.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveTransfer = resolve
        }),
    )
    const wrapper = mountPicker()
    await wrapper.findAll('.transfer-item')[0].trigger('click')
    await wrapper.find('.transfer-actions .btn-primary').trigger('click')
    await flushPromises()

    expect(transferState.busy).toBe(true)
    expect(transferState.visible).toBe(true)
    expect(wrapper.find('.transfer-progress').text()).toContain(
      '已处理 0/2（传输中）',
    )
    expect(wrapper.find('.transfer-actions .btn').text()).toBe('中止传输')

    await wrapper.find('.transfer-overlay').trigger('keydown', {
      key: 'Escape',
    })
    expect(window.api.models.cancelOp).toHaveBeenCalledTimes(1)
    expect(window.api.models.cancelOp.mock.calls[0][0]).toEqual(
      expect.any(String),
    )
    // 中止请求不立即关闭浮层：结果由传输响应落定
    expect(transferState.visible).toBe(true)

    resolveTransfer({
      transferred: 2,
      mode: 'copy',
      skipped: [],
      failed: [],
    })
    await flushPromises()
    expect(transferState.visible).toBe(false)
    expect(transferState.busy).toBe(false)
    wrapper.unmount()
  })

  it('取消中状态在进度文案中可见', async () => {
    const wrapper = mountPicker({
      busy: true,
      progress: { done: 1, total: 2, canceled: true },
    })
    expect(wrapper.find('.transfer-progress').text()).toContain(
      '已处理 1/2（取消中…）',
    )
    expect(
      wrapper.find('.transfer-actions .btn-primary').attributes('disabled'),
    ).toBeDefined()
    wrapper.unmount()
  })
})
