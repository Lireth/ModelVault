import { afterAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  extractSafetensorsInfo,
  extractTagCandidates,
  hasUsefulInfo,
  parseHeaderBuffer,
  parseResolution,
  readHeaderLength,
  readSafetensorsInfo
} from '../src/main/services/safetensors'

/**
 * safetensors.js 单元测试（纯逻辑，无 UI）：
 * - 头部长度读取（小端 u64）与非法缓冲容错
 * - 训练分辨率文本解析（WxH -> min/max 区间）
 * - ss_tag_frequency 触发词候选提取（频次排序、截断、坏数据容错）
 * - __metadata__ 字段提取（kohya ss_* / modelspec.*）
 * - 真实文件读取（临时目录构造合法/损坏文件）
 */

afterAll(async () => {
  await fs.rm(os.tmpdir(), { recursive: true, force: false }).catch(() => {})
})

describe('readHeaderLength', () => {
  it('小端 u64 正确读取，非法缓冲返回 0', () => {
    const buf = Buffer.alloc(8)
    buf.writeUInt32LE(0x00000100, 0) // 低 32 位 = 256
    buf.writeUInt32LE(0, 4) // 高 32 位 = 0
    expect(readHeaderLength(buf)).toBe(256)
    const big = Buffer.alloc(8)
    big.writeUInt32LE(0xffffffff, 0)
    big.writeUInt32LE(1, 4)
    expect(readHeaderLength(big)).toBe(0xffffffff + 1 * 2 ** 32)
    expect(readHeaderLength(Buffer.alloc(4))).toBe(0)
    expect(readHeaderLength(null)).toBe(0)
  })
})

describe('parseResolution', () => {
  it('标准与浮点格式解析为 min/max 区间', () => {
    expect(parseResolution('1024x1024')).toEqual({ min: 1024, max: 1024 })
    expect(parseResolution('832.0x1216.0')).toEqual({ min: 832, max: 1216 })
    expect(parseResolution('1216 X 832')).toEqual({ min: 832, max: 1216 })
  })

  it('非法输入返回 null', () => {
    expect(parseResolution('')).toBeNull()
    expect(parseResolution('1024')).toBeNull()
    expect(parseResolution('abcxdef')).toBeNull()
    expect(parseResolution(null)).toBeNull()
    expect(parseResolution(1024)).toBeNull()
  })
})

describe('extractTagCandidates', () => {
  const table = {
    'dataset_a': { '1girl': 120, 'solo': 80, 'hatsune miku': 60 },
    'dataset_b': { '1girl': 30, 'twintails': 45 }
  }

  it('跨数据集聚合频次并降序排列', () => {
    const tags = extractTagCandidates(table)
    expect(tags[0]).toBe('1girl') // 120 + 30
    expect(tags[1]).toBe('solo') // 80
    expect(tags).toContain('twintails')
  })

  it('limit 截断与空标签剔除', () => {
    expect(extractTagCandidates(table, 2)).toHaveLength(2)
    const withBlank = { d: { '  ': 5, ok: 1 } }
    expect(extractTagCandidates(withBlank)).toEqual(['ok'])
  })

  it('JSON 字符串自动解析', () => {
    expect(extractTagCandidates(JSON.stringify(table))).toContain('hatsune miku')
  })

  it('坏数据容错返回空数组', () => {
    expect(extractTagCandidates('not json{')).toEqual([])
    expect(extractTagCandidates(null)).toEqual([])
    expect(extractTagCandidates(42)).toEqual([])
    expect(extractTagCandidates({ d: 'not-an-object' })).toEqual([])
  })
})

