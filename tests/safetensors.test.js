import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  analyzeTensorIndex,
  checkSafetensorsHealthy,
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
  function buildFile(metadata, tensors) {
    const header = JSON.stringify({
      ...(tensors || {
        'weight': { dtype: 'F16', shape: [1], data_offsets: [0, 2] }
      }),
      ...(metadata ? { __metadata__: metadata } : {})
    })
    const lenBuf = Buffer.alloc(8)
    lenBuf.writeUInt32LE(Buffer.byteLength(header), 0)
    return Buffer.concat([lenBuf, Buffer.from(header, 'utf8'), Buffer.from([1, 2])])
  }

  it('合法头部解析出元信息与张量统计', () => {
    const bytes = buildFile({ ss_resolution: '512x768', ss_base_model_version: 'SD 1.5' })
    expect(readHeaderLength(bytes.subarray(0, 8))).toBe(bytes.readUInt32LE(0))
    const info = parseHeaderBuffer(bytes.subarray(8, 8 + bytes.readUInt32LE(0)))
    expect(info.baseModel).toBe('SD 1.5')
    expect(info.resMin).toBe(512)
    expect(info.resMax).toBe(768)
    // F-1：元信息之外附带张量统计
    expect(info.tensorStats).toMatchObject({ tensorCount: 1, paramCount: 1, dtypeMain: 'F16' })
  })

  it('JSON 损坏或空张量表返回 null', () => {
    expect(parseHeaderBuffer(Buffer.from('{broken'))).toBeNull()
    // 空对象头部：既无元信息也无张量，无可用内容
    const empty = Buffer.from(JSON.stringify({}))
    expect(parseHeaderBuffer(empty)).toBeNull()
  })

  it('无 __metadata__ 但张量合法：返回仅含张量统计的 info（元信息字段全空）', () => {
    const bytes = buildFile(null)
    const info = parseHeaderBuffer(bytes.subarray(8, 8 + bytes.readUInt32LE(0)))
    expect(info).not.toBeNull()
    expect(info.title).toBe('')
    expect(info.triggerCandidates).toEqual([])
    expect(info.tensorStats).toMatchObject({ tensorCount: 1, paramCount: 1, dtypeMain: 'F16' })
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

describe('analyzeTensorIndex（F-1 张量索引统计）', () => {
  it('参数量与 dtype 分布（占参数量降序）', () => {
    const stats = analyzeTensorIndex({
      'a.weight': { dtype: 'F16', shape: [2, 3] }, // 6
      'b.weight': { dtype: 'F32', shape: [4] }, // 4
      'c.weight': { dtype: 'F16', shape: [1, 1, 2] }, // 2
      '__metadata__': { ss_resolution: '512x512' } // 张量键之外跳过
    })
    expect(stats.tensorCount).toBe(3)
    expect(stats.paramCount).toBe(12)
    expect(stats.dtypeMain).toBe('F16')
    expect(stats.dtypes).toEqual([
      { dtype: 'F16', params: 8, tensors: 2 },
      { dtype: 'F32', params: 4, tensors: 1 }
    ])
  })

  it('Checkpoint 架构推导：SDXL 双文本编码器 / SD1.5 单文本编码器', () => {
    const sdxl = analyzeTensorIndex({
      'model.diffusion_model.input_blocks.0.weight': { dtype: 'F16', shape: [1] },
      'conditioner.embedders.0.transformer.w': { dtype: 'F16', shape: [1] },
      'conditioner.embedders.1.transformer.w': { dtype: 'F16', shape: [1] },
      'first_stage_model.decoder.conv_in.weight': { dtype: 'F16', shape: [1] }
    })
    expect(sdxl.architecture).toBe('SDXL')
    const sd15 = analyzeTensorIndex({
      'model.diffusion_model.input_blocks.0.weight': { dtype: 'F16', shape: [1] },
      'conditioner.embedders.0.transformer.text_model.w': { dtype: 'F16', shape: [1] }
    })
    expect(sd15.architecture).toBe('SD1.5')
  })

  it('Checkpoint 架构推导：Flux（text_encoders + double_blocks）与 SD3.5（joint_blocks）', () => {
    const flux = analyzeTensorIndex({
      'model.diffusion_model.double_blocks.0.img_attn.qkv.weight': { dtype: 'BF16', shape: [1] },
      'text_encoders.clip_l.transformer.w': { dtype: 'BF16', shape: [1] },
      'vae.encoder.w': { dtype: 'F16', shape: [1] }
    })
    expect(flux.architecture).toBe('Flux')
    const sd3 = analyzeTensorIndex({
      'model.diffusion_model.joint_blocks.0.x_emb.linear.weight': { dtype: 'BF16', shape: [1] },
      'text_encoders.t5.encoder.w': { dtype: 'BF16', shape: [1] }
    })
    expect(sd3.architecture).toBe('SD3.5')
  })

  it('LoRA 架构推导：Flux blocks / SDXL lora_te2_ / SD1.5 经典 blocks', () => {
    const fluxLora = analyzeTensorIndex({
      'lora_unet_double_blocks_0_img_attn_qkv.lora_down.weight': { dtype: 'F16', shape: [1] },
      'lora_te_text_model.encoder.layers.0.mlp.fc1.lora_down.weight': { dtype: 'F16', shape: [1] }
    })
    expect(fluxLora.architecture).toBe('Flux')
    const sdxlLora = analyzeTensorIndex({
      'lora_te2_text_projection.linear.lora_down.weight': { dtype: 'F16', shape: [1] },
      'lora_unet_output_blocks_0.lora_down.weight': { dtype: 'F16', shape: [1] }
    })
    expect(sdxlLora.architecture).toBe('SDXL')
    const sd15Lora = analyzeTensorIndex({
      'lora_unet_input_blocks_1_1_transformer_blocks_0_attn1.to_q.lora_down.weight': {
        dtype: 'F16', shape: [1]
      }
    })
    expect(sd15Lora.architecture).toBe('SD1.5')
  })

  it('组件字节占比：文本编码器/UNet/VAE 三分类，未分类不计入分母', () => {
    const stats = analyzeTensorIndex({
      // textEncoder: 768*768*2 = 1179648
      'conditioner.embedders.0.transformer.text_model.w': { dtype: 'F16', shape: [768, 768] },
      // unet: 320 * 4 = 1280 bytes
      'model.diffusion_model.input_blocks.0.weight': { dtype: 'F32', shape: [320] },
      // vae: 4*4*1 = 16 bytes
      'first_stage_model.decoder.conv_in.weight': { dtype: 'U8', shape: [4, 4] },
      // 未分类：不计入占比分母
      'misc.weight': { dtype: 'F16', shape: [100] }
    })
    const total = 1179648 + 1280 + 16
    expect(stats.componentRatios.textEncoder).toBeCloseTo(1179648 / total, 6)
    expect(stats.componentRatios.unet).toBeCloseTo(1280 / total, 6)
    expect(stats.componentRatios.vae).toBeCloseTo(16 / total, 6)
  })

  it('无法识别架构与组件时留空/归零（不误判）', () => {
    const stats = analyzeTensorIndex({
      'weight': { dtype: 'F16', shape: [1] }
    })
    expect(stats.architecture).toBe('')
    expect(stats.componentRatios).toEqual({ textEncoder: 0, unet: 0, vae: 0 })
    const vaeOnly = analyzeTensorIndex({
      'decoder.conv_in.weight': { dtype: 'F32', shape: [4] },
      'encoder.conv_out.weight': { dtype: 'F32', shape: [4] }
    })
    expect(vaeOnly.architecture).toBe('')
  })

  it('坏数据容错：无有效张量返回 null，畸形 shape/dtype 被跳过', () => {
    expect(analyzeTensorIndex(null)).toBeNull()
    expect(analyzeTensorIndex({})).toBeNull()
    expect(analyzeTensorIndex({ __metadata__: { a: 1 } })).toBeNull()
    const stats = analyzeTensorIndex({
      'ok.weight': { dtype: 'F16', shape: [2] },
      'no-dtype': { shape: [2] },
      'no-shape': { dtype: 'F16' },
      'empty-shape': { dtype: 'F16', shape: [] },
      'bad-dim': { dtype: 'F16', shape: [2, -1] },
      'bad-entry': 42,
      'unknown-dtype': { dtype: 'XX9', shape: [4] }
    })
    // 缺 dtype/缺 shape/空 shape/非对象条目均被跳过；bad-dim（负维度）计入张量数
    // 但参数量为 0；unknown-dtype 计入张量数与参数量（字节数按 0 计）
    expect(stats.tensorCount).toBe(3)
    expect(stats.paramCount).toBe(2 + 0 + 4)
  })

  it('hasUsefulInfo 不受张量统计影响（维持元信息语义）', () => {
    const empty = extractSafetensorsInfo({ unrelated: 'x' })
    expect(hasUsefulInfo(empty)).toBe(false)
    expect(hasUsefulInfo(null)).toBe(false)
  })
})

describe('checkSafetensorsHealthy（F6 健康检查）', () => {
  /** 构造 safetensors 文件字节（同上 describe 的 buildFile，局部副本） */
  function buildFile(metadata) {
    const header = JSON.stringify({
      'weight': { dtype: 'F16', shape: [1], data_offsets: [0, 2] },
      ...(metadata ? { __metadata__: metadata } : {})
    })
    const lenBuf = Buffer.alloc(8)
    lenBuf.writeUInt32LE(Buffer.byteLength(header), 0)
    return Buffer.concat([lenBuf, Buffer.from(header, 'utf8'), Buffer.from([1, 2])])
  }

  it('合法文件（含/不含元信息）均健康；两者均产出 autoInfo（F-1 张量统计）', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-st-health-'))
    try {
      // 含元信息
      const withMeta = path.join(dir, 'with-meta.safetensors')
      await fs.writeFile(withMeta, buildFile({ ss_base_model_version: 'SD 1.5' }))
      expect(await checkSafetensorsHealthy(withMeta)).toBe(true)
      // 无 __metadata__ 的合法文件：F-1 起返回仅含张量统计的 info（装饰层免健康补检）
      const noMeta = path.join(dir, 'no-meta.safetensors')
      await fs.writeFile(noMeta, buildFile(null))
      const noMetaInfo = await readSafetensorsInfo(noMeta)
      expect(noMetaInfo).not.toBeNull()
      expect(noMetaInfo.tensorStats).toMatchObject({ tensorCount: 1 })
      expect(await checkSafetensorsHealthy(noMeta)).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('损坏文件识别为不健康：垃圾字节、截断、声称头部长度越界、不存在', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-st-broken-'))
    try {
      const garbage = path.join(dir, 'garbage.safetensors')
      await fs.writeFile(garbage, Buffer.from('this is not a safetensors file at all!!!'))
      expect(await checkSafetensorsHealthy(garbage)).toBe(false)

      const truncated = path.join(dir, 'truncated.safetensors')
      await fs.writeFile(truncated, Buffer.from([1, 2, 3]))
      expect(await checkSafetensorsHealthy(truncated)).toBe(false)

      const lying = path.join(dir, 'lying.safetensors')
      const lenBuf = Buffer.alloc(8)
      lenBuf.writeUInt32LE(0xffff, 0)
      await fs.writeFile(lying, Buffer.concat([lenBuf, Buffer.from('{}')]))
      expect(await checkSafetensorsHealthy(lying)).toBe(false)

      expect(await checkSafetensorsHealthy(path.join(dir, 'missing.safetensors'))).toBe(false)
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
