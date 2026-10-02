import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { nativeImage } from 'electron'
import { fakeUserData } from './setup'

/**
 * thumbs.js 单元测试（B5 基线）：
 * - 缩略图生成走异步 readFile + createFromBuffer（不得回退 createFromPath 同步阻塞主进程）
 * - 小图/解码失败回退原图（返回 ''）
 * - 缓存命中不重复生成
 * - 延迟生成队列（getThumbPathDeferred + drainDeferredThumbs）与回调推送
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  nativeImage: {
    createFromBuffer: vi.fn(),
    createFromPath: vi.fn()
  }
}))

import { getThumbPath, getThumbPathDeferred, drainDeferredThumbs } from '../src/main/services/thumbs'
import { setDataRoot } from '../src/main/services/store'

const roots = []
let root
let source

/** 构造假解码图：可控宽高，链式 resize/toJPEG */
function mockDecodedImage({ width = 1200, empty = false } = {}) {
  const image = {
    isEmpty: () => empty,
    getSize: () => ({ width, height: 800 }),
    resize: vi.fn(() => image),
    toJPEG: vi.fn(() => Buffer.from('fake-jpeg'))
  }
  return image
}

beforeEach(async () => {
  vi.mocked(nativeImage.createFromBuffer).mockReset()
  vi.mocked(nativeImage.createFromPath).mockReset()
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

describe('缩略图生成（B5：异步解码）', () => {
  it('宽图生成缩略图：经 createFromBuffer 解码，不使用同步 createFromPath', async () => {
    vi.mocked(nativeImage.createFromBuffer).mockReturnValue(mockDecodedImage({ width: 1200 }))
    const thumbPath = await getThumbPath(source)
    expect(thumbPath).toContain(path.join('.modelvault', 'thumbs'))
    expect(thumbPath.endsWith('.jpg')).toBe(true)
    // B5 核心：同步 createFromPath 阻塞主进程，必须走异步读盘 + buffer 解码
    expect(nativeImage.createFromBuffer).toHaveBeenCalledTimes(1)
    expect(nativeImage.createFromPath).not.toHaveBeenCalled()
    // 缩略图文件已写入且目标宽度为 640
    const written = await fs.readFile(thumbPath)
    expect(written.toString()).toBe('fake-jpeg')
    const image = vi.mocked(nativeImage.createFromBuffer).mock.results[0].value
    expect(image.resize).toHaveBeenCalledWith({ width: 640 })
  })

  it('小图（宽度未超阈值）返回空串回退原图，不写缓存', async () => {
    vi.mocked(nativeImage.createFromBuffer).mockReturnValue(mockDecodedImage({ width: 600 }))
    expect(await getThumbPath(source)).toBe('')
    const thumbsDir = path.join(root, '.modelvault', 'thumbs')
    await expect(fs.readdir(thumbsDir)).rejects.toThrow()
  })

  it('解码失败（空图）返回空串回退原图', async () => {
    vi.mocked(nativeImage.createFromBuffer).mockReturnValue(mockDecodedImage({ empty: true }))
    expect(await getThumbPath(source)).toBe('')
  })

  it('缓存命中时不重复解码', async () => {
    vi.mocked(nativeImage.createFromBuffer).mockReturnValue(mockDecodedImage({ width: 1200 }))
    const first = await getThumbPath(source)
    const second = await getThumbPath(source)
    expect(second).toBe(first)
    expect(nativeImage.createFromBuffer).toHaveBeenCalledTimes(1)
  })
})

describe('延迟生成队列（扫描装饰阶段专用）', () => {
  it('未命中登记返回空串，drain 后台生成并回调推送', async () => {
    vi.mocked(nativeImage.createFromBuffer).mockReturnValue(mockDecodedImage({ width: 1200 }))
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
    vi.mocked(nativeImage.createFromBuffer).mockReturnValue(mockDecodedImage({ width: 1200 }))
    const thumbPath = await getThumbPath(source) // 先同步生成
    expect(await getThumbPathDeferred(source)).toBe(thumbPath)
  })

  it('后台生成源图丢失时容错跳过，不推送回调', async () => {
    vi.mocked(nativeImage.createFromBuffer).mockReturnValue(mockDecodedImage({ width: 1200 }))
    const missing = path.join(root, 'missing.png') // 不 stat 失败，不登记
    expect(await getThumbPathDeferred(missing)).toBe('')
    // 登记一个存在源图后删除源文件，drain 读盘失败容错
    expect(await getThumbPathDeferred(source)).toBe('')
    await fs.rm(source)
    const generated = []
    await drainDeferredThumbs((absCover, thumbPath) => generated.push({ absCover, thumbPath }))
    expect(generated).toHaveLength(0)
  })
})
