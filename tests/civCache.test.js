import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fakeUserData } from './setup'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  BrowserWindow: Object.assign(vi.fn(), {
    fromWebContents: vi.fn(),
    getAllWindows: vi.fn(() => []),
  }),
}))

import { setDataRoot } from '../src/main/services/store-paths'
import {
  civCacheContentType,
  getCivImageCachePath,
  getCivImageFromCache,
  removeCivImageCache,
  saveCivImageCache,
} from '../src/main/services/civ-cache'

/**
 * civimg:// 远程图磁盘缓存测试（O-5，O-1 覆盖盲区回补）：
 * civ-cache.js 此前仅 8.9% 覆盖。用例覆盖：
 * - 读/写/删/路径定位全链与未命中语义
 * - URL → 缓存文件名（SHA256 + 扩展名推断）与 Content-Type 映射
 * - 非法 payload（非 Buffer/空/超大）不入缓存
 * - 未选库与库根离线（OPT-14）的 no-op 语义（缓存 best-effort，绝不影响返回）
 * - 容量清理水位下的 no-op（不误删未超限条目）
 */

let root

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-civcache-'))
  setDataRoot(root)
})

afterEach(async () => {
  setDataRoot(null)
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
})

describe('读写删与路径定位', () => {
  it('save → get 往返一致；文件名为 64 位十六进制 + URL 扩展名', async () => {
    const url = 'https://image.civitai.com/abc.jpeg'
    const buf = Buffer.from('image-bytes')

    await saveCivImageCache(url, buf)

    const file = getCivImageCachePath(url)
    expect(file).toContain(path.join('.modelvault', 'civcache'))
    expect(path.basename(file)).toMatch(/^[0-9a-f]{64}\.jpeg$/)
    expect(await getCivImageFromCache(url)).toEqual(buf)
  })

  it('未命中返回 null', async () => {
    expect(await getCivImageFromCache('https://x/missing.png')).toBeNull()
  })

  it('removeCivImageCache 删除条目后未命中', async () => {
    const url = 'https://x/gone.png'
    await saveCivImageCache(url, Buffer.from('x'))
    await removeCivImageCache(url)
    expect(await getCivImageFromCache(url)).toBeNull()
    await expect(fs.access(getCivImageCachePath(url))).rejects.toThrow()
  })
})

describe('扩展名推断与 Content-Type 映射', () => {
  it('URL 查询串不影响扩展名推断，大小写归一为小写', () => {
    expect(getCivImageCachePath('https://x/y.PNG?width=512')).toMatch(/\.png$/)
    expect(civCacheContentType('https://x/y.PNG?width=512')).toBe('image/png')
  })

  it('无扩展名 URL 落为 .img，Content-Type 留空交给浏览器嗅探', () => {
    expect(getCivImageCachePath('https://x/noext')).toMatch(/\.img$/)
    expect(civCacheContentType('https://x/noext')).toBe('')
  })

  it('常见图片扩展名逐一映射（.webp/.avif/.bmp）', () => {
    expect(civCacheContentType('https://x/a.webp')).toBe('image/webp')
    expect(civCacheContentType('https://x/a.avif')).toBe('image/avif')
    expect(civCacheContentType('https://x/a.bmp')).toBe('image/bmp')
  })
})

describe('非法 payload 与 no-op 语义', () => {
  it('非 Buffer / 空 Buffer / 超大 Buffer 不入缓存', async () => {
    const url = 'https://x/invalid.png'
    await saveCivImageCache(url, 'not-a-buffer')
    await saveCivImageCache(url, Buffer.alloc(0))
    await saveCivImageCache(url, Buffer.alloc(32 * 1024 * 1024 + 1))
    expect(await getCivImageFromCache(url)).toBeNull()
  })

  it('未选择模型库时全部操作 no-op（缓存不可用不影响代理链路）', async () => {
    setDataRoot(null)
    expect(getCivImageCachePath('https://x/a.png')).toBe('')
    expect(await getCivImageFromCache('https://x/a.png')).toBeNull()
    await expect(
      saveCivImageCache('https://x/a.png', Buffer.from('x')),
    ).resolves.toBeUndefined()
    await expect(
      removeCivImageCache('https://x/a.png'),
    ).resolves.toBeUndefined()
  })

  it('库根离线时跳过写入（OPT-14：不得重建失效路径目录树）', async () => {
    const gone = path.join(root, 'gone-library')
    setDataRoot(gone)
    const url = 'https://x/offline.png'

    await saveCivImageCache(url, Buffer.from('x'))

    // 文件未写入，且未在失效路径重建 .modelvault 目录
    await expect(fs.access(getCivImageCachePath(url))).rejects.toThrow()
    await expect(fs.access(path.join(gone, '.modelvault'))).rejects.toThrow()
  })
})

describe('容量清理', () => {
  it('水位以下不清理既有条目（避免误删）', async () => {
    const urls = ['https://x/keep1.png', 'https://x/keep2.png']
    for (const u of urls) {
      await saveCivImageCache(u, Buffer.from(`data-${u}`))
    }
    // 等待后台 prune 任务落定（写入后异步触发）
    await new Promise((resolve) => setTimeout(resolve, 30))
    for (const u of urls) {
      expect(await getCivImageFromCache(u)).toEqual(Buffer.from(`data-${u}`))
    }
  })
})
