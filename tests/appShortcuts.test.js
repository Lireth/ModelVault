// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import App from '../src/renderer/src/App.vue'
import { state, defaultSettings, rejectConfirm, replaceModels } from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * App 全局快捷键测试（B-03）：
 * - Ctrl+F 聚焦搜索框（面板打开时无效，搜索框不存在）
 * - Esc 逐层退出：先退出多选模式，再清空搜索词（面板/详情/确认层打开时让位，不抢关闭行为）
 * - Ctrl+A 进入多选并全选当前筛选结果；输入框内保持原生全选
 * - Delete 多选时弹出批量删除确认（不直接删除）
 * - Ctrl+D 多选时批量收藏；详情打开时收藏当前模型
 * 输入控件（input/textarea/select）内打字时，除 Ctrl+F 外一律不拦截。
 */

setupComponentTest()

beforeAll(() => {
  // App 挂载后有模型即渲染 VirtualModelGrid，jsdom 无 ResizeObserver/CSS.escape
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  if (!globalThis.CSS || typeof globalThis.CSS.escape !== 'function') {
    globalThis.CSS = { escape: (s) => String(s) }
  }
})

let wrapper = null

/**
 * 用例间状态复位（与 appStore.test.js 同一口径）：
 * state 为模块级单例，前面的用例会残留 search/multiSelect/确认层等
 * 状态（如「设置页 Esc 让位」用例断言保留 search='lora'），不复位则
 * 后续用例的 Ctrl+A 全选数量与 Ctrl+D 批量目标随执行顺序漂移，
 * CI 高并行慢环境下表现为偶发断言失败。
 */
beforeEach(() => {
  state.folder = ''
  state.booting = false
  state.scanning = false
  state.scanError = ''
  replaceModels([])
  state.typeFilter = 'all'
  state.subFilter = ''
  state.showFavoritesOnly = false
  state.search = ''
  state.sortBy = 'name'
  state.sortAsc = true
  state.viewMode = 'grid'
  state.selectedId = null
  state.detailDirty = false
  state.settingsOpen = false
  state.toasts.splice(0, state.toasts.length)
  // 挂起的确认 Promise 先收敛，再就地表合并复位（O3 浅响应约定）
  if (state.confirm.resolve) state.confirm.resolve(false)
  Object.assign(state.confirm, { visible: false, text: '', resolve: null })
  Object.assign(state.multiSelect, { active: false, ids: [], busy: false, cancelRequested: false })
})

/** 挂载 App（initApp 经桩 loadStore 拿到默认设置，不触发扫描） */
async function mountApp() {
  window.api.models.loadStore.mockResolvedValue({ settings: defaultSettings() })
  // attachTo document.body：脱离文档的元素在 jsdom 中不可获焦，
  // Ctrl+F 的 focus 断言需要元素 isConnected
  wrapper = mount(App, { attachTo: document.body })
  await flushPromises()
  // CI 高并行慢环境下 flushPromises 未必覆盖 initApp 全链：轮询等待
  // 启动完成标志（B8），避免初始化与用例准备交错
  for (let i = 0; i < 200 && state.booting; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(state.booting).toBe(false)
  return wrapper
}

// 显式卸载：App 内含 Teleport 到 body 的弹层，不卸载会令下一用例清 body 后
// 旧实例更新命中已失效的 DOM 锚点（insertBefore null）
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

/** 准备已选文件夹 + 两个模型的网格场景（搜索框与网格均渲染） */
async function setupGrid(wrapper) {
  state.folder = 'D:\\models'
  // O3：models 数组级更新须经 replaceModels（直接赋值落入 raw 数组丢响应）
  replaceModels([
    { id: 'D:\\models\\a.safetensors', name: 'a', type: 'checkpoint', size: 10, mtimeMs: 1, favorite: false, nsfw: false, rating: 0, alias: '', note: '', subCategory: 'base', triggerWords: '', coverUrl: '', covers: [] },
    { id: 'D:\\models\\b.safetensors', name: 'b', type: 'lora', size: 20, mtimeMs: 2, favorite: false, nsfw: false, rating: 0, alias: '', note: '', subCategory: '', triggerWords: '', coverUrl: '', covers: [] }
  ])
  await nextTick()
  return wrapper.find('.search-box input').element
}

/** 在指定目标上派发 keydown（默认 window，即非输入态） */
function press(key, { ctrlKey = false, target = window } = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ctrlKey })
  target.dispatchEvent(event)
  return event
}

