// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import LibraryPickerOverlay from '../src/renderer/src/components/LibraryPickerOverlay.vue'
import {
  confirmTransfer,
  transferState,
} from '../src/renderer/src/store/transfer'
import { defaultSettings, state } from '../src/renderer/src/store/appStore'
import { setupComponentTest, settle } from './helpers/componentTest'

/**
 * 跨库传输选择层组件测试（F-3，O-1 覆盖盲区回补）：
 * LibraryPickerOverlay.vue 此前仅 34.2% 覆盖。用例覆盖：
 * - 可见性与文案：标题随模式（移动/复制）与数量变化、进度条展示
 * - 目标库列表选择（selected 态）与模式单选绑定
 * - 键盘语义：Esc 空闲=关闭 / busy=中止传输（OPT-18）、Enter=确认
 * - 确认按钮守卫：未选择目标时禁用
 */

setupComponentTest()

const CUR = 'D:\\lib\\cur'
const OTHER = 'D:\\lib\\other'
const THIRD = 'D:\\lib\\third'

/** 打开浮层的就绪状态（两个可选目标库） */
function openOverlay({ mode = 'copy', ids = ['a', 'b'], busy = false } = {}) {
  state.folder = CUR
  Object.assign(state.settings, defaultSettings())
  state.settings.modelsFolders = [CUR, OTHER, THIRD]
  Object.assign(transferState, {
    visible: true,
    ids,
    mode,
    busy,
    progress: busy ? { done: 1, total: 2, bytes: 0, totalBytes: 0 } : null,
  })
}

function mountOverlay() {
  return mount(LibraryPickerOverlay, {
    global: { stubs: { teleport: true } },
  })
}

describe('渲染与文案', () => {
  it('不可见时不渲染浮层', () => {
    openOverlay()
    transferState.visible = false
    const wrapper = mountOverlay()
    expect(wrapper.find('.transfer-overlay').exists()).toBe(false)
  })

  it('标题随模式与数量变化，move 模式附源删除警示', async () => {
    openOverlay({ mode: 'move' })
    const wrapper = mountOverlay()
    expect(wrapper.find('.transfer-title').text()).toContain('移动 2 个模型')
    expect(wrapper.find('.transfer-desc').text()).toContain('源文件将被删除')

    transferState.mode = 'copy'
    await nextTick()
    expect(wrapper.find('.transfer-title').text()).toContain('复制 2 个模型')
  })

  it('目标库列表展示已保存库（去掉当前库）的目录名', () => {
    openOverlay()
    const wrapper = mountOverlay()
    const items = wrapper.findAll('.transfer-item')
    expect(items).toHaveLength(2)
    expect(items[0].text()).toBe('other')
    expect(items[1].text()).toBe('third')
  })

  it('busy 且有进度时展示「已处理 x/y」与取消中状态', () => {
    openOverlay({ busy: true })
    const wrapper = mountOverlay()
    expect(wrapper.find('.transfer-progress').text()).toContain('1/2')
  })
})

describe('选择与确认', () => {
  it('未选择目标时确认按钮禁用', () => {
    openOverlay()
    const wrapper = mountOverlay()
    expect(
      wrapper.find('button.btn-primary').attributes('disabled'),
    ).toBeDefined()
  })

  it('点击目标库后选中并可确认：confirmTransfer 以选中库发起 IPC', async () => {
    openOverlay()
    window.api.models.transferToLibrary.mockResolvedValue({
      transferred: 2,
      mode: 'copy',
      failed: [],
      skipped: [],
    })
    window.api.models.scan.mockImplementation(() =>
      Promise.resolve({
        models: [],
        root: CUR,
        durationMs: 1,
        errors: [],
        relinked: 0,
        settings: defaultSettings(),
      }),
    )
    const wrapper = mountOverlay()

    await wrapper.findAll('.transfer-item')[0].trigger('click')
    expect(wrapper.findAll('.transfer-item')[0].classes()).toContain('selected')
    expect(
      wrapper.findAll('.transfer-item')[0].attributes('aria-selected'),
    ).toBe('true')

    await wrapper.find('button.btn-primary').trigger('click')
    await settle()

    expect(window.api.models.transferToLibrary).toHaveBeenCalledWith(
      expect.objectContaining({
        ids: ['a', 'b'],
        targetRoot: OTHER,
        mode: 'copy',
      }),
    )
  })

  it('模式单选绑定 transferState.mode', async () => {
    openOverlay()
    const wrapper = mountOverlay()
    const radios = wrapper.findAll('input[type="radio"]')
    expect(radios).toHaveLength(2)
    expect(radios[0].element.checked).toBe(true) // copy 默认

    await radios[1].setValue(true)
    expect(transferState.mode).toBe('move')
  })
})

describe('键盘语义', () => {
  it('Esc 空闲时关闭浮层', async () => {
    openOverlay()
    const wrapper = mountOverlay()
    await wrapper
      .find('.transfer-overlay')
      .trigger('keydown', { key: 'Escape' })
    expect(transferState.visible).toBe(false)
  })

  it('Esc busy 时中止在途传输（OPT-18）而非关闭', async () => {
    // 从空闲态经 confirmTransfer 发起（busy 守卫会拒绝 busy 态重复确认，
    // 且取消令牌仅在 confirmTransfer 内注册）
    openOverlay()
    let release
    window.api.models.transferToLibrary.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              canceled: true,
              transferred: 0,
              mode: 'copy',
              failed: [],
              skipped: [],
            })
        }),
    )
    const pendingConfirm = confirmTransfer(OTHER)
    await settle()

    const wrapper = mountOverlay()
    await wrapper
      .find('.transfer-overlay')
      .trigger('keydown', { key: 'Escape' })
    expect(window.api.models.cancelOp).toHaveBeenCalledTimes(1)
    expect(transferState.visible).toBe(true)

    release()
    await pendingConfirm
  })

  it('Enter 确认：已选目标时经确认链路发起传输', async () => {
    openOverlay()
    window.api.models.transferToLibrary.mockResolvedValue({
      transferred: 2,
      mode: 'copy',
      failed: [],
      skipped: [],
    })
    window.api.models.scan.mockImplementation(() =>
      Promise.resolve({
        models: [],
        root: CUR,
        durationMs: 1,
        errors: [],
        relinked: 0,
        settings: defaultSettings(),
      }),
    )
    const wrapper = mountOverlay()

    await wrapper.findAll('.transfer-item')[1].trigger('click')
    await wrapper.find('.transfer-overlay').trigger('keydown', { key: 'Enter' })
    await settle()

    expect(window.api.models.transferToLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ targetRoot: THIRD }),
    )
  })

  it('Enter 未选择目标时不发起传输（canConfirm 守卫）', async () => {
    openOverlay()
    const wrapper = mountOverlay()
    await wrapper.find('.transfer-overlay').trigger('keydown', { key: 'Enter' })
    expect(window.api.models.transferToLibrary).not.toHaveBeenCalled()
  })
})
