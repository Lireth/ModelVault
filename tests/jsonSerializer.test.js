import { afterEach, describe, expect, it } from 'vitest'
import {
  resetJsonSerializerForTests,
  serializeJsonOffThread,
} from '../src/main/services/json-serializer'

/**
 * JSON 序列化线程（OPT-03）：
 * - 值往返与 UTF-8 字节数；
 * - 可选 SHA256 与 hashPrefix；
 * - 线程不可用时回退主线程（非法值仍会失败，不伪造成功）。
 */

afterEach(async () => {
  await resetJsonSerializerForTests()
})

describe('json-serializer', () => {
  it('在 worker 中序列化并返回文本/字节数/哈希', async () => {
    const value = { 名称: '模型', list: [1, 2, 3], nested: { ok: true } }
    const result = await serializeJsonOffThread(value, {
      hash: true,
      hashPrefix: 'index\u0000',
    })
    expect(JSON.parse(result.text)).toEqual(value)
    expect(result.bytes).toBeGreaterThan(0)
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('不请求哈希时不返回哈希', async () => {
    const result = await serializeJsonOffThread([1, 2])
    expect(result.text).toBe('[1,2]')
    expect(result.hash).toBe('')
  })

  it('不可克隆/不可序列化值失败，不返回伪成功', async () => {
    const circular = {}
    circular.self = circular
    await expect(serializeJsonOffThread(circular)).rejects.toThrow()
  })
})
