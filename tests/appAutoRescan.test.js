// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import App from '../src/renderer/src/App.vue'
import { state, defaultSettings } from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * App 目录变更自动重扫的「扫描中漏报」修复（A-07a）：
 * 旧实现在 state.scanning 时直接丢弃 fsChanged 事件——扫描进行中发生的目录
 * 变更若恰在防抖窗内，要等下一次外部变更才会被发现。修复后：扫描中收到的
 * 匹配事件标记为待处理，扫描结束并经二级防抖后补一次重扫；
 * 不匹配根/关闭 autoRescan 的事件不产生待处理；补扫只发生一次。
 */

setupComponentTest()

beforeAll(() => {
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

/** 挂载 App 并取出主进程推送 fsChanged 时注册的回调（fake timers 环境） */
async function mountApp() {
  state.settings.autoRescan = true
  window.api.models.loadStore.mockResolvedValue({ settings: { ...defaultSettings(), autoRescan: true } })
  window.api.models.scan.mockResolvedValue({ models: [], errors: [] })
  window.api.models.partialScan.mockResolvedValue({ models: [], dirs: [], relinked: 0 })
  wrapper = mount(App, { attachTo: document.body })
  await vi.runAllTimersAsync()
  state.folder = 'D:\\models'
  await nextTick()
  return window.api.models.onFsChanged.mock.calls[0][0]
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
})

describe('A-07a 扫描中目录变更不丢失', () => {
  it('扫描进行中收到的变更：扫描结束后自动补一次局部扫描（含二级防抖）', async () => {
    const onFsChanged = await mountApp()
    state.scanning = true
    window.api.models.partialScan.mockClear()

    // 让 watcher 先观测到 scanning=true（真实扫描持续数秒必跨 tick）
    await nextTick()

    // 扫描进行中推送变更（旧实现直接 return 丢弃）
    onFsChanged({ root: 'D:\\models', dirs: ['lora'] })

    // 扫描结束：待处理标记经 watch 捕获，二级防抖 1s 后补一次局部扫描
    state.scanning = false
    await nextTick()
    await vi.advanceTimersByTimeAsync(1100)

    expect(window.api.models.partialScan).toHaveBeenCalledTimes(1)
    expect(window.api.models.partialScan).toHaveBeenCalledWith({
      folder: 'D:\\models',
      dirs: ['lora']
    })
  })

  it('扫描中收到多次变更只补扫一次（子树取并集）', async () => {
    const onFsChanged = await mountApp()
    state.scanning = true
    await nextTick()
    window.api.models.partialScan.mockClear()

    onFsChanged({ root: 'D:\\models', dirs: ['lora'] })
    onFsChanged({ root: 'D:\\models', dirs: ['vae'] })
    state.scanning = false
    await nextTick()
    await vi.advanceTimersByTimeAsync(1100)

    expect(window.api.models.partialScan).toHaveBeenCalledTimes(1)
    const payload = window.api.models.partialScan.mock.calls[0][0]
    expect(payload.folder).toBe('D:\\models')
    expect(payload.dirs.sort()).toEqual(['lora', 'vae'])
  })

  it('非当前库根目录的事件不产生待处理：扫描结束后不补扫', async () => {
    const onFsChanged = await mountApp()
    state.scanning = true
    await nextTick()
    window.api.models.partialScan.mockClear()

    onFsChanged({ root: 'D:\\other-library', dirs: ['lora'] })
    state.scanning = false
    await nextTick()
    await vi.advanceTimersByTimeAsync(1100)

    expect(window.api.models.partialScan).not.toHaveBeenCalled()
  })

  it('扫描结束时 autoRescan 已关闭则不补扫', async () => {
    const onFsChanged = await mountApp()
    state.scanning = true
    await nextTick()
    window.api.models.partialScan.mockClear()

    onFsChanged({ root: 'D:\\models', dirs: ['lora'] })
    state.settings.autoRescan = false
    state.scanning = false
    await nextTick()
    await vi.advanceTimersByTimeAsync(1100)

    expect(window.api.models.partialScan).not.toHaveBeenCalled()
  })

  it('扫描空闲时的变更走局部扫描且维持二级防抖（不立即触发）', async () => {
    const onFsChanged = await mountApp()
    window.api.models.partialScan.mockClear()

    onFsChanged({ root: 'D:\\models', dirs: ['lora'] })
    expect(window.api.models.partialScan).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1100)
    expect(window.api.models.partialScan).toHaveBeenCalledTimes(1)
    expect(window.api.models.partialScan.mock.calls[0][0].dirs).toEqual(['lora'])
  })

  it('载荷无 dirs（旧格式）时局部入口收到空数组，由 store 回退全量扫描', async () => {
    const onFsChanged = await mountApp()
    window.api.models.scan.mockClear()

    onFsChanged({ root: 'D:\\models' })
    await vi.advanceTimersByTimeAsync(1100)

    expect(window.api.models.scan).toHaveBeenCalledTimes(1)
  })
})
