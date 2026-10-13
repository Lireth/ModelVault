import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { computeFileSha256, groupDuplicateModels } from '../src/main/services/hash'

/**
 * hash.js 单元测试（F9）：
 * - computeFileSha256：流式计算与 node:crypto 基准一致；0 字节与取消信号
 * - groupDuplicateModels：按「SHA256 + 字节数」分组，仅保留 ≥2 成员组
 */

describe('computeFileSha256（F9）', () => {
  it('与 node:crypto 一次性摘要一致（含跨 4MB 分块的大文件）', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-hash-'))
    try {
      const small = path.join(dir, 'small.safetensors')
      const smallBytes = Buffer.from('model bytes here')
      await fs.writeFile(small, smallBytes)
      const expectedSmall = createHash('sha256').update(smallBytes).digest('hex')
      expect(await computeFileSha256(small)).toBe(expectedSmall)

      // 9MB：跨越 4MB 分块边界两次，验证分块拼接正确
      const big = path.join(dir, 'big.safetensors')
      const bigBytes = Buffer.alloc(9 * 1024 * 1024)
      for (let i = 0; i < bigBytes.length; i += 4096) bigBytes.write(`block-${i}`, i)
      await fs.writeFile(big, bigBytes)
      const expectedBig = createHash('sha256').update(bigBytes).digest('hex')
      expect(await computeFileSha256(big)).toBe(expectedBig)
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('0 字节文件返回空数据的摘要（sha256 of empty）；不存在的文件抛错', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-hash0-'))
    try {
      const empty = path.join(dir, 'empty.safetensors')
      await fs.writeFile(empty, '')
      expect(await computeFileSha256(empty)).toBe(
        createHash('sha256').update(Buffer.alloc(0)).digest('hex')
      )
      await expect(computeFileSha256(path.join(dir, 'missing.safetensors'))).rejects.toThrow()
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('取消信号中止计算并抛 AbortError', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-hashcancel-'))
    try {
      const big = path.join(dir, 'big.bin')
      await fs.writeFile(big, Buffer.alloc(16 * 1024 * 1024, 1))
      const controller = new AbortController()
      controller.abort()
      await expect(computeFileSha256(big, controller.signal)).rejects.toMatchObject({
        name: 'AbortError'
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe('groupDuplicateModels（F9 去重分组）', () => {
  const h1 = 'a'.repeat(64)
  const h2 = 'b'.repeat(64)

  it('同哈希同字节数的模型成组；字节数不同或哈希不同不成组', () => {
    const groups = groupDuplicateModels([
      { id: 'd:/a1.safetensors', hash: h1, size: 100 },
      { id: 'd:/a2.safetensors', hash: h1, size: 100 },
      // 同哈希不同大小：极小概率哈希碰撞场景，不应误判为重复
      { id: 'd:/a3.safetensors', hash: h1, size: 200 },
      { id: 'd:/b1.safetensors', hash: h2, size: 100 },
      // 无哈希（未计算）不参与
      { id: 'd:/c1.safetensors', size: 100 }
    ])
    expect(groups.size).toBe(1)
    expect(groups.get(`${h1}:100`)).toEqual(['d:/a1.safetensors', 'd:/a2.safetensors'])
  })

  it('全部唯一时返回空 Map', () => {
    expect(groupDuplicateModels([{ id: 'x', hash: h1, size: 1 }]).size).toBe(0)
    expect(groupDuplicateModels([]).size).toBe(0)
  })
})
