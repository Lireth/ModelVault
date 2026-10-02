import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fakeUserData } from './setup'

/**
 * mvimg:// 自定义协议单元测试（D2：README 承诺的安全边界补回归用例）。
 * 路径白名单校验（realpath 归一后比对当前根目录）是防越界读取的核心：
 * - 非 local host → 400
 * - 不存在路径 → 404
 * - 根目录外真实文件 → 403（越界拒绝，B8 防符号链接绕过的前置）
 * - 根目录内图片 → 放行并经 net.fetch(file://) 读取
 * - 根目录内伪装扩展名（非图片扩展）→ 404
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn()
  },
  net: { fetch: vi.fn() }
}))

import { net, protocol } from 'electron'
import { registerImageProtocolHandler, toImageUrl } from '../src/main/protocol'
import { setDataRoot } from '../src/main/services/store'

const roots = []
let root
/** 注册时捕获的协议处理器 */
let handler

/** 构造 mvimg 请求（与渲染进程 toImageUrl 生成格式一致） */
function makeRequest(absPath) {
  return { url: toImageUrl(absPath) }
}

beforeEach(async () => {
  vi.mocked(protocol.handle).mockClear()
  vi.mocked(net.fetch).mockReset()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-protocol-'))
  roots.push(root)
  setDataRoot(root)
  registerImageProtocolHandler()
  const call = vi.mocked(protocol.handle).mock.calls.pop()
  handler = call?.[1]
  expect(typeof handler).toBe('function')
})

afterEach(async () => {
  for (const dir of roots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('mvimg 协议路径白名单', () => {
  it('非 local host 的请求返回 400', async () => {
    const res = await handler({ url: 'mvimg://evil/some-path' })
    expect(res.status).toBe(400)
  })

  it('不存在的路径（realpath 失败）返回 404', async () => {
    const res = await handler(makeRequest(path.join(root, 'missing.png')))
    expect(res.status).toBe(404)
  })

  it('根目录外的真实文件返回 403（越界拒绝）', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-outside-'))
    roots.push(outsideDir)
    const outsideFile = path.join(outsideDir, 'secret.png')
    await fs.writeFile(outsideFile, 'x')
    const res = await handler(makeRequest(outsideFile))
    expect(res.status).toBe(403)
  })

  it('根目录内的图片文件放行，经 net.fetch 以 file:// 读取', async () => {
    const cover = path.join(root, 'cover.png')
    await fs.writeFile(cover, 'fake-png-content')
    vi.mocked(net.fetch).mockResolvedValue({ status: 200, body: 'img' })
    const res = await handler(makeRequest(cover))
    expect(res.status).toBe(200)
    const fetchUrl = vi.mocked(net.fetch).mock.calls[0][0]
    expect(fetchUrl.startsWith('file://')).toBe(true)
    expect(decodeURIComponent(fetchUrl)).toContain('cover.png')
  })

  it('根目录内的非图片扩展文件返回 404（扩展名白名单）', async () => {
    const note = path.join(root, 'notes.txt')
    await fs.writeFile(note, 'text')
    const res = await handler(makeRequest(note))
    expect(res.status).toBe(404)
    expect(net.fetch).not.toHaveBeenCalled()
  })

  it('旧版全局封面目录（userData/covers）内的文件放行（历史数据兼容）', async () => {
    const legacyDir = path.join(fakeUserData, 'covers')
    await fs.mkdir(legacyDir, { recursive: true })
    const legacyCover = path.join(legacyDir, 'old-cover.png')
    await fs.writeFile(legacyCover, 'x')
    try {
      vi.mocked(net.fetch).mockResolvedValue({ status: 200 })
      const res = await handler(makeRequest(legacyCover))
      expect(res.status).toBe(200)
    } finally {
      await fs.rm(legacyCover, { force: true }).catch(() => {})
    }
  })

  it('未设置根目录时（getCurrentRoot 为 null）仅放行旧版目录', async () => {
    setDataRoot(null)
    const inOldRoot = path.join(root, 'cover.png')
    await fs.writeFile(inOldRoot, 'x')
    const res = await handler(makeRequest(inOldRoot))
    expect(res.status).toBe(403)
  })
})

describe('toImageUrl', () => {
  it('构造 mvimg://local/ 前缀并 encodeURIComponent 编码绝对路径', () => {
    const p = path.join('D:', 'models', 'a b', 'c.png')
    expect(toImageUrl(p)).toBe(`mvimg://local/${encodeURIComponent(p)}`)
  })

  it('空路径返回空串', () => {
    expect(toImageUrl('')).toBe('')
    expect(toImageUrl(null)).toBe('')
  })
})
