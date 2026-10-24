// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import LibraryStates from '../src/renderer/src/components/LibraryStates.vue'
import LibraryToolbar from '../src/renderer/src/components/LibraryToolbar.vue'
import App from '../src/renderer/src/App.vue'
import { replaceModels, state } from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * 库路径失效闭环的组件层测试（F1-offline）：
 * - LibraryStates 离线分支（空库全屏形态）：失效路径展示 + 重新定位/重新扫描按钮
 * - App 离线横幅（有缓存模型形态）：横幅渲染、与金色错误条互斥、工具栏隐藏
 * 双形态互斥条件：folderMissing && models.length > 0 → 横幅；= 0 → 全屏离线页。
 */

setupComponentTest()

beforeEach(() => {
  // jsdom 无 ResizeObserver（useVirtualScroll 在网格挂载时构造）：以空操作桩替代
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

/** 构造最小模型对象（与 virtualModelGrid.test.js 同构，保证卡片安全渲染） */
function makeModel(id) {
  return {
    id,
    name: id,
    type: 'checkpoint',
    size: 1000,
    mtimeMs: 1000,
    favorite: false,
    nsfw: false,
    rating: 0,
    alias: '',
    note: '',
    subCategory: '',
    triggerWords: '',
    coverUrl: '',
    covers: []
  }
}

describe('LibraryStates 离线分支（F1-offline）', () => {
  it('离线态渲染失效路径（等宽展示）与重新定位/重新扫描两个恢复入口', () => {
    state.folder = 'D:\\gone-lib'
    state.folderMissing = true
    const wrapper = mount(LibraryStates)
    expect(wrapper.text()).toContain('模型文件夹不可用')
    expect(wrapper.find('.offline-path').text()).toBe('D:\\gone-lib')
    const buttons = wrapper.findAll('.offline-actions button')
    expect(buttons.map((b) => b.text())).toEqual(['重新定位文件夹', '重新扫描'])
    wrapper.unmount()
  })

  it('点击「重新定位」走 chooseFolder 链路；取消选择保持离线态', async () => {
    state.folder = 'D:\\gone-lib'
    state.folderMissing = true
    window.api.models.chooseFolder.mockResolvedValue(null)
    const wrapper = mount(LibraryStates)
    await wrapper.findAll('.offline-actions button').at(0).trigger('click')
    await flushPromises()
    expect(window.api.models.chooseFolder).toHaveBeenCalled()
    expect(state.folder).toBe('D:\\gone-lib')
    expect(state.folderMissing).toBe(true)
    wrapper.unmount()
  })

  it('点击「重新扫描」触发扫描 IPC，成功后清除离线态并离开离线页', async () => {
    state.folder = 'D:\\back-lib'
    state.folderMissing = true
    state.missingRoots = ['d:\\back-lib']
    window.api.models.scan.mockResolvedValue({
      root: 'D:\\back-lib',
      models: [],
      errors: [],
      durationMs: 1
    })
    const wrapper = mount(LibraryStates)
    await wrapper.findAll('.offline-actions button').at(1).trigger('click')
    await flushPromises()
    expect(window.api.models.scan).toHaveBeenCalledWith('D:\\back-lib')
    expect(state.folderMissing).toBe(false)
    expect(state.missingRoots).toEqual([])
    // 离线分支已离开（链序落到空库分支）
    expect(wrapper.text()).not.toContain('模型文件夹不可用')
    wrapper.unmount()
  })

  it('有缓存模型时不渲染全屏离线页（该形态由 App 顶部横幅承担）', () => {
    state.folder = 'D:\\gone-lib'
    state.folderMissing = true
    replaceModels([makeModel('D:\\gone-lib\\a.safetensors')])
    const wrapper = mount(LibraryStates)
    expect(wrapper.text()).not.toContain('模型文件夹不可用')
    wrapper.unmount()
  })

  it('普通扫描失败仍走扫描失败分支（与离线态链序互斥）', () => {
    state.folder = 'D:\\lib'
    state.scanError = '磁盘读取失败'
    const wrapper = mount(LibraryStates)
    expect(wrapper.text()).toContain('扫描失败')
    expect(wrapper.text()).not.toContain('模型文件夹不可用')
    wrapper.unmount()
  })
})

describe('App 离线横幅（F1-offline）', () => {
  it('离线且有缓存模型时：显示离线横幅、隐藏工具栏与普通错误条', async () => {
    state.folder = 'D:\\gone-lib'
    state.folderMissing = true
    replaceModels([makeModel('D:\\gone-lib\\a.safetensors')])
    window.api.models.loadStore.mockResolvedValue({
      settings: { modelsFolder: 'D:\\gone-lib', autoScan: false },
      folderMissing: true,
      rootStatuses: [{ folder: 'D:\\gone-lib', exists: false }]
    })
    const wrapper = mount(App)
    await flushPromises()

    const banner = wrapper.find('.offline-bar')
    expect(banner.exists()).toBe(true)
    expect(banner.text()).toContain('D:\\gone-lib')
    expect(banner.findAll('button').map((b) => b.text())).toEqual(['重新定位', '重试'])
    expect(wrapper.find('.scan-error-bar').exists()).toBe(false)
    // 两种离线形态都隐藏工具栏
    expect(wrapper.findComponent(LibraryToolbar).exists()).toBe(false)
    // 离线态由横幅承担提示，不产生错误 toast
    expect(state.toasts.some((t) => t.type === 'error')).toBe(false)
    wrapper.unmount()
  })

  it('普通扫描错误（非离线）仍显示金色错误条且不显示离线横幅', async () => {
    state.folder = 'D:\\lib'
    state.scanError = '磁盘读取失败'
    replaceModels([makeModel('D:\\lib\\a.safetensors')])
    window.api.models.loadStore.mockResolvedValue({
      settings: { modelsFolder: 'D:\\lib', autoScan: false },
      folderMissing: false,
      rootStatuses: [{ folder: 'D:\\lib', exists: true }]
    })
    const wrapper = mount(App)
    await flushPromises()

    expect(wrapper.find('.offline-bar').exists()).toBe(false)
    expect(wrapper.find('.scan-error-bar').exists()).toBe(true)
    expect(wrapper.findComponent(LibraryToolbar).exists()).toBe(true)
    wrapper.unmount()
  })

  it('横幅「重试」触发重新扫描，成功后横幅消失、工具栏恢复', async () => {
    state.folder = 'D:\\back-lib'
    state.folderMissing = true
    replaceModels([makeModel('D:\\back-lib\\a.safetensors')])
    window.api.models.loadStore.mockResolvedValue({
      settings: { modelsFolder: 'D:\\back-lib', autoScan: false },
      folderMissing: true,
      rootStatuses: []
    })
    window.api.models.scan.mockResolvedValue({
      root: 'D:\\back-lib',
      models: [makeModel('D:\\back-lib\\a.safetensors')],
      errors: [],
      durationMs: 1
    })
    const wrapper = mount(App)
    await flushPromises()
    expect(wrapper.find('.offline-bar').exists()).toBe(true)

    await wrapper.findAll('.offline-bar button').at(1).trigger('click')
    await flushPromises()

    expect(window.api.models.scan).toHaveBeenCalledWith('D:\\back-lib')
    expect(wrapper.find('.offline-bar').exists()).toBe(false)
    expect(wrapper.findComponent(LibraryToolbar).exists()).toBe(true)
    wrapper.unmount()
  })
})
