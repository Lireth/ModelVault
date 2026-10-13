import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

/**
 * civitai.js 单元测试（F13/F14）：
 * - 链接解析（parseCivitaiVersionId）：两种页面形态、域名白名单、非法输入
 * - 版本归一化（normalizeVersion）与文件挑选（pickVersionFile）
 * - 流式下载（downloadToFile）：哈希同步校验、失败清理半成品
 *   （net.fetch 以 mock Response 提供 web ReadableStream）
 */

vi.mock('electron', () => ({
  net: { fetch: vi.fn() }
}))

import { net } from 'electron'
import {
  downloadToFile,
  normalizeVersion,
  parseCivitaiVersionId,
  pickVersionFile
} from '../src/main/services/civitai'

describe('parseCivitaiVersionId（F14 链接解析）', () => {
  it('支持 ?modelVersionId= 与路径段两种形态', () => {
    expect(parseCivitaiVersionId('https://civitai.com/models/123456?modelVersionId=789')).toBe(789)
    expect(parseCivitaiVersionId('https://civitai.com/models/123456/789')).toBe(789)
    // 带额外查询参数
    expect(parseCivitaiVersionId('https://civitai.com/models/123?modelVersionId=45&x=1')).toBe(45)
  })

  it('拒绝非 civitai 域、无版本号与非法输入', () => {
    expect(parseCivitaiVersionId('https://evil.com/models/1/2')).toBeNull()
    expect(parseCivitaiVersionId('https://civitai.com/models/123456')).toBeNull()
    expect(parseCivitaiVersionId('https://civitai.com/images/1')).toBeNull()
    expect(parseCivitaiVersionId('not a url')).toBeNull()
    expect(parseCivitaiVersionId(null)).toBeNull()
  })
})

describe('normalizeVersion / pickVersionFile（F13 响应裁剪）', () => {
  it('仅保留消费字段；图片 URL 过滤非 civitai 域', () => {
    const v = normalizeVersion({
      id: 9,
      name: 'v2',
      baseModel: 'SDXL 1.0',
      trainedWords: ['a', ' ', 1, 'b'],
      nsfw: true,
      model: { name: 'Big Model', creator: { username: 'artist' } },
      images: [
        { url: 'https://image.civitai.com/x.jpeg' },
        { url: 'https://evil.com/x.jpeg' },
        { url: 'https://civitai.com/y.png' }
      ]
    })
    expect(v.versionId).toBe(9)
    expect(v.modelName).toBe('Big Model')
    expect(v.creator).toBe('artist')
    expect(v.trainedWords).toEqual(['a', 'b'])
    expect(v.imageUrls).toEqual(['https://image.civitai.com/x.jpeg', 'https://civitai.com/y.png'])
    expect(normalizeVersion(null)).toBeNull()
    expect(normalizeVersion('x')).toBeNull()
  })

  it('优先 primary 的 safetensors 文件；文件名强制 basename', () => {
    const picked = pickVersionFile({
      files: [
        { name: '../../evil/path.safetensors', size: 10, hashes: { SHA256: 'A'.repeat(64) }, primary: true },
        { name: 'preview.png' }
      ]
    })
    expect(picked.filename).toBe('path.safetensors') // basename 防穿越
    expect(picked.sha256).toBe('a'.repeat(64))
    expect(pickVersionFile({ files: [{ name: 'x.png' }] })).toBeNull()
    expect(pickVersionFile({})).toBeNull()
  })
})

describe('downloadToFile（F14 流式下载 + 哈希同步校验）', () => {
  /** 构造流式 Response mock：net.fetch 返回标准 Response（body 为 ReadableStream） */
  function mockFetchStream(bytes, { status = 200 } = {}) {
    vi.mocked(net.fetch).mockResolvedValueOnce(
      new Response(new Uint8Array(bytes), {
        status,
        headers: { 'content-length': String(bytes.length) }
      })
    )
  }

  it('下载落盘且摘要与内容一致', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-dl-'))
    try {
      const bytes = Buffer.alloc(64 * 1024, 7)
      mockFetchStream(bytes)
      const dest = path.join(dir, 'model.safetensors')
      const progress = []
      const r = await downloadToFile('https://civitai.com/api/v1/download/models/1', dest, {
        expectedSha256: createHash('sha256').update(bytes).digest('hex'),
        onProgress: (p) => progress.push(p)
      })
      expect(r.received).toBe(bytes.length)
      const onDisk = await fs.readFile(dest)
      expect(onDisk.length).toBe(bytes.length)
      expect(progress.length).toBeGreaterThan(0)
      await fs.rm(dest, { force: true })
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('哈希校验失败：半成品文件被清理并抛错', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-dlbad-'))
    try {
      mockFetchStream(Buffer.from('corrupted content'))
      const dest = path.join(dir, 'bad.safetensors')
      await expect(
        downloadToFile('https://civitai.com/api/v1/download/models/1', dest, {
          expectedSha256: '0'.repeat(64)
        })
      ).rejects.toThrow('哈希校验失败')
      await expect(fs.access(dest)).rejects.toThrow()
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('目标已存在时拒绝（wx 打开，不覆盖用户文件）；非 civitai 域直接拒绝', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-dlexist-'))
    try {
      const dest = path.join(dir, 'exists.safetensors')
      await fs.writeFile(dest, 'user file')
      await expect(
        downloadToFile('https://civitai.com/api/v1/download/models/1', dest, {})
      ).rejects.toThrow()
      expect(await fs.readFile(dest, 'utf-8')).toBe('user file')
      await expect(
        downloadToFile('https://evil.com/file', path.join(dir, 'x.safetensors'), {})
      ).rejects.toThrow('域名')
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
