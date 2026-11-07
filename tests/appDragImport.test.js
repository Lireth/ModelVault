// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import App from '../src/renderer/src/App.vue'
import { defaultSettings, state } from '../src/renderer/src/store/appStore'
import { setupComponentTest, settle } from './helpers/componentTest'

/**
 * F-4 拖拽模型导入：
 * - 文件拖入窗口时显示整窗提示层，松开后按拖放文件路径调用导入链路
 *   （默认复制；Shift 松开为移动），目标目录仍由主进程弹出选择；
 * - 非模型文件不触发导入 IPC，只提示；.disabled 后缀按 WebUI 模型处理。
 * 拖放路径解析经 preload webUtils（测试桩读取 File-like 对象的 path）。
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

async function mountApp() {
  window.api.models.loadStore.mockResolvedValue({ settings: defaultSettings() })
  wrapper = mount(App, { attachTo: document.body })
  await flushPromises()
  for (let i = 0; i < 200 && state.booting; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  state.folder = 'D:\\models'
  await nextTick()
  return wrapper
}

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

/** 构造带文件列表的拖放事件（jsdom 无 DataTransfer，按最小形状桩） */
function dragEvent(type, { files = [], shiftKey = false } = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { types: ['Files'], files },
  })
  if (shiftKey) Object.defineProperty(event, 'shiftKey', { value: true })
  return event
}

describe('F-4 拖拽模型导入', () => {
  it('拖入模型显示提示层；默认复制并透传绝对路径', async () => {
    const view = await mountApp()
    const file = { name: 'a.safetensors', path: 'C:\\src\\a.safetensors' }

    window.dispatchEvent(dragEvent('dragenter', { files: [file] }))
    await nextTick()
    expect(view.find('.drop-import-mask').exists()).toBe(true)
    expect(view.text()).toContain('松开以导入模型文件')

    window.dispatchEvent(dragEvent('drop', { files: [file] }))
    await settle()

    expect(window.api.models.importModels).toHaveBeenCalledWith(
      'copy',
      expect.any(String),
      ['C:\\src\\a.safetensors'],
    )
    expect(view.find('.drop-import-mask').exists()).toBe(false)
  })

  it('Shift 松开设为移动导入；.disabled 后缀按模型文件接受', async () => {
    await mountApp()
    const file = {
      name: 'b.safetensors.disabled',
      path: 'C:\\src\\b.safetensors.disabled',
    }

    window.dispatchEvent(dragEvent('dragenter', { files: [file] }))
    window.dispatchEvent(dragEvent('drop', { files: [file], shiftKey: true }))
    await settle()

    expect(window.api.models.importModels).toHaveBeenCalledWith(
      'move',
      expect.any(String),
      ['C:\\src\\b.safetensors.disabled'],
    )
  })

  it('非模型文件不触发导入，只给出提示', async () => {
    const view = await mountApp()

    window.dispatchEvent(
      dragEvent('drop', {
        files: [{ name: 'notes.txt', path: 'C:\\src\\notes.txt' }],
      }),
    )
    await settle()

    expect(window.api.models.importModels).not.toHaveBeenCalled()
    expect(
      state.toasts.some(
        (t) => t.type === 'warn' && t.text.includes('未检测到受支持的模型文件'),
      ),
    ).toBe(true)
    expect(view.find('.drop-import-mask').exists()).toBe(false)
  })

  it('封面等业务接收区让位：不显示提示层，也不触发模型导入', async () => {
    const view = await mountApp()
    const zone = document.createElement('div')
    zone.setAttribute('data-drop-images', '')
    zone.addEventListener('drop', (e) => e.preventDefault())
    document.body.appendChild(zone)
    const file = { name: 'a.safetensors', path: 'C:\\src\\a.safetensors' }

    // 先拖到普通区域：提示层出现；进入业务接收区后收起并让位
    window.dispatchEvent(dragEvent('dragenter', { files: [file] }))
    await nextTick()
    expect(view.find('.drop-import-mask').exists()).toBe(true)

    zone.dispatchEvent(dragEvent('dragenter', { files: [file] }))
    await nextTick()
    expect(view.find('.drop-import-mask').exists()).toBe(false)

    zone.dispatchEvent(dragEvent('drop', { files: [file] }))
    await settle()
    expect(window.api.models.importModels).not.toHaveBeenCalled()
  })

  it('纯文本/链接拖放不显示提示层，也不拦截原生行为', async () => {
    const view = await mountApp()
    const event = new Event('dragenter', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['text/plain'], files: [] },
    })

    window.dispatchEvent(event)
    await nextTick()

    expect(view.find('.drop-import-mask').exists()).toBe(false)
  })
})
