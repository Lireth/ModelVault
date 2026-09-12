import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { classifyModel, findSidecarPreview, isValidType, scanModels } from '../src/main/services/scanner'

/**
 * scanner.js 单元测试：
 * - classifyModel 分类规则（文件夹优先 + 文件名关键词兜底 + 优先级顺序）
 * - scanModels 递归扫描（扩展名过滤、排除目录、进度回调）
 * - findSidecarPreview 同名预览图查找
 */

describe('classifyModel', () => {
  it('按文件夹段分类（不区分大小写）', () => {
    expect(classifyModel(['models', 'lora'], 'a.safetensors')).toBe('lora')
    expect(classifyModel(['LoRA'], 'a.safetensors')).toBe('lora')
    expect(classifyModel(['vae'], 'a.safetensors')).toBe('vae')
    expect(classifyModel(['text_encoders'], 'a.safetensors')).toBe('text_encoder')
    expect(classifyModel(['clip'], 'a.safetensors')).toBe('text_encoder')
    expect(classifyModel(['checkpoints'], 'a.safetensors')).toBe('checkpoint')
    expect(classifyModel(['stable-diffusion'], 'a.ckpt')).toBe('checkpoint')
    expect(classifyModel(['unet'], 'a.safetensors')).toBe('checkpoint')
  })

  it('文件夹规则优先级与路径段顺序无关（规则声明顺序即优先级）', () => {
    // lora 优先级高于 checkpoint：即使 checkpoints 段在前也判为 lora
    expect(classifyModel(['checkpoints', 'lora'], 'a.safetensors')).toBe('lora')
    expect(classifyModel(['lora', 'checkpoints'], 'a.safetensors')).toBe('lora')
  })

  it('文件夹未命中时按文件名关键词兜底', () => {
    expect(classifyModel(['downloads'], 'foo-lora-01.pt')).toBe('lora')
    expect(classifyModel(['downloads'], 'my.model-vae.pth')).toBe('vae')
    expect(classifyModel(['downloads'], 't5-xxl.safetensors')).toBe('text_encoder')
    expect(classifyModel(['downloads'], 'text-encoder.bin')).toBe('text_encoder')
    expect(classifyModel(['downloads'], 'sdxl-base.safetensors')).toBe('checkpoint')
    expect(classifyModel(['downloads'], 'just-a-model.safetensors')).toBe('other')
  })

  it('无效类型校验', () => {
    expect(isValidType('lora')).toBe(true)
    expect(isValidType('other')).toBe(true)
    expect(isValidType('nonexistent')).toBe(false)
  })
})

describe('scanModels', () => {
  let root

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-scan-'))
    // 结构：
    //   root/a.safetensors                     -> 命中
    //   root/lora/b.ckpt                       -> 命中（分类 lora）
    //   root/notes/readme.txt                  -> 扩展名过滤
    //   root/temp/c.safetensors                -> 用户排除目录
    //   root/$RECYCLE.BIN/d.safetensors        -> 内置排除目录
    //   root/put_interfaces.bin                -> put_ 前缀排除
    //   root/empty.safetensors                 -> 命中（后续删除以测试容错）
    await fs.writeFile(path.join(root, 'a.safetensors'), 'x')
    await fs.mkdir(path.join(root, 'lora'))
    await fs.writeFile(path.join(root, 'lora', 'b.ckpt'), 'x')
    await fs.mkdir(path.join(root, 'notes'))
    await fs.writeFile(path.join(root, 'notes', 'readme.txt'), 'x')
    await fs.mkdir(path.join(root, 'temp'))
    await fs.writeFile(path.join(root, 'temp', 'c.safetensors'), 'x')
    await fs.mkdir(path.join(root, '$RECYCLE.BIN'))
    await fs.writeFile(path.join(root, '$RECYCLE.BIN', 'd.safetensors'), 'x')
    await fs.writeFile(path.join(root, 'put_interfaces.bin'), 'x')
    await fs.writeFile(path.join(root, 'empty.safetensors'), 'x')
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('递归扫描：扩展名过滤 + 排除目录 + 分类标注', async () => {
    const { models, errors, dirCount } = await scanModels(root, undefined, {
      excludeDirs: ['temp']
    })
    expect(errors).toHaveLength(0)
    expect(dirCount).toBeGreaterThanOrEqual(3)
    const ids = models.map((m) => m.id)
    expect(ids).toContain(path.join(root, 'a.safetensors'))
    expect(ids).toContain(path.join(root, 'lora', 'b.ckpt'))
    // 排除项
    expect(ids).not.toContain(path.join(root, 'notes', 'readme.txt'))
    expect(ids).not.toContain(path.join(root, 'temp', 'c.safetensors'))
    expect(ids).not.toContain(path.join(root, '$RECYCLE.BIN', 'd.safetensors'))
    expect(ids).not.toContain(path.join(root, 'put_interfaces.bin'))
    // 分类
    const b = models.find((m) => m.name === 'b')
    expect(b.type).toBe('lora')
    expect(b.ext).toBe('.ckpt')
    expect(b.relDir).toBe('lora')
    expect(typeof b.size).toBe('number')
    expect(typeof b.mtimeMs).toBe('number')
  })

  it('支持自定义扩展名白名单', async () => {
    const { models } = await scanModels(root, undefined, {
      extensions: ['.ckpt']
    })
    expect(models).toHaveLength(1)
    expect(models[0].name).toBe('b')
  })

  it('进度回调按发现顺序推送', async () => {
    const progressEvents = []
    await scanModels(root, (p) => progressEvents.push({ ...p }))
    expect(progressEvents.length).toBeGreaterThan(0)
    for (const p of progressEvents) {
      expect(p.dirs).toBeGreaterThan(0)
      expect(p.found).toBeGreaterThan(0)
      expect(typeof p.current).toBe('string')
    }
  })

  it('目录不存在时返回错误而非抛出', async () => {
    const { models, errors } = await scanModels(path.join(root, 'not-exist'))
    expect(models).toHaveLength(0)
    expect(errors).toHaveLength(1)
  })
})

describe('findSidecarPreview', () => {
  let dir

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-sidecar-'))
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('优先命中 name.png', async () => {
    const modelPath = path.join(dir, 'model1.safetensors')
    await fs.writeFile(modelPath, 'x')
    await fs.writeFile(path.join(dir, 'model1.preview.png'), 'x')
    await fs.writeFile(path.join(dir, 'model1.png'), 'x')
    const found = await findSidecarPreview(modelPath)
    expect(found).toBe(path.join(dir, 'model1.png'))
  })

  it('无同名图片时返回空字符串', async () => {
    const modelPath = path.join(dir, 'model2.safetensors')
    await fs.writeFile(modelPath, 'x')
    expect(await findSidecarPreview(modelPath)).toBe('')
  })
})
