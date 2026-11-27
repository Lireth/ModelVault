import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { fakeUserData } from './setup'
import logger from '../src/main/logger'
import {
  parseJsonOffThread,
  resetJsonSerializerForTests,
  serializeJsonOffThread,
} from '../src/main/services/json-serializer'

/**
 * JSON 序列化/解析线程（OPT-03 / B1 读路径降载）：
 * - worker 正向：序列化（含/不含哈希前缀）、大文本 worker 解析；
 * - 回退语义（数据落盘链路的最后防线）：不可克隆值 postMessage 拒绝、
 *   worker 内计算错误（循环引用）、任务超时——三种故障都必须静默回退
 *   主线程并产出与 worker 等价的结果，绝不因线程问题丢失写入；
 * - 阈值分流：小文本主线程直接 parse；解析错误语义与 JSON.parse 一致
 *   （照常抛出，调用方的损坏检测分支不受影响）。
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
}))

beforeEach(async () => {
  // 单例 worker 与在途任务表按用例隔离（回退类用例会主动击毁 worker）
  await resetJsonSerializerForTests()
})

afterAll(async () => {
  await resetJsonSerializerForTests()
})

describe('serializeJsonOffThread', () => {
  it('worker 正向：文本/字节数/带前缀 SHA256 与主线程计算完全一致', async () => {
    const value = { models: [{ id: 'a.safetensors', size: 1 }], n: 42 }
    const res = await serializeJsonOffThread(value, {
      hash: true,
      hashPrefix: '2\u0000C:\\root\u0000',
    })
    const text = JSON.stringify(value)
    expect(res.text).toBe(text)
    expect(res.bytes).toBe(Buffer.byteLength(text, 'utf-8'))
    expect(res.hash).toBe(
      createHash('sha256')
        .update('2\u0000C:\\root\u0000')
        .update(text)
        .digest('hex'),
    )
  })

  it('不请求哈希时 hash 为空串', async () => {
    const res = await serializeJsonOffThread({ a: 1 })
    expect(res.text).toBe('{"a":1}')
    expect(res.hash).toBe('')
  })

  it('循环引用：worker 报错回退主线程后仍抛出（语义与 JSON.stringify 一致）', async () => {
    const circular = { name: 'loop' }
    circular.self = circular
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      await expect(serializeJsonOffThread(circular)).rejects.toThrow()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('不可克隆值（函数）：postMessage 拒绝即回退，序列化结果丢弃函数键', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const res = await serializeJsonOffThread({ fn: () => {}, a: 1 })
      expect(res.text).toBe('{"a":1}')
      expect(res.bytes).toBe(7)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('任务超时：在途与后续任务全部回退主线程，结果不因线程故障丢失', async () => {
    // 先投递一个远超 1ms 预算的大任务占住串行 worker，再投超时任务：
    // 定时器命中 failWorker，两个任务均按主线程回退路径完成
    const big = Array.from({ length: 2_000_000 }, (_, i) => i)
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const pA = serializeJsonOffThread(big)
      const pB = serializeJsonOffThread({ ok: 1 }, { timeoutMs: 1 })
      const [a, b] = await Promise.all([pA, pB])
      expect(a.text).toBe(JSON.stringify(big))
      expect(b.text).toBe('{"ok":1}')
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('JSON 序列化线程不可用，回退主线程'),
      )
    } finally {
      warnSpy.mockRestore()
      await resetJsonSerializerForTests()
    }
  })
})

describe('parseJsonOffThread', () => {
  it('小文本走主线程：解析结果与 JSON.parse 一致', async () => {
    expect(await parseJsonOffThread('{"a":1}')).toEqual({ a: 1 })
  })

  it('小文本非法 JSON：照常抛出（调用方损坏检测分支语义不变）', async () => {
    await expect(parseJsonOffThread('{bad')).rejects.toThrow()
  })

  it('超过阈值的大文本走 worker 解析：结构化克隆回传内容一致', async () => {
    const pad = 'x'.repeat(4 * 1024 * 1024 + 16)
    const parsed = await parseJsonOffThread(JSON.stringify({ pad }))
    expect(parsed.pad).toHaveLength(pad.length)
  })

  it('大文本非法 JSON：worker 报错回退主线程后仍抛出', async () => {
    const bad = '[' + 'x'.repeat(4 * 1024 * 1024 + 16)
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      await expect(parseJsonOffThread(bad)).rejects.toThrow()
    } finally {
      warnSpy.mockRestore()
    }
  })
})
