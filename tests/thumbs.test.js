import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fakeUserData } from './setup'

/**
 * thumbs.js 单元测试（B5 基线，P2 改造后更新）：
 * - 缩略图解码/缩放/编码经隐藏渲染进程（thumb-renderer）执行，主进程不再
 *   使用 nativeImage 同步 API（P2 主进程非阻塞改造）
 * - 小图（small）/渲染失败回退原图（返回 ''）
 * - 缓存命中不重复生成
 * - 延迟生成队列（getThumbPathDeferred + drainDeferredThumbs）与回调推送
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true }
}))

// 缩略图渲染打桩：真实实现依赖 Electron BrowserWindow，此处模拟其响应协议
vi.mock('../src/main/services/thumb-renderer', () => ({
  renderThumbJpeg: vi.fn(),
  renderThumbFromPath: vi.fn(),
  destroyThumbRenderer: vi.fn(),
  setThumbRenderTimeoutForTests: vi.fn()
}))

import { getThumbPathDeferred, drainDeferredThumbs, clearDeferredJobs } from '../src/main/services/thumbs'
import { setDataRoot } from '../src/main/services/store'
import { renderThumbFromPath } from '../src/main/services/thumb-renderer'

const roots = []
let root
let source

/**
 * 配置渲染响应：宽图返回 JPEG 字节；小图返回 small；损坏图 reject。
 * @param {{mode?: 'wide'|'small'|'broken'}} opts
 */
function mockRender({ mode = 'wide' } = {}) {
  if (mode === 'wide') vi.mocked(renderThumbFromPath).mockResolvedValue({ jpeg: Buffer.from('fake-jpeg') })
  else if (mode === 'small') vi.mocked(renderThumbFromPath).mockResolvedValue({ small: true })
  else vi.mocked(renderThumbFromPath).mockRejectedValue(new Error('解码失败'))
}

/**
 * 经延迟队列同步触发一次生成（getThumbPath 已删除，C5：
 * 生产链路只走 deferred，测试入口随之统一）。
 * @returns {Promise<string>} 生成的缩略图路径（无生成时为 ''）
 */
async function generateNow(src) {
  expect(await getThumbPathDeferred(src)).toBe('')
  const out = []
  await drainDeferredThumbs((absCover, thumbPath) => out.push(thumbPath))
  return out[0] || ''
}

beforeEach(async () => {
  vi.mocked(renderThumbFromPath).mockReset()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-thumbs-'))
  roots.push(root)
  setDataRoot(root)
  source = path.join(root, 'cover.png')
  await fs.writeFile(source, Buffer.from('png-bytes'))
})

afterAll(async () => {
  for (const dir of roots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('缩略图生成（P2：渲染进程解码）', () => {
  it('宽图生成缩略图：只传 mvimg 地址，主进程不读整图也不触碰 nativeImage', async () => {
    mockRender({ mode: 'wide' })
    const thumbPath = await generateNow(source)
    expect(thumbPath).toContain(path.join('.modelvault', 'thumbs'))
    expect(thumbPath.endsWith('.jpg')).toBe(true)
    // OP-03 核心：解码/缩放/编码与源图读取都在隐藏渲染进程；
    // 主进程仅 stat 预检并传递受控的 mvimg:// 地址
    expect(renderThumbFromPath).toHaveBeenCalledTimes(1)
    const [url, opts] = vi.mocked(renderThumbFromPath).mock.calls[0]
    expect(url).toBe(`mvimg://local/${encodeURIComponent(source)}`)
    expect(opts).toEqual({ thumbWidth: 640, minSourceWidth: 720, quality: 0.82 })
    // 缩略图文件已写入且内容为渲染进程回传的 JPEG 字节
    const written = await fs.readFile(thumbPath)
    expect(written.toString()).toBe('fake-jpeg')
  })

  it('小图（渲染返回 small）不生成缩略图，不写缓存', async () => {
    mockRender({ mode: 'small' })
    expect(await generateNow(source)).toBe('')
    const thumbsDir = path.join(root, '.modelvault', 'thumbs')
    await expect(fs.readdir(thumbsDir)).rejects.toThrow()
  })

  it('渲染失败（损坏文件/不支持格式）不生成缩略图', async () => {
    mockRender({ mode: 'broken' })
    expect(await generateNow(source)).toBe('')
  })

  it('缓存命中时不再重复渲染', async () => {
    mockRender({ mode: 'wide' })
    const first = await generateNow(source)
    // 已有缓存文件：deferred 直接返回路径，不再登记任务/渲染
    const second = await getThumbPathDeferred(source)
    expect(second).toBe(first)
    expect(renderThumbFromPath).toHaveBeenCalledTimes(1)
  })
})

describe('延迟生成队列（扫描装饰阶段专用）', () => {
  it('未命中登记返回空串，drain 后台生成并回调推送', async () => {
    mockRender({ mode: 'wide' })
    // 首次：缓存未命中，登记后台任务，先回退原图
    expect(await getThumbPathDeferred(source)).toBe('')
    const generated = []
    await drainDeferredThumbs((absCover, thumbPath) => generated.push({ absCover, thumbPath }))
    expect(generated).toHaveLength(1)
    expect(generated[0].absCover).toBe(source)
    expect(await fs.access(generated[0].thumbPath).then(() => true, () => false)).toBe(true)
    // 队列已清空：再次 drain 无动作
    const again = []
    await drainDeferredThumbs((absCover, thumbPath) => again.push({ absCover, thumbPath }))
    expect(again).toHaveLength(0)
  })

  it('缓存命中直接返回缩略图路径，不登记队列', async () => {
    mockRender({ mode: 'wide' })
    const thumbPath = await generateNow(source) // 先触发一次生成建立缓存
    expect(await getThumbPathDeferred(source)).toBe(thumbPath)
  })

  it('后台生成源图丢失时容错跳过，不推送回调', async () => {
    mockRender({ mode: 'wide' })
    const missing = path.join(root, 'missing.png') // 不 stat 失败，不登记
    expect(await getThumbPathDeferred(missing)).toBe('')
    // 登记一个存在源图后删除源文件，drain 读盘失败容错
    expect(await getThumbPathDeferred(source)).toBe('')
    await fs.rm(source)
    const generated = []
    await drainDeferredThumbs((absCover, thumbPath) => generated.push({ absCover, thumbPath }))
    expect(generated).toHaveLength(0)
  })

  it('clearDeferredJobs 清空队列后 drain 无输出（C5 切根清理）', async () => {
    mockRender({ mode: 'wide' })
    // 登记后清空：drain 不再生成
    expect(await getThumbPathDeferred(source)).toBe('')
    clearDeferredJobs()
    const cleared = []
    await drainDeferredThumbs((absCover, thumbPath) => cleared.push({ absCover, thumbPath }))
    expect(cleared).toHaveLength(0)

    // 对照：未清空时同场景 drain 正常生成并回调
    expect(await getThumbPathDeferred(source)).toBe('')
    const kept = []
    await drainDeferredThumbs((absCover, thumbPath) => kept.push({ absCover, thumbPath }))
    expect(kept).toHaveLength(1)
    expect(kept[0].absCover).toBe(source)
  })
})
