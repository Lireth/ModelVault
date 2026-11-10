import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fakeUserData } from './setup'

/**
 * mvimg:// 本地图片协议的条件请求与缓存头回归测试（O-2 拆分后自
 * protocol.test.js 迁移，OPT-7/A-05 行为面）。路径白名单基础用例见
 * tests/modelsMeta.test.js（400/403/404/junction 逃逸），本文件覆盖：
 * - 200 响应携带弱 ETag；If-None-Match 命中 304 短路（跳过 body 建流）
 * - If-Modified-Since 命中 304；携带 INM 时不降级 IMS 判定（RFC 7232）
 * - 不可变资产（.modelvault/covers|thumbs）immutable 长缓存（200 与 304）
 * - sidecar 同名图（内容可被替换）no-cache 重验证
 * - 流式直读完整内容与确定化响应头（PERF-6，不经 net.fetch）
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  },
  net: { fetch: vi.fn() },
  clipboard: { read: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}))

import { net, protocol } from 'electron'
import { registerMvimgHandler } from '../src/main/protocol/local-image'
import { toImageUrl } from '../src/shared/image-url'
import { setDataRoot } from '../src/main/services/store'

/** 最小 PNG 文件头（魔数校验所需字节均在文件头 12 字节内） */
const PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
])
/** 最小 JPEG 文件头（缩略图 .jpg 场景） */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0])

const roots = []
let root
/** 注册时捕获的 mvimg 处理器 */
let handler

/** 构造 mvimg 请求（与渲染进程 toImageUrl 生成格式一致） */
function makeRequest(absPath) {
  return { url: toImageUrl(absPath) }
}

beforeEach(async () => {
  vi.mocked(protocol.handle).mockClear()
  vi.mocked(net.fetch).mockReset()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-mvimg-'))
  roots.push(root)
  setDataRoot(root)
  registerMvimgHandler()
  const call = vi
    .mocked(protocol.handle)
    .mock.calls.find(([scheme]) => scheme === 'mvimg')
  handler = call?.[1]
  expect(typeof handler).toBe('function')
})

afterEach(async () => {
  for (const dir of roots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  roots.length = 0
})

describe('mvimg 流式直读响应（PERF-6）', () => {
  it('根目录内图片放行：完整内容 + 确定化媒体头，不经 net.fetch', async () => {
    const cover = path.join(root, 'cover.png')
    await fs.writeFile(cover, PNG_MAGIC)
    const res = await handler(makeRequest(cover))
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG_MAGIC)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Content-Length')).toBe(String(PNG_MAGIC.length))
    expect(res.headers.get('Last-Modified')).toBeTruthy()
    expect(net.fetch).not.toHaveBeenCalled()
  })

  it('关联存储封面（.modelvault/covers，内容不可变命名）返回 immutable 长缓存', async () => {
    const cover = path.join(root, '.modelvault', 'covers', '1728-cover.png')
    await fs.mkdir(path.dirname(cover), { recursive: true })
    await fs.writeFile(cover, PNG_MAGIC)

    const res = await handler(makeRequest(cover))

    expect(res.status).toBe(200)
    const cacheControl = res.headers.get('Cache-Control')
    expect(cacheControl).toContain('immutable')
    expect(cacheControl).toContain('max-age=31536000')
    expect(res.headers.get('Content-Type')).toBe('image/png')
  })

  it('缩略图缓存（.modelvault/thumbs，文件名含源图 mtime）返回 immutable 长缓存', async () => {
    const thumb = path.join(
      root,
      '.modelvault',
      'thumbs',
      'abc123-1700000000000.jpg',
    )
    await fs.mkdir(path.dirname(thumb), { recursive: true })
    await fs.writeFile(thumb, JPEG_MAGIC)

    const res = await handler(makeRequest(thumb))

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toContain('immutable')
    // .jpg → image/jpeg（缩略图管线的媒体类型正确性）
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
  })

  it('模型目录内 sidecar 同名图（路径不变但内容可被替换）返回 no-cache', async () => {
    const sidecar = path.join(root, 'model.preview.png')
    await fs.writeFile(sidecar, PNG_MAGIC)

    const res = await handler(makeRequest(sidecar))

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-cache')
  })
})

describe('mvimg 条件请求（OPT-7）', () => {
  it('200 响应携带弱 ETag；If-None-Match 命中返回 304 跳过全量 body 读取', async () => {
    const file = path.join(root, 'sidecar-cover.png')
    await fs.writeFile(file, PNG_MAGIC)
    const first = await handler(makeRequest(file))
    expect(first.status).toBe(200)
    const etag = first.headers.get('etag')
    expect(etag).toMatch(/^W\//)

    // 304 短路跳过全量 body 流：304 路径仅剩魔数校验的一次 open（sidecar
    // 内容可被外部替换的既有安全设计），body 建流的第二次 open 未发生——
    // 对照组为不带条件头的 200 请求（魔数校验 + 建流共两次）
    const openSpy = vi.spyOn(fs, 'open')
    try {
      const second = await handler({
        url: toImageUrl(file),
        headers: new Headers({ 'If-None-Match': etag }),
      })
      expect(second.status).toBe(304)
      expect(second.body).toBeNull()
      expect(openSpy).toHaveBeenCalledTimes(1)
      // 304 携带缓存策略与验证器（供 Chromium 缓存更新元数据）
      expect(second.headers.get('cache-control')).toBe('no-cache')
      expect(second.headers.get('etag')).toBe(etag)

      openSpy.mockClear()
      const third = await handler(makeRequest(file))
      expect(third.status).toBe(200)
      expect(openSpy).toHaveBeenCalledTimes(2)
    } finally {
      openSpy.mockRestore()
    }
  })

  it('If-Modified-Since 命中返回 304；INM 未命中时不降级 IMS 判定', async () => {
    const file = path.join(root, 'sidecar-ims.png')
    await fs.writeFile(file, PNG_MAGIC)
    const stat = await fs.stat(file)
    const lastModified = new Date(stat.mtimeMs).toUTCString()

    const hit = await handler({
      url: toImageUrl(file),
      headers: new Headers({ 'If-Modified-Since': lastModified }),
    })
    expect(hit.status).toBe(304)

    // RFC 7232：携带 If-None-Match 时忽略 IMS——INM 未命中返回 200 全量
    const miss = await handler({
      url: toImageUrl(file),
      headers: new Headers({
        'If-None-Match': '"bogus"',
        'If-Modified-Since': lastModified,
      }),
    })
    expect(miss.status).toBe(200)
  })

  it('不可变资产（covers/thumbs）304 响应携带 immutable 缓存策略', async () => {
    const coversDir = path.join(root, '.modelvault', 'covers')
    await fs.mkdir(coversDir, { recursive: true })
    const file = path.join(coversDir, 'c1.png')
    await fs.writeFile(file, PNG_MAGIC)
    const first = await handler(makeRequest(file))
    expect(first.status).toBe(200)
    const second = await handler({
      url: toImageUrl(file),
      headers: new Headers({ 'If-None-Match': first.headers.get('etag') }),
    })
    expect(second.status).toBe(304)
    expect(second.headers.get('cache-control')).toContain('immutable')
  })
})
