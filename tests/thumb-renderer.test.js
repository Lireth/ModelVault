import { it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fakeUserData } from './setup'

/**
 * thumb-renderer 单元测试（P2 主进程非阻塞改造）：
 * 以 BrowserWindow 桩模拟隐藏渲染窗口，验证主进程侧编排逻辑：
 * - 成功/小图/错误三类响应的结算语义
 * - 单任务超时兜底（窗口销毁 + 任务拒绝）
 * - 渲染进程崩溃（render-process-gone）自愈
 * - destroyThumbRenderer 拒绝在途任务（主窗口关闭链路）
 */

vi.mock('electron', () => {
  class FakeWebContents {
    constructor() {
      this.handlers = {}
      this.sent = []
      this.installedScript = null
    }
    on(channel, fn) {
      ;(this.handlers[channel] ||= []).push(fn)
    }
    send(channel, payload) {
      this.sent.push({ channel, payload })
    }
    async executeJavaScript(code) {
      this.installedScript = code
      this.executeJavaScriptCalls = (this.executeJavaScriptCalls || 0) + 1
    }
    emit(channel, ...args) {
      for (const fn of this.handlers[channel] || []) fn(...args)
    }
  }

  class FakeBrowserWindow {
    static instances = []
    constructor(opts) {
      this.opts = opts
      this.webContents = new FakeWebContents()
      this.destroyed = false
      this.loadUrlCalls = 0
      FakeBrowserWindow.instances.push(this)
    }
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      this.destroyed = true
    }
    async loadURL(url) {
      this.loadUrlCalls += 1
      this.loadedUrl = url
    }
    on() {
      /* 未用到窗口级事件 */
    }
  }

  return {
    BrowserWindow: FakeBrowserWindow,
    __FakeBrowserWindow: FakeBrowserWindow,
    app: {
      getPath: vi.fn(() => fakeUserData),
      getAppPath: vi.fn(() => fakeUserData),
      isPackaged: true,
    },
  }
})

import {
  renderThumbJpeg,
  renderThumbFromPath,
  destroyThumbRenderer,
  isThumbRendererContents,
  setThumbRenderTimeoutForTests,
  setThumbRendererIdleTimeoutForTests,
} from '../src/main/services/thumb-renderer'
import logger from '../src/main/logger'
import { BrowserWindow as FakeBrowserWindow } from 'electron'

/** 等待微任务队列清空（readyPromise 链 settle 后 send 已发出） */
const flush = () => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => {
  FakeBrowserWindow.instances.length = 0
})

afterEach(() => {
  destroyThumbRenderer()
  setThumbRenderTimeoutForTests(20000)
  setThumbRendererIdleTimeoutForTests(60000)
  vi.useRealTimers()
})

/** 取当前唯一的窗口桩；missing 时抛错 */
function onlyWindow() {
  expect(FakeBrowserWindow.instances).toHaveLength(1)
  return FakeBrowserWindow.instances[0]
}

it('渲染成功：发送任务载荷并在 thumb:done 后以 Buffer 结算', async () => {
  const p = renderThumbJpeg(Buffer.from('fake-png'), {
    thumbWidth: 640,
    minSourceWidth: 720,
    quality: 0.82,
  })
  await flush()

  const w = onlyWindow()
  // 任务经 thumb:render 通道派发，携带参数与自增 id
  expect(w.webContents.sent).toHaveLength(1)
  const { channel, payload } = w.webContents.sent[0]
  expect(channel).toBe('thumb:render')
  expect(payload.thumbWidth).toBe(640)
  expect(payload.minSourceWidth).toBe(720)
  expect(payload.quality).toBe(0.82)
  expect(typeof payload.id).toBe('number')

  // 模拟渲染进程回传 JPEG 字节
  w.webContents.emit('ipc-message', {}, 'thumb:done', {
    id: payload.id,
    jpeg: new Uint8Array([1, 2, 3]),
  })
  await expect(p).resolves.toEqual({ jpeg: Buffer.from([1, 2, 3]) })
})

it('按 mvimg 地址派发任务：载荷携带 url 而非整图字节（OP-03）', async () => {
  const p = renderThumbFromPath('mvimg://local/%2Ftmp%2Fcover.png', {
    thumbWidth: 640,
    minSourceWidth: 720,
    quality: 0.82,
  })
  await flush()
  const w = onlyWindow()
  const { channel, payload } = w.webContents.sent[0]
  expect(channel).toBe('thumb:render')
  expect(payload.url).toBe('mvimg://local/%2Ftmp%2Fcover.png')
  expect(payload.buf).toBeUndefined()
  expect(typeof payload.id).toBe('number')
  w.webContents.emit('ipc-message', {}, 'thumb:done', {
    id: payload.id,
    small: true,
  })
  await expect(p).resolves.toEqual({ small: true })
})

it('空源图地址直接拒绝，不创建隐藏窗口', async () => {
  await expect(
    renderThumbFromPath('', {
      thumbWidth: 640,
      minSourceWidth: 720,
      quality: 0.82,
    }),
  ).rejects.toThrow('无效的源图地址')
  expect(FakeBrowserWindow.instances).toHaveLength(0)
})

it('源图过小（small）：以 { small: true } 结算，调用方回退原图', async () => {
  const p = renderThumbJpeg(Buffer.from('tiny'), {
    thumbWidth: 640,
    minSourceWidth: 720,
    quality: 0.82,
  })
  await flush()
  const w = onlyWindow()
  const { payload } = w.webContents.sent[0]
  w.webContents.emit('ipc-message', {}, 'thumb:done', {
    id: payload.id,
    small: true,
  })
  await expect(p).resolves.toEqual({ small: true })
})