describe('extractSafetensorsInfo / hasUsefulInfo', () => {
  it('kohya ss_* 与 modelspec.* 字段完整提取', () => {
    const info = extractSafetensorsInfo({
      ss_base_model_version: 'SDXL 1.0',
      ss_network_module: 'networks.lora',
      ss_network_alpha: '8',
      ss_resolution: '1024.0x1024.0',
      ss_mixed_precision: 'fp16',
      'modelspec.title': 'My LoRA',
      'modelspec.author': 'someone',
      ss_tag_frequency: JSON.stringify({ d: { miku: 10 } })
    })
    expect(info).toEqual({
      title: 'My LoRA',
      author: 'someone',
      baseModel: 'SDXL 1.0',
      networkModule: 'networks.lora',
      networkAlpha: 8,
      precision: 'fp16',
      resMin: 1024,
      resMax: 1024,
      triggerCandidates: ['miku']
    })
    expect(hasUsefulInfo(info)).toBe(true)
  })

  it('modelspec.architecture 作为基底模型兜底', () => {
    const info = extractSafetensorsInfo({ 'modelspec.architecture': 'StableDiffusionXL' })
    expect(info.baseModel).toBe('StableDiffusionXL')
  })

  it('无有效内容时 hasUsefulInfo 为 false', () => {
    const empty = extractSafetensorsInfo({ unrelated: 'x' })
    expect(hasUsefulInfo(empty)).toBe(false)
    expect(hasUsefulInfo(null)).toBe(false)
  })

  it('metadata 无效返回 null', () => {
    expect(extractSafetensorsInfo(null)).toBeNull()
    expect(extractSafetensorsInfo('str')).toBeNull()
  })
})

describe('parseHeaderBuffer / readSafetensorsInfo', () => {
  /** 构造 safetensors 文件字节：8 字节长度 + 头部 JSON（含一个张量占位） */
  function buildFile(metadata) {
    const header = JSON.stringify({
      'weight': { dtype: 'F16', shape: [1], data_offsets: [0, 2] },
      ...(metadata ? { __metadata__: metadata } : {})
    })
    const lenBuf = Buffer.alloc(8)
    lenBuf.writeUInt32LE(Buffer.byteLength(header), 0)
    return Buffer.concat([lenBuf, Buffer.from(header, 'utf8'), Buffer.from([1, 2])])
  }

  it('合法头部解析出元信息', () => {
    const bytes = buildFile({ ss_resolution: '512x768', ss_base_model_version: 'SD 1.5' })
    expect(readHeaderLength(bytes.subarray(0, 8))).toBe(bytes.readUInt32LE(0))
    const info = parseHeaderBuffer(bytes.subarray(8, 8 + bytes.readUInt32LE(0)))
    expect(info.baseModel).toBe('SD 1.5')
    expect(info.resMin).toBe(512)
    expect(info.resMax).toBe(768)
  })

  it('JSON 损坏或无 __metadata__ 返回 null', () => {
    expect(parseHeaderBuffer(Buffer.from('{broken'))).toBeNull()
    const noMeta = buildFile(null)
    expect(parseHeaderBuffer(noMeta.subarray(8, 8 + noMeta.readUInt32LE(0)))).toBeNull()
  })

  it('真实文件读取：合法文件返回信息，损坏文件与短文件静默返回 null', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-st-'))
    try {
      const good = path.join(dir, 'good.safetensors')
      await fs.writeFile(good, buildFile({ ss_base_model_version: 'Flux.1', ss_resolution: '1024x1024' }))
      const info = await readSafetensorsInfo(good)
      expect(info.baseModel).toBe('Flux.1')
      expect(info.resMin).toBe(1024)

      const broken = path.join(dir, 'broken.safetensors')
      await fs.writeFile(broken, Buffer.from([1, 2, 3]))
      expect(await readSafetensorsInfo(broken)).toBeNull()

      // 头部长度越界（声称的头部超过剩余字节）返回 null
      const lying = path.join(dir, 'lying.safetensors')
      const lenBuf = Buffer.alloc(8)
      lenBuf.writeUInt32LE(0xffff, 0)
      await fs.writeFile(lying, Buffer.concat([lenBuf, Buffer.from('{}')]))
      expect(await readSafetensorsInfo(lying)).toBeNull()
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
