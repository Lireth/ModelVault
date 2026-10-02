import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fakeUserData } from './setup'

/**
 * civitai.js 服务层单元测试（D2：改动热点补测）。
 * electron net.fetch 统一 mock，文件哈希用真实临时文件计算：
 * - AutoV2 哈希复用（knownHash 跳过重算）
 * - 404 未匹配 / 非 404 错误码 / 响应体损坏 / 超时的错误映射
 * - 匹配结果映射（mapVersion/extractExampleParams 经真实响应夹具覆盖）
 * - 进程内匹配缓存命中（同路径同 mtime 不重复发起网络请求）
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  net: { fetch: vi.fn() }
}))

import { net } from 'electron'
import { matchCivitai } from '../src/main/services/civitai'

const roots = []
let root
let modelFile

/** 夹具：Civitai 版本响应（含示例图元信息与触发词） */
const VERSION_FIXTURE = {
  id: 456,
  name: 'v1.0',
  baseModel: 'SDXL 1.0',
  model: {
    id: 123,
    name: '测试模型',
    type: 'LORA',
    creator: { username: 'author-a' }
  },
  trainedWords: ['trigger1', 'trigger2', '', 42],
  files: [{ metadata: { fp: 'fp16' } }],
  images: [
    { meta: null },
    {
      meta: { steps: 28, cfgScale: 7, sampler: 'euler', scheduler: 'karras', width: 832, height: 1216 }
    }
  ]
}

/** 构造 Response 风格的最小桩 */
function makeResponse({ status = 200, json = null } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: json ? () => Promise.resolve(json) : () => Promise.reject(new Error('Invalid JSON'))
  }
}

beforeEach(async () => {
  vi.mocked(net.fetch).mockReset()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-civitai-'))
  roots.push(root)
  // 写入确定性内容的模型文件（哈希可预计算）
  modelFile = path.join(root, 'model-a.safetensors')
  await fs.writeFile(modelFile, 'model-content-for-hash')
})

afterEach(async () => {
  for (const dir of roots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('matchCivitai 哈希与缓存', () => {
  it('用文件真实 SHA256（AutoV2 哈希）查询，命中时返回匹配结果', async () => {
    const expectedHash = createHash('sha256').update('model-content-for-hash').digest('hex')
    vi.mocked(net.fetch).mockResolvedValue(makeResponse({ json: VERSION_FIXTURE }))

    const res = await matchCivitai(modelFile)
    expect(res.matched).toBe(true)
    expect(res.hash).toBe(expectedHash)
    expect(net.fetch).toHaveBeenCalledWith(
      `https://civitai.com/api/v1/model-versions/by-hash/${expectedHash}`,
      expect.objectContaining({ headers: { 'User-Agent': 'ModelVault/0.1.0' } })
    )
    // 结果映射（mapVersion + extractExampleParams）
    expect(res.info.modelName).toBe('测试模型')
    expect(res.info.versionName).toBe('v1.0')
    expect(res.info.baseModel).toBe('SDXL 1.0')
    expect(res.info.modelType).toBe('LORA')
    expect(res.info.creator).toBe('author-a')
    expect(res.info.precision).toBe('fp16')
    // trainedWords 过滤空串与非字符串并截断到 20
    expect(res.info.trainedWords).toEqual(['trigger1', 'trigger2'])
    // 示例参数取第一张含参数的图；分辨率区间宽高取 min/max
    expect(res.info.exampleParams).toEqual({
      steps: 28,
      cfgMin: 7,
      cfgMax: 7,
      sampler: 'euler',
      scheduler: 'karras',
      resMin: 832,
      resMax: 1216
    })
    expect(res.info.pageUrl).toBe('https://civitai.com/models/123?modelVersionId=456')
  })

  it('传入合法 knownHash 时跳过哈希计算直接复用', async () => {
    const known = createHash('sha256').update('other-content').digest('hex')
    vi.mocked(net.fetch).mockResolvedValue(makeResponse({ status: 404 }))
    const res = await matchCivitai(modelFile, known)
    expect(res).toEqual({ matched: false, hash: known })
  })

  it('非法 knownHash（非 64 位十六进制）时回退计算真实哈希', async () => {
    const expectedHash = createHash('sha256').update('model-content-for-hash').digest('hex')
    vi.mocked(net.fetch).mockResolvedValue(makeResponse({ status: 404 }))
    const res = await matchCivitai(modelFile, 'not-a-hash')
    expect(res.hash).toBe(expectedHash)
  })

  it('同路径同 mtime 的重复匹配走进程内缓存，不重复发起网络请求', async () => {
    vi.mocked(net.fetch).mockResolvedValue(makeResponse({ status: 404 }))
    const first = await matchCivitai(modelFile)
    const second = await matchCivitai(modelFile)
    expect(net.fetch).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)
  })

  it('已知哈希的 404 结果同样缓存，未匹配为稳定结论而非错误', async () => {
    const known = createHash('sha256').update('other-content').digest('hex')
    vi.mocked(net.fetch).mockResolvedValue(makeResponse({ status: 404 }))
    await matchCivitai(modelFile, known)
    await matchCivitai(modelFile, known)
    expect(net.fetch).toHaveBeenCalledTimes(1)
  })
})

describe('matchCivitai 错误映射', () => {
  it('404 返回 { matched: false } 而非抛错', async () => {
    vi.mocked(net.fetch).mockResolvedValue(makeResponse({ status: 404 }))
    await expect(matchCivitai(modelFile)).resolves.toMatchObject({ matched: false })
  })

  it('非 404 错误码转换为含状态码的友好错误', async () => {
    vi.mocked(net.fetch).mockResolvedValue(makeResponse({ status: 503 }))
    await expect(matchCivitai(modelFile)).rejects.toThrow('Civitai API 返回 503')
  })

  it('响应体非 JSON（网关错误页）时转换为友好错误（S6）', async () => {
    vi.mocked(net.fetch).mockResolvedValue(makeResponse({ json: null }))
    await expect(matchCivitai(modelFile)).rejects.toThrow('Civitai 响应解析失败')
  })

  it('网络超时映射为可读的超时提示', async () => {
    vi.mocked(net.fetch).mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })
    )
    await expect(matchCivitai(modelFile)).rejects.toThrow('请求 Civitai 超时')
  })

  it('网络异常转换为含原始信息的失败提示', async () => {
    vi.mocked(net.fetch).mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(matchCivitai(modelFile)).rejects.toThrow('网络请求失败: ECONNREFUSED')
  })

  it('模型文件不存在时直接抛出 stat 错误', async () => {
    await expect(matchCivitai(path.join(root, 'missing.safetensors'))).rejects.toThrow()
    expect(net.fetch).not.toHaveBeenCalled()
  })
})
