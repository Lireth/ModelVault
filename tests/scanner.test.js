import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  civitaiImportPatch,
  classifyModel,
  classifySubCategory,
  findSidecarCivitaiInfo,
  findSidecarPreview,
  findSidecarText,
  scanModels,
  sidecarImportPatch
} from '../src/main/services/scanner'

/**
 * scanner.js 单元测试：
 * - classifyModel 分类规则（文件夹优先 + 文件名关键词兜底 + 优先级顺序）
 * - classifySubCategory 自动分类标签（文件夹名匹配 7 个标签）
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
})

describe('classifySubCategory 自动分类标签', () => {
  it('中文文件夹名命中对应标签', () => {
    expect(classifySubCategory(['loras', '角色'])).toBe('role')
    expect(classifySubCategory(['风格'])).toBe('style')
    expect(classifySubCategory(['models', '概念'])).toBe('concept')
    expect(classifySubCategory(['服饰'])).toBe('outfit')
    expect(classifySubCategory(['背景'])).toBe('background')
    expect(classifySubCategory(['姿势'])).toBe('pose')
    expect(classifySubCategory(['工具'])).toBe('tool')
  })

  it('英文文件夹名（忽略大小写）命中对应标签', () => {
    expect(classifySubCategory(['lora', 'Role'])).toBe('role')
    expect(classifySubCategory(['STYLE'])).toBe('style')
    expect(classifySubCategory(['Background'])).toBe('background')
  })

  it('从直接父文件夹向根方向逐级匹配，取最近的命中段', () => {
    // 直接父命中优先
    expect(classifySubCategory(['角色', '风格'])).toBe('style')
    // 直接父未命中时向根方向回溯
    expect(classifySubCategory(['角色', 'lora', 'sub'])).toBe('role')
  })

  it('未命中返回空串（不分配标签）', () => {
    expect(classifySubCategory([])).toBe('')
    expect(classifySubCategory(['lora'])).toBe('')
    expect(classifySubCategory(['downloads', 'misc'])).toBe('')
  })

  it('文件夹名两侧空白容忍（trim 后匹配）', () => {
    expect(classifySubCategory([' 角色 '])).toBe('role')
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

  it('.disabled 后缀文件放行：保留真实扩展名与 disabled 标记，名称剥离双重后缀（F10）', async () => {
    await fs.writeFile(path.join(root, 'off-lora.safetensors.disabled'), 'x')
    await fs.writeFile(path.join(root, 'lora', 'off-lora.safetensors.disabled'), 'x')
    // 非模型主扩展名的 .disabled 不放行
    await fs.writeFile(path.join(root, 'junk.txt.disabled'), 'x')
    try {
      const { models } = await scanModels(root, undefined, {})
      const disabled = models.filter((m) => m.disabled)
      expect(disabled).toHaveLength(2)
      const rootOne = disabled.find((m) => path.dirname(m.id) === root)
      expect(rootOne.name).toBe('off-lora')
      expect(rootOne.ext).toBe('.safetensors')
      // lora 目录下的禁用文件：文件夹分类照常生效（真实扩展名参与分类链）
      const loraOne = disabled.find((m) => path.dirname(m.id) === path.join(root, 'lora'))
      expect(loraOne.type).toBe('lora')
      // 无 disabled 字段的常规模型不受影响
      const normal = models.find((m) => m.id === path.join(root, 'a.safetensors'))
      expect(normal.disabled).toBe(false)
      expect(models.some((m) => m.id.endsWith('junk.txt.disabled'))).toBe(false)
    } finally {
      await fs.rm(path.join(root, 'off-lora.safetensors.disabled'), { force: true })
      await fs.rm(path.join(root, 'lora', 'off-lora.safetensors.disabled'), { force: true })
      await fs.rm(path.join(root, 'junk.txt.disabled'), { force: true })
    }
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

  it('子树重复/重叠时按 id 去重，扫描结果不含重复模型（B-01 防御）', async () => {
    await fs.mkdir(path.join(root, 'lora', 'sub'), { recursive: true })
    await fs.writeFile(path.join(root, 'lora', 'sub', 'nested.safetensors'), 'x')
    try {
      // 入参层已剔除后代；此处直接传入重叠集合，验证 scanner 自身兜底
      const { models } = await scanModels(root, undefined, {
        subDirs: ['lora', 'lora', 'lora/sub']
      })
      const nestedId = path.join(root, 'lora', 'sub', 'nested.safetensors')
      expect(models.filter((m) => m.id === nestedId)).toHaveLength(1)
      expect(new Set(models.map((m) => m.id)).size).toBe(models.length)
    } finally {
      await fs.rm(path.join(root, 'lora', 'sub'), { recursive: true, force: true })
    }
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

  describe('subDirs 子树局部扫描（A-03）', () => {
    it('只扫描指定子树：兄弟目录与根目录直属文件均不出现在结果中', async () => {
      const { models, errors } = await scanModels(root, undefined, { subDirs: ['lora'] })
      expect(errors).toHaveLength(0)
      const ids = models.map((m) => m.id)
      expect(ids).toContain(path.join(root, 'lora', 'b.ckpt'))
      expect(ids).not.toContain(path.join(root, 'a.safetensors'))
    })

    it('支持多个子树', async () => {
      const { models } = await scanModels(root, undefined, { subDirs: ['lora', 'notes'] })
      // notes 内只有 txt（扩展名过滤），仅 lora/b.ckpt 命中
      expect(models.map((m) => m.id)).toEqual([path.join(root, 'lora', 'b.ckpt')])
    })

    it('空子树列表等价于不限制（全量扫描，向后兼容）', async () => {
      const a = await scanModels(root, undefined, { subDirs: [] })
      const b = await scanModels(root, undefined, {})
      expect(a.models.length).toBe(b.models.length)
      expect(a.models.length).toBeGreaterThanOrEqual(3)
    })

    it('根目录用空串表示：只扫描根直属，不递归任何子目录', async () => {
      const { models } = await scanModels(root, undefined, { subDirs: [''] })
      const ids = models.map((m) => m.id)
      expect(ids).toContain(path.join(root, 'a.safetensors'))
      expect(ids).not.toContain(path.join(root, 'lora', 'b.ckpt'))
    })

    it('不存在的子目录静默跳过（已删除目录的情况），其余子树正常', async () => {
      const { models, errors } = await scanModels(root, undefined, {
        subDirs: ['lora', 'gone-dir']
      })
      expect(errors).toHaveLength(0)
      expect(models.map((m) => m.id)).toContain(path.join(root, 'lora', 'b.ckpt'))
    })

    it('子树扫描仍受 MAX_DEPTH 约束（深于上限不遍历）', async () => {
      const deep = path.join(root, 'sub-deep')
      // MAX_DEPTH=8：在第 9 层放模型，局部扫描该子树也不应命中
      const deepDir = path.join(deep, ...Array.from({ length: 9 }, (_, i) => `d${i}`))
      await fs.mkdir(deepDir, { recursive: true })
      await fs.writeFile(path.join(deepDir, 'deep.safetensors'), 'x')
      try {
        const { models } = await scanModels(root, undefined, { subDirs: ['sub-deep'] })
        expect(models.map((m) => m.id)).not.toContain(path.join(deepDir, 'deep.safetensors'))
      } finally {
        await fs.rm(deep, { recursive: true, force: true }).catch(() => {})
      }
    })
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

  it('gif/bmp 同名图片可命中（B17：与删除清理集一致）', async () => {
    const modelPath = path.join(dir, 'model3.safetensors')
    await fs.writeFile(modelPath, 'x')
    await fs.writeFile(path.join(dir, 'model3.gif'), 'x')
    await fs.writeFile(path.join(dir, 'model3.bmp'), 'x')
    expect(await findSidecarPreview(modelPath)).toBe(path.join(dir, 'model3.gif'))

    const modelPath4 = path.join(dir, 'model4.safetensors')
    await fs.writeFile(modelPath4, 'x')
    await fs.writeFile(path.join(dir, 'model4.bmp'), 'x')
    expect(await findSidecarPreview(modelPath4)).toBe(path.join(dir, 'model4.bmp'))
  })
})

describe('findSidecarText', () => {
  let dir

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-sidetext-'))
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('读取同名 txt 并修剪首尾空白', async () => {
    const modelPath = path.join(dir, 'm1.safetensors')
    await fs.writeFile(modelPath, 'x')
    await fs.writeFile(path.join(dir, 'm1.txt'), '  hatsune miku, twintails\nsecond line\n  ')
    expect(await findSidecarText(modelPath)).toBe('hatsune miku, twintails\nsecond line')
  })

  it('空文件、不存在、超大文件返回空字符串', async () => {
    const modelPath = path.join(dir, 'm2.safetensors')
    await fs.writeFile(modelPath, 'x')
    await fs.writeFile(path.join(dir, 'm2.txt'), '')
    expect(await findSidecarText(modelPath)).toBe('')
    expect(await findSidecarText(path.join(dir, 'none.safetensors'))).toBe('')
    const bigPath = path.join(dir, 'm3.safetensors')
    await fs.writeFile(bigPath, 'x')
    await fs.writeFile(path.join(dir, 'm3.txt'), 'a'.repeat(300 * 1024))
    expect(await findSidecarText(bigPath)).toBe('')
  })
})

describe('sidecarImportPatch', () => {
  it('备注为空时导入全文并标记来源', () => {
    const patch = sidecarImportPatch('checkpoint', { note: '' }, '全文说明')
    expect(patch).toEqual({ note: '全文说明', noteSource: 'sidecar' })
  })

  it('LoRA 触发词为空时导入首行（与备注导入独立判断）', () => {
    const patch = sidecarImportPatch('lora', { note: '', triggerWords: '' }, '第一行\n第二行')
    expect(patch.note).toBe('第一行\n第二行')
    expect(patch.triggerWords).toBe('第一行')
    expect(patch.triggerWordsSource).toBe('sidecar')
  })

  it('已有备注/触发词时不覆盖；LoRA 仅触发词缺失时仍导入触发词', () => {
    expect(sidecarImportPatch('lora', { note: '已有', triggerWords: '已有' }, '文本')).toBeNull()
    const onlyTrigger = sidecarImportPatch('lora', { note: '已有', triggerWords: '' }, '第一行\n第二行')
    expect(onlyTrigger).toEqual({ triggerWords: '第一行', triggerWordsSource: 'sidecar' })
  })

  it('非 LoRA 不产生触发词补丁；空文本返回 null', () => {
    const patch = sidecarImportPatch('vae', { note: '' }, '说明')
    expect(patch.triggerWords).toBeUndefined()
    expect(sidecarImportPatch('lora', { note: '', triggerWords: '' }, '   ')).toBeNull()
    expect(sidecarImportPatch('lora', { note: '' }, '')).toBeNull()
  })
})

describe('civitaiImportPatch / findSidecarCivitaiInfo（F8）', () => {
  it('trainedWords 导入为逗号连接文本并标记来源；已有触发词不覆盖', () => {
    const patch = civitaiImportPatch(
      { triggerWords: '', nsfw: false },
      { trainedWords: ['trigger-a', ' trigger-b ', ''] }
    )
    expect(patch).toEqual({ triggerWords: 'trigger-a, trigger-b', triggerWordsSource: 'civitai' })
    // 已有触发词：跳过（哪怕 civitai 有候选）
    expect(civitaiImportPatch({ triggerWords: '已有', nsfw: false }, { trainedWords: ['x'] })).toBeNull()
  })

  it('nsfw 仅在来源明确为 true 且当前未标记时导入，单向不可逆', () => {
    const patch = civitaiImportPatch({ triggerWords: 'x', nsfw: false }, { nsfw: true })
    expect(patch).toEqual({ nsfw: true })
    // 已标记：不重复；来源非 true：不导入（civitai.info 缺失该字段时不得清标记）
    expect(civitaiImportPatch({ triggerWords: 'x', nsfw: true }, { nsfw: true })).toBeNull()
    expect(civitaiImportPatch({ triggerWords: 'x', nsfw: false }, { nsfw: false })).toBeNull()
    expect(civitaiImportPatch({ triggerWords: 'x', nsfw: false }, {})).toBeNull()
  })

  it('真实文件读取：合法 JSON 解析、损坏/超大/缺失返回 null', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-civitai-'))
    try {
      const model = path.join(dir, 'my-lora.safetensors')
      await fs.writeFile(model, 'x')
      // 合法
      await fs.writeFile(
        path.join(dir, 'my-lora.civitai.info'),
        JSON.stringify({ name: 'My LoRA', nsfw: true, trainedWords: ['a', 'b'], baseModel: 'SDXL 1.0' })
      )
      const info = await findSidecarCivitaiInfo(model)
      expect(info.name).toBe('My LoRA')
      expect(info.trainedWords).toEqual(['a', 'b'])
      // 损坏 JSON
      await fs.writeFile(path.join(dir, 'my-lora.civitai.info'), '{broken json')
      expect(await findSidecarCivitaiInfo(model)).toBeNull()
      // 无 sidecar 的模型
      const other = path.join(dir, 'other.safetensors')
      await fs.writeFile(other, 'x')
      expect(await findSidecarCivitaiInfo(other)).toBeNull()
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