it('渲染失败（损坏文件等）：以渲染进程上报的错误拒绝', async () => {
  const p = renderThumbJpeg(Buffer.from('broken'), {
    thumbWidth: 640,
    minSourceWidth: 720,
    quality: 0.82,
  })
  await flush()
  const w = onlyWindow()
  const { payload } = w.webContents.sent[0]
  w.webContents.emit('ipc-message', {}, 'thumb:done', {
    id: payload.id,
    error: '解码失败',
  })
  await expect(p).rejects.toThrow('解码失败')
})

it('渲染超时：拒绝任务并销毁窗口（下次任务重建）', async () => {
  vi.useFakeTimers()
  setThumbRenderTimeoutForTests(10)
  const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  const p = renderThumbJpeg(Buffer.from('slow'), {
    thumbWidth: 640,
    minSourceWidth: 720,
    quality: 0.82,
  })
  // 先挂处理器再推进假时钟：rejection 由 timer 触发，处理器须先行就位
  const outcome = p.then(
    () => 'resolved',
    (err) => err,
  )
  await vi.advanceTimersByTimeAsync(11)
  expect(await outcome).toMatchObject({
    message: expect.stringContaining('缩略图渲染超时'),
  })
  expect(onlyWindow().destroyed).toBe(true)
  warnSpy.mockRestore()
})

it('渲染进程崩溃（render-process-gone）：在途任务拒绝，窗口销毁待重建', async () => {
  const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  const p = renderThumbJpeg(Buffer.from('x'), {
    thumbWidth: 640,
    minSourceWidth: 720,
    quality: 0.82,
  })
  await flush()
  const w = onlyWindow()
  w.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  await expect(p).rejects.toThrow('缩略图渲染进程异常退出')
  expect(w.destroyed).toBe(true)
  warnSpy.mockRestore()
})

it('destroyThumbRenderer：拒绝在途任务（主窗口关闭链路防进程挂起）', async () => {
  const p = renderThumbJpeg(Buffer.from('x'), {
    thumbWidth: 640,
    minSourceWidth: 720,
    quality: 0.82,
  })
  await flush()
  destroyThumbRenderer()
  await expect(p).rejects.toThrow('缩略图渲染服务已销毁')
})

it('isThumbRendererContents：只识别当前隐藏窗口（业务 IPC 来源拒绝依据）', async () => {
  expect(isThumbRendererContents(null)).toBe(false)
  const p = renderThumbJpeg(Buffer.from('x'), {
    thumbWidth: 640,
    minSourceWidth: 720,
    quality: 0.82,
  })
  await flush()
  const w = onlyWindow()
  expect(isThumbRendererContents(w.webContents)).toBe(true)
  expect(isThumbRendererContents({})).toBe(false)
  // 在途任务由 afterEach 的 destroy 拒绝并兜底
  p.catch(() => {})
})

it('隐藏窗口创建参数：沙箱化、无 Node 能力、禁用后台节流', async () => {
  const p = renderThumbJpeg(Buffer.from('x'), {
    thumbWidth: 640,
    minSourceWidth: 720,
    quality: 0.82,
  })
  await flush()
  const w = onlyWindow()
  expect(w.opts.show).toBe(false)
  expect(w.opts.skipTaskbar).toBe(true)
  expect(w.opts.webPreferences).toMatchObject({
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    backgroundThrottling: false,
    spellcheck: false,
  })
  // 渲染逻辑收敛在专用 preload，不再向隐藏页面注入 Node 脚本
  expect(w.opts.webPreferences.preload).toContain('thumb-preload.js')
  expect(w.webContents.executeJavaScriptCalls || 0).toBe(0)
  // 在途任务不等待结算（20s 真实超时）：afterEach 的 destroy 会拒绝并兜底
  p.catch(() => {})
})

it('空闲回收：任务完成且无在途任务后销毁窗口，下次任务重建', async () => {
  setThumbRendererIdleTimeoutForTests(5)
  const p = renderThumbJpeg(Buffer.from('x'), {
    thumbWidth: 640,
    minSourceWidth: 720,
    quality: 0.82,
  })
  await flush()
  const w = onlyWindow()
  const { payload } = w.webContents.sent[0]
  w.webContents.emit('ipc-message', {}, 'thumb:done', {
    id: payload.id,
    small: true,
  })
  await expect(p).resolves.toEqual({ small: true })

  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(w.destroyed).toBe(true)

  // 空闲销毁后按需重建，服务仍可用
  const p2 = renderThumbJpeg(Buffer.from('y'), {
    thumbWidth: 640,
    minSourceWidth: 720,
    quality: 0.82,
  })
  await flush()
  expect(FakeBrowserWindow.instances).toHaveLength(2)
  const w2 = FakeBrowserWindow.instances[1]
  const { payload: payload2 } = w2.webContents.sent[0]
  w2.webContents.emit('ipc-message', {}, 'thumb:done', {
    id: payload2.id,
    small: true,
  })
  await expect(p2).resolves.toEqual({ small: true })
})

it('空闲回收：仍有在途任务时不销毁窗口', async () => {
  setThumbRendererIdleTimeoutForTests(5)
  const p = renderThumbJpeg(Buffer.from('x'), {
    thumbWidth: 640,
    minSourceWidth: 720,
    quality: 0.82,
  })
  await flush()
  const w = onlyWindow()
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(w.destroyed).toBe(false)

  const { payload } = w.webContents.sent[0]
  w.webContents.emit('ipc-message', {}, 'thumb:done', {
    id: payload.id,
    small: true,
  })
  await expect(p).resolves.toEqual({ small: true })
})
