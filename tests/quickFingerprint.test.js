import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { computeQuickFingerprint } from '../src/main/services/quick-fingerprint'

/**
 * quick-fingerprint.js 文件快指纹单元测试（OP-C 两阶段查重的阶段一）：
 * - 小文件整读等价性：指纹 = 全文件 SHA256；
 * - 大文件头/尾覆盖：仅头部差异 / 仅尾部差异 / 中段差异（首尾恰同的
 *   超集误报形态）各自的指纹判定；
 * - 确定性：同内容同指纹。
 */

const MB = 1024 * 1024

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

let root
const roots = []

async function makeRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-fp-'))
  roots.push(dir)
  return dir
}

async function makeFile(dir, name, content) {
  const p = path.join(dir, name)
  await fs.writeFile(p, content)
  return { path: p, size: content.length }
}

beforeEach(async () => {
  root = await makeRoot()
})

afterEach(async () => {
  for (const dir of roots.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('computeQuickFingerprint', () => {
  it('小文件（<2MB 头尾重叠）指纹等价于全文件 SHA256', async () => {
    const content = Buffer.alloc(512 * 1024, 0x61)
    const { path: p, size } = await makeFile(root, 'small.bin', content)
    const fp = await computeQuickFingerprint(p, size)
    expect(fp).toBe(sha256(content))
  })

  it('同内容文件指纹相同；不同内容指纹互异', async () => {
    const a = await makeFile(root, 'a.bin', Buffer.alloc(3 * MB, 0x11))
    const a2 = await makeFile(root, 'a2.bin', Buffer.alloc(3 * MB, 0x11))
    const b = await makeFile(root, 'b.bin', Buffer.alloc(3 * MB, 0x22))
    const fpA = await computeQuickFingerprint(a.path, a.size)
    const fpA2 = await computeQuickFingerprint(a2.path, a2.size)
    const fpB = await computeQuickFingerprint(b.path, b.size)
    expect(fpA).toBe(fpA2)
    expect(fpA).not.toBe(fpB)
  })

  it('仅头部差异即可区分（尾 1MB 相同）', async () => {
    const base = Buffer.alloc(3 * MB, 0x33)
    const variant = Buffer.concat([Buffer.alloc(64, 0x34), base.subarray(64)])
    const a = await makeFile(root, 'head-a.bin', base)
    const b = await makeFile(root, 'head-b.bin', variant)
    const fpA = await computeQuickFingerprint(a.path, a.size)
    const fpB = await computeQuickFingerprint(b.path, b.size)
    expect(fpA).not.toBe(fpB)
  })

  it('仅尾部差异即可区分（头 1MB 相同）', async () => {
    const base = Buffer.alloc(3 * MB, 0x44)
    const variant = Buffer.concat([
      base.subarray(0, 3 * MB - 64),
      Buffer.alloc(64, 0x45),
    ])
    const a = await makeFile(root, 'tail-a.bin', base)
    const b = await makeFile(root, 'tail-b.bin', variant)
    const fpA = await computeQuickFingerprint(a.path, a.size)
    const fpB = await computeQuickFingerprint(b.path, b.size)
    expect(fpA).not.toBe(fpB)
  })

  it('首尾恰同、中段不同 → 指纹相同（超集语义：交由全量 SHA256 排除）', async () => {
    const head = Buffer.alloc(MB, 0x51)
    const tail = Buffer.alloc(MB, 0x52)
    const a = await makeFile(
      root,
      'mid-a.bin',
      Buffer.concat([head, Buffer.alloc(MB, 0x53), tail]),
    )
    const b = await makeFile(
      root,
      'mid-b.bin',
      Buffer.concat([head, Buffer.alloc(MB, 0x54), tail]),
    )
    const fpA = await computeQuickFingerprint(a.path, a.size)
    const fpB = await computeQuickFingerprint(b.path, b.size)
    // 设计文档化的超集形态：指纹相同不代表内容相同，只代表进入候选组
    expect(fpA).toBe(fpB)
    expect(sha256(await fs.readFile(a.path))).not.toBe(
      sha256(await fs.readFile(b.path)),
    )
  })

  it('size 参数未知（0）时按实际文件读取，结果一致', async () => {
    const content = Buffer.alloc(2 * MB + 128, 0x66)
    const { path: p } = await makeFile(root, 'unknown-size.bin', content)
    const withSize = await computeQuickFingerprint(p, content.length)
    const withoutSize = await computeQuickFingerprint(p, 0)
    expect(withSize).toBe(withoutSize)
  })

  it('文件不存在时抛错（调用方决定缓存与重试语义）', async () => {
    const gone = path.join(root, 'gone.bin')
    await expect(computeQuickFingerprint(gone, 1024)).rejects.toThrow()
  })
})