describe('App 全局快捷键（B-03）', () => {
  it('Ctrl+F 聚焦搜索框并阻止浏览器默认查找', async () => {
    const wrapper = await mountApp()
    const searchInput = await setupGrid(wrapper)

    const event = press('f', { ctrlKey: true })

    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(searchInput)
  })

  it('面板（设置页）打开时 Ctrl+F 不处理：搜索框不在 DOM 中', async () => {
    await mountApp()
    state.folder = 'D:\\models'
    state.settingsOpen = true
    await nextTick()

    const event = press('f', { ctrlKey: true })

    expect(event.defaultPrevented).toBe(false)
  })

  it('Esc 在无面板且有搜索词时清空搜索', async () => {
    const wrapper = await mountApp()
    await setupGrid(wrapper)
    state.search = 'lora'
    await nextTick()

    press('Escape')

    expect(state.search).toBe('')
  })

  it('Esc 优先退出多选模式，再次 Esc 才清空搜索词', async () => {
    const wrapper = await mountApp()
    await setupGrid(wrapper)
    state.search = 'lora'
    press('a', { ctrlKey: true })
    expect(state.multiSelect.active).toBe(true)

    press('Escape')
    expect(state.multiSelect.active).toBe(false)
    expect(state.multiSelect.ids).toEqual([])
    expect(state.search).toBe('lora')

    press('Escape')
    expect(state.search).toBe('')
  })

  it('多选批量进行中按 Esc：请求取消而非退出多选，busy 结束后再次 Esc 才退出', async () => {
    const wrapper = await mountApp()
    await setupGrid(wrapper)
    state.search = 'lora'
    state.multiSelect.active = true
    state.multiSelect.ids = ['a', 'b']
    state.multiSelect.busy = true

    press('Escape')
    expect(state.multiSelect.active).toBe(true) // 不退出多选（防误退丢上下文）
    expect(state.multiSelect.cancelRequested).toBe(true) // 请求取消当前批量
    expect(state.search).toBe('lora')

    // 批量收尾（标志位由批量操作 finally 复位）后再次 Esc 正常退出
    state.multiSelect.busy = false
    state.multiSelect.cancelRequested = false
    press('Escape')
    expect(state.multiSelect.active).toBe(false)
    expect(state.search).toBe('lora')
  })

  it('设置页打开时 Esc 让位设置页关闭逻辑，不清空面板背后的搜索词', async () => {
    const wrapper = await mountApp()
    await setupGrid(wrapper)
    state.search = 'lora'
    state.settingsOpen = true
    await flushPromises()
    // 设置页经 defineAsyncComponent 按需加载（OP-01）：等待其挂载完成，
    // 确保 ESC 监听器已注册后再派发按键
    for (let i = 0; i < 100 && !wrapper.find('.settings-page').exists(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(wrapper.find('.settings-page').exists()).toBe(true)

    press('Escape')
    await flushPromises()

    expect(state.settingsOpen).toBe(false)
    expect(state.search).toBe('lora')
  })

  it('确认层可见时所有快捷键让位（Esc 不清搜索）', async () => {
    const wrapper = await mountApp()
    await setupGrid(wrapper)
    state.search = 'lora'
    state.confirm.visible = true
    await nextTick()

    press('Escape')

    expect(state.search).toBe('lora')
  })

  it('Ctrl+A 进入多选模式并全选当前筛选结果', async () => {
    const wrapper = await mountApp()
    await setupGrid(wrapper)

    press('a', { ctrlKey: true })

    expect(state.multiSelect.active).toBe(true)
    expect(state.multiSelect.ids).toHaveLength(2)
  })

  it('焦点在搜索输入框时 Ctrl+A 保持原生文本全选，不触发多选', async () => {
    const wrapper = await mountApp()
    const searchInput = await setupGrid(wrapper)

    const event = press('a', { ctrlKey: true, target: searchInput })

    expect(event.defaultPrevented).toBe(false)
    expect(state.multiSelect.active).toBe(false)
  })

  it('Delete 在多选有选中时弹出删除确认（确认前不调用删除 IPC）', async () => {
    const wrapper = await mountApp()
    await setupGrid(wrapper)
    press('a', { ctrlKey: true })

    press('Delete')

    expect(state.confirm.visible).toBe(true)
    expect(window.api.models.deleteModel).not.toHaveBeenCalled()
    // 收敛挂起的确认 Promise，避免泄漏到后续用例
    rejectConfirm()
    await flushPromises()
  })

  it('Ctrl+D 多选时对全部选中项批量收藏', async () => {
    const wrapper = await mountApp()
    await setupGrid(wrapper)
    window.api.models.setMetaFlags.mockResolvedValue({ meta: { favorite: true } })
    press('a', { ctrlKey: true })

    press('d', { ctrlKey: true })
    await flushPromises()

    expect(window.api.models.setMetaFlags).toHaveBeenCalledTimes(2)
    for (const call of window.api.models.setMetaFlags.mock.calls) {
      expect(call[0]).toMatchObject({ favorite: true })
    }
  })

  it('Ctrl+D 非多选但详情打开时收藏当前模型', async () => {
    const wrapper = await mountApp()
    await setupGrid(wrapper)
    state.selectedId = 'D:\\models\\a.safetensors'
    window.api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: true, nsfw: false, rating: 0 }
    })

    press('d', { ctrlKey: true })
    await flushPromises()

    expect(window.api.models.setMetaFlags).toHaveBeenCalledTimes(1)
    expect(window.api.models.setMetaFlags.mock.calls[0][0].id).toBe('D:\\models\\a.safetensors')
  })

  it('输入框内按 Delete 不触发删除确认', async () => {
    const wrapper = await mountApp()
    const searchInput = await setupGrid(wrapper)
    press('a', { ctrlKey: true, target: searchInput })
    // 未进入多选：Delete 在输入框内仅原生删字符
    press('Delete', { target: searchInput })
    expect(state.confirm.visible).toBe(false)
    expect(state.multiSelect.active).toBe(false)
  })

  it('视图切换按钮在网格/列表间切换并持久化', async () => {
    const wrapper = await mountApp()
    await setupGrid(wrapper)
    window.api.settings.update.mockImplementation((patch) =>
      Promise.resolve({ settings: { ...state.settings, ...patch } })
    )
    expect(state.viewMode).toBe('grid')
    expect(wrapper.find('.virtual-grid').exists()).toBe(true)

    await wrapper.find('.view-toggle').trigger('click')
    await flushPromises()

    expect(state.viewMode).toBe('list')
    expect(window.api.settings.update).toHaveBeenCalledWith({ viewMode: 'list' })
    expect(wrapper.find('.virtual-list').exists()).toBe(true)
    expect(wrapper.find('.virtual-grid').exists()).toBe(false)

    await wrapper.find('.view-toggle').trigger('click')
    await flushPromises()
    expect(state.viewMode).toBe('grid')
    expect(wrapper.find('.virtual-grid').exists()).toBe(true)
  })
})
