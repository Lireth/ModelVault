import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fakeUserData } from './setup'

/**
 * models:organizeByTags 一键移动文件测试：
 * - planOrganizeMoves 纯函数：目标路径计算、非法标签/已在目标位置跳过
 * - handler 集成：7 个标签文件夹创建、文件移动、元数据键迁移、sidecar
 *   同移、同名冲突反馈；空 moves 拒绝
 */
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { handle: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  clipboard: { readImage: vi.fn() },
  net: { fetch: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
}))

import {
  isImportableModelFile,
  planImportTarget,
  planOrganizeMoves,
  planRenameTarget,
  registerFilesHandlers,
  splitModelFileName,
} from '../src/main/ipc/models/files'
import { getRegisteredHandler, makeEvent } from './helpers/modelsIpc'
import {
  getModelMeta,
  loadData,
  setDataRoot,
  setModelMeta,
} from '../src/main/services/store'
import { sidecarFilesFor } from '../src/main/services/scanner'
import { dialog } from 'electron'

/** 本文件创建的全部临时目录（afterAll 只清理这些，不动系统临时目录） */
const roots = []

describe('planOrganizeMoves', () => {
  const root = path.join(os.tmpdir(), 'plan-root')

  it('按标签 label 生成「根目录/LoRA/标签文件夹/原文件名」目标路径', () => {
    const { planned, skipped } = planOrganizeMoves(
      [{ id: path.join(root, 'lora', 'a.safetensors'), subCategory: 'role' }],
      root,
    )
    expect(planned).toEqual([
      {
        id: path.join(root, 'lora', 'a.safetensors'),
        newPath: path.join(root, 'LoRA', '角色', 'a.safetensors'),
      },
    ])
    expect(skipped).toEqual([])
  })

  it('未标注模型（subCategory 为空）目标为 LoRA 根目录', () => {
    const { planned, skipped } = planOrganizeMoves(
      [{ id: path.join(root, 'misc', 'c.safetensors'), subCategory: '' }],
      root,
    )
    expect(planned).toEqual([
      {
        id: path.join(root, 'misc', 'c.safetensors'),
        newPath: path.join(root, 'LoRA', 'c.safetensors'),
      },
    ])
    expect(skipped).toEqual([])
  })

  it('非法标签与已在目标位置的模型分别跳过', () => {
    const inPlace = path.join(root, 'LoRA', '角色', 'b.safetensors')
    const { planned, skipped } = planOrganizeMoves(
      [
        { id: path.join(root, 'x.safetensors'), subCategory: 'embedding' },
        { id: inPlace, subCategory: 'role' },
        { id: path.join(root, 'y.safetensors'), subCategory: 'base' },
      ],
      root,
    )
    expect(planned).toEqual([])
    expect(skipped.map((s) => s.reason)).toEqual([
      'invalid-tag',
      'same-dir',
      'invalid-tag',
    ])
  })

  it('moves 为空时返回空计划', () => {
    expect(planOrganizeMoves([], root)).toEqual({ planned: [], skipped: [] })
    expect(planOrganizeMoves(null, root)).toEqual({ planned: [], skipped: [] })
  })
})

describe('models:organizeByTags handler', () => {
  let root
  let handler

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-organize-'))
    roots.push(root)
    setDataRoot(root)
    await loadData()
    registerFilesHandlers()
    handler = getRegisteredHandler('models:organizeByTags')
  })

  afterAll(async () => {
    for (const dir of roots) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  /** 在 root 下创建一个模型文件与元数据，返回其绝对路径 */
  async function makeModel(rel, subCategory) {
    const abs = path.join(root, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, 'model-data')
    if (subCategory) await setModelMeta(abs, { subCategory, note: '标注' })
    return abs
  }

  it('创建 LoRA 及 7 个标签子文件夹并把已标注模型移入对应子文件夹，元数据键随迁', async () => {
    const id = await makeModel(path.join('lora', 'a.safetensors'), 'role')

    const res = await handler(makeEvent(), {
      moves: [{ id, subCategory: 'role' }],
    })
    expect(res.error).toBeUndefined()
    expect(res.moved).toBe(1)
    expect(res.failed).toEqual([])
    expect(res.skipped).toEqual([])

    // LoRA 目录及其下 7 个标签子文件夹全部创建
    for (const folder of [
      '角色',
      '风格',
      '概念',
      '服饰',
      '背景',
      '姿势',
      '工具',
    ]) {
      const stat = await fs.stat(path.join(root, 'LoRA', folder))
      expect(stat.isDirectory()).toBe(true)
    }
    // 文件已移动，原位置不存在
    const newPath = path.join(root, 'LoRA', '角色', 'a.safetensors')
    await expect(fs.readFile(newPath, 'utf-8')).resolves.toBe('model-data')
    await expect(fs.access(id)).rejects.toThrow()
    // 元数据键迁移：标注与封面等用户数据完整保留
    expect(getModelMeta(newPath)).toMatchObject({
      subCategory: 'role',
      note: '标注',
    })
    expect(getModelMeta(id)).toBeNull()
  })

  it('未标注模型移入 LoRA 根目录', async () => {
    const id = await makeModel(path.join('misc', 'e.safetensors'), '')
    const res = await handler(makeEvent(), { moves: [{ id, subCategory: '' }] })
    expect(res.error).toBeUndefined()
    expect(res.moved).toBe(1)
    const newPath = path.join(root, 'LoRA', 'e.safetensors')
    await expect(fs.access(newPath)).resolves.toBeUndefined()
    await expect(fs.access(id)).rejects.toThrow()
  })

  it('同名 sidecar 一并移动', async () => {
    const id = await makeModel('b.safetensors', 'style')
    await fs.writeFile(path.join(root, 'b.txt'), '说明文本')
    await fs.writeFile(path.join(root, 'b.preview.png'), 'png')

    const res = await handler(makeEvent(), {
      moves: [{ id, subCategory: 'style' }],
    })
    expect(res.moved).toBe(1)
    const newPath = path.join(root, 'LoRA', '风格', 'b.safetensors')
    await expect(
      fs.readFile(path.join(root, 'LoRA', '风格', 'b.txt'), 'utf-8'),
    ).resolves.toBe('说明文本')
    await expect(
      fs.readFile(path.join(root, 'LoRA', '风格', 'b.preview.png'), 'utf-8'),
    ).resolves.toBe('png')
    await expect(fs.access(newPath)).resolves.toBeUndefined()
  })

  it('目标位置同名冲突计入 failed，其余模型不受影响', async () => {
    const a = await makeModel('a.safetensors', 'concept')
    const b = await makeModel(path.join('sub', 'c.safetensors'), 'concept')
    // 预占目标位置（与 a 同名）
    await fs.mkdir(path.join(root, 'LoRA', '概念'), { recursive: true })
    await fs.writeFile(
      path.join(root, 'LoRA', '概念', 'a.safetensors'),
      'occupied',
    )

    const res = await handler(makeEvent(), {
      moves: [
        { id: a, subCategory: 'concept' },
        { id: b, subCategory: 'concept' },
      ],
    })
    expect(res.error).toBeUndefined()
    expect(res.moved).toBe(1)
    expect(res.failed).toEqual([{ id: a, error: '目标位置已存在同名文件' }])
    await expect(fs.access(a)).resolves.toBeUndefined()
    await expect(
      fs.access(path.join(root, 'LoRA', '概念', 'c.safetensors')),
    ).resolves.toBeUndefined()
  })

  it('已在目标位置的模型跳过', async () => {
    const id = await makeModel(
      path.join('LoRA', '背景', 'd.safetensors'),
      'background',
    )
    const res = await handler(makeEvent(), {
      moves: [{ id, subCategory: 'background' }],
    })
    expect(res.moved).toBe(0)
    expect(res.skipped).toEqual([{ id, reason: 'same-dir' }])
    await expect(fs.access(id)).resolves.toBeUndefined()
  })

  it('空 moves 拒绝执行', async () => {
    expect(await handler(makeEvent(), {})).toEqual({
      error: '没有需要移动的模型',
    })
    expect(await handler(makeEvent(), { moves: [] })).toEqual({
      error: '没有需要移动的模型',
    })
  })
})

describe('F2 模型导入（复制/移动入台）', () => {
  let root
  let srcDir
  let handler

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-import-root-'))
    srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-import-src-'))
    roots.push(root, srcDir)
    setDataRoot(root)
    await loadData()
    registerFilesHandlers()
    handler = getRegisteredHandler('models:importModels')
    vi.mocked(dialog.showOpenDialog).mockReset()
  })

  async function makeSource(name = 'a.safetensors', content = 'model-data') {
    const file = path.join(srcDir, name)
    await fs.writeFile(file, content)
    return file
  }

  function mockDialogs(files, targetDir) {
    vi.mocked(dialog.showOpenDialog)
      .mockResolvedValueOnce({ canceled: false, filePaths: files })
      .mockResolvedValueOnce({ canceled: false, filePaths: [targetDir] })
  }

  it('复制导入：模型与 .txt/.civitai.info/预览图 sidecar 一并复制，源文件保留', async () => {
    const source = await makeSource()
    await fs.writeFile(path.join(srcDir, 'a.txt'), 'note')
    await fs.writeFile(
      path.join(srcDir, 'a.civitai.info'),
      '{"trainedWords":["x"]}',
    )
    await fs.writeFile(path.join(srcDir, 'a.preview.png'), 'png')
    const target = path.join(root, 'lora')
    await fs.mkdir(target, { recursive: true })
    mockDialogs([source], target)

    const res = await handler(makeEvent(), { mode: 'copy' })

    expect(res.error).toBeUndefined()
    expect(res.imported).toBe(1)
    expect(res.targetRelDir).toBe('lora')
    await expect(
      fs.readFile(path.join(target, 'a.safetensors'), 'utf-8'),
    ).resolves.toBe('model-data')
    await expect(
      fs.readFile(path.join(target, 'a.txt'), 'utf-8'),
    ).resolves.toBe('note')
    await expect(
      fs.readFile(path.join(target, 'a.civitai.info'), 'utf-8'),
    ).resolves.toContain('trainedWords')
    await expect(
      fs.readFile(path.join(target, 'a.preview.png'), 'utf-8'),
    ).resolves.toBe('png')
    await expect(fs.access(source)).resolves.toBeUndefined()
  })

  it('移动导入：源模型与 sidecar 移走，源位置不存在', async () => {
    const source = await makeSource('b.safetensors')
    await fs.writeFile(path.join(srcDir, 'b.txt'), 'note')
    const target = path.join(root, 'checkpoints')
    await fs.mkdir(target, { recursive: true })
    mockDialogs([source], target)

    const res = await handler(makeEvent(), { mode: 'move' })

    expect(res.imported).toBe(1)
    await expect(fs.access(source)).rejects.toThrow()
    await expect(fs.access(path.join(srcDir, 'b.txt'))).rejects.toThrow()
    await expect(
      fs.access(path.join(target, 'b.safetensors')),
    ).resolves.toBeUndefined()
    await expect(fs.access(path.join(target, 'b.txt'))).resolves.toBeUndefined()
  })

  it('同名冲突自动追加编号，不覆盖库内已有文件', async () => {
    const source = await makeSource()
    const target = path.join(root, 'lora')
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, 'a.safetensors'), 'existing')
    mockDialogs([source], target)

    const res = await handler(makeEvent(), { mode: 'copy' })

    expect(res.imported).toBe(1)
    expect(res.renamed).toBe(1)
    await expect(
      fs.readFile(path.join(target, 'a.safetensors'), 'utf-8'),
    ).resolves.toBe('existing')
    await expect(
      fs.readFile(path.join(target, 'a (1).safetensors'), 'utf-8'),
    ).resolves.toBe('model-data')
  })

  it('源文件已在库内 / 扩展名不支持 / 目标目录越界时拒绝', async () => {
    const inside = path.join(root, 'inside.safetensors')
    await fs.writeFile(inside, 'x')
    const target = path.join(root, 'lora')
    await fs.mkdir(target, { recursive: true })
    mockDialogs([inside], target)
    const insideRes = await handler(makeEvent(), { mode: 'copy' })
    expect(insideRes.failed[0].error).toContain('已在当前模型库内')

    const bad = path.join(srcDir, 'bad.txt')
    await fs.writeFile(bad, 'x')
    mockDialogs([bad], target)
    const badRes = await handler(makeEvent(), { mode: 'copy' })
    expect(badRes.failed[0].error).toContain('不支持')

    const outsideTarget = await fs.mkdtemp(
      path.join(os.tmpdir(), 'modelvault-import-out-'),
    )
    roots.push(outsideTarget)
    const good = await makeSource('c.safetensors')
    mockDialogs([good], outsideTarget)
    const outRes = await handler(makeEvent(), { mode: 'copy' })
    expect(outRes.error).toBe('目标文件夹不在当前模型库内')

    const storeTarget = path.join(root, '.modelvault')
    await fs.mkdir(storeTarget, { recursive: true })
    mockDialogs([good], storeTarget)
    const storeRes = await handler(makeEvent(), { mode: 'copy' })
    expect(storeRes.error).toBe('不能导入到关联存储目录')
  })

  it('纯函数：.disabled 拆分、扩展名白名单与重名规划', async () => {
    expect(splitModelFileName('a.safetensors.disabled')).toEqual({
      base: 'a',
      ext: '.safetensors',
      disabled: true,
    })
    expect(isImportableModelFile('a.safetensors')).toBe(true)
    expect(isImportableModelFile('a.safetensors.disabled')).toBe(true)
    expect(isImportableModelFile('a.txt')).toBe(false)

    const dir = path.join(root, 'plan')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'm.safetensors'), 'x')
    const plan = await planImportTarget(dir, 'm.safetensors')
    expect(plan.fileName).toBe('m (1).safetensors')
  })

  it('禁用模型导入的 sidecar 命名与 scanner 侧查找集合一致（.disabled 基名回归）', async () => {
    const dir = path.join(root, 'sidecar-agree')
    await fs.mkdir(dir, { recursive: true })
    const plan = await planImportTarget(dir, 'hero.safetensors.disabled')
    expect(plan.base).toBe('hero')
    // 导入链路搬运的 sidecar 目标名（`${plan.base}${suffix}` = hero.txt）必须
    // 落在扫描/展示/清理侧 sidecarFilesFor 的候选集合内——修复前 scanner 侧
    // 基名为 hero.safetensors，导入的 hero.txt 既不展示也清不掉
    const scannerSidecars = sidecarFilesFor(path.join(dir, plan.fileName))
    for (const suffix of ['.txt', '.civitai.info', '.png', '.preview.png']) {
      expect(scannerSidecars).toContain(path.join(dir, `${plan.base}${suffix}`))
    }
  })

  it('取消任一对话框返回 canceled 且不写文件', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: true,
      filePaths: [],
    })
    expect(await handler(makeEvent(), { mode: 'copy' })).toEqual({
      canceled: true,
    })
    expect(await handler(makeEvent(), { mode: 'bad' })).toEqual({
      error: '无效的导入方式',
    })
  })
})

describe('planRenameTarget（N1 重命名目标计算）', () => {
  const dir = path.join('D:', 'models', 'lora')

  it('同目录改名并保留扩展名', () => {
    expect(planRenameTarget(path.join(dir, 'a.safetensors'), 'b')).toEqual({
      path: path.join(dir, 'b.safetensors'),
    })
  })

  it('粘贴完整文件名时剥离原扩展名，避免双重扩展名', () => {
    expect(
      planRenameTarget(path.join(dir, 'a.safetensors'), ' b.SAFETENSORS '),
    ).toEqual({
      path: path.join(dir, 'b.safetensors'),
    })
  })

  it('名称未变化返回原路径', () => {
    expect(planRenameTarget(path.join(dir, 'a.safetensors'), 'a')).toEqual({
      path: path.join(dir, 'a.safetensors'),
    })
  })

  it('空名/非法字符/超长/禁用模型拒绝', () => {
    const id = path.join(dir, 'a.safetensors')
    expect(planRenameTarget(id, '   ').error).toContain('不能为空')
    expect(planRenameTarget(id, 'bad/name').error).toContain('非法字符')
    expect(planRenameTarget(id, 'x'.repeat(121)).error).toContain('过长')
    expect(
      planRenameTarget(path.join(dir, 'x.safetensors.disabled'), 'y').error,
    ).toContain('先启用')
  })
})

describe('models:renameModel handler（N1）', () => {
  let root
  let handler

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-rename-'))
    roots.push(root)
    setDataRoot(root)
    await loadData()
    registerFilesHandlers()
    handler = getRegisteredHandler('models:renameModel')
  })

  afterAll(async () => {
    for (const dir of roots) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  async function makeModel(rel = path.join('lora', 'a.safetensors')) {
    const abs = path.join(root, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, 'model-data')
    await setModelMeta(abs, { note: '标注', rating: 5 })
    return abs
  }

  it('成功：主文件与 sidecar 改名，元数据键迁移', async () => {
    const id = await makeModel()
    await fs.writeFile(path.join(root, 'lora', 'a.txt'), '说明文本')
    await fs.writeFile(path.join(root, 'lora', 'a.preview.png'), '预览图')

    const res = await handler(makeEvent(), { id, name: 'b' })

    const newPath = path.join(root, 'lora', 'b.safetensors')
    expect(res).toMatchObject({
      path: newPath,
      renamedSidecars: 2,
      sidecarWarnings: [],
    })
    await expect(fs.access(id)).rejects.toThrow()
    await expect(fs.readFile(newPath, 'utf8')).resolves.toBe('model-data')
    await expect(
      fs.readFile(path.join(root, 'lora', 'b.txt'), 'utf8'),
    ).resolves.toBe('说明文本')
    await expect(
      fs.readFile(path.join(root, 'lora', 'b.preview.png'), 'utf8'),
    ).resolves.toBe('预览图')
    // 标注随相对键迁移
    expect(getModelMeta(newPath)?.note).toBe('标注')
    expect(getModelMeta(id)).toBeNull()
  })

  it('目标文件名已存在时拒绝，源文件保持不变', async () => {
    const id = await makeModel()
    await fs.writeFile(path.join(root, 'lora', 'b.safetensors'), 'other')

    const res = await handler(makeEvent(), { id, name: 'b' })

    expect(res.error).toBe('目标文件名已存在')
    await expect(fs.readFile(id, 'utf8')).resolves.toBe('model-data')
    await expect(
      fs.readFile(path.join(root, 'lora', 'b.safetensors'), 'utf8'),
    ).resolves.toBe('other')
  })

  it('sidecar 目标已存在时跳过且不覆盖，主文件改名成功并返回警告', async () => {
    const id = await makeModel()
    await fs.writeFile(path.join(root, 'lora', 'a.txt'), '旧说明')
    await fs.writeFile(path.join(root, 'lora', 'b.txt'), '已存在的说明')

    const res = await handler(makeEvent(), { id, name: 'b' })

    expect(res.path).toBe(path.join(root, 'lora', 'b.safetensors'))
    expect(res.sidecarWarnings.length).toBeGreaterThan(0)
    // 已有目标 sidecar 内容不被覆盖，源 sidecar 保留
    await expect(
      fs.readFile(path.join(root, 'lora', 'b.txt'), 'utf8'),
    ).resolves.toBe('已存在的说明')
    await expect(
      fs.readFile(path.join(root, 'lora', 'a.txt'), 'utf8'),
    ).resolves.toBe('旧说明')
  })

  it('空名/非法字符/禁用模型/库外路径拒绝', async () => {
    const id = await makeModel()
    expect((await handler(makeEvent(), { id, name: '   ' })).error).toContain(
      '不能为空',
    )
    expect(
      (await handler(makeEvent(), { id, name: 'bad/name' })).error,
    ).toContain('非法字符')

    const disabled = path.join(root, 'lora', 'd.safetensors.disabled')
    await fs.writeFile(disabled, 'model-data')
    expect(
      (await handler(makeEvent(), { id: disabled, name: 'e' })).error,
    ).toContain('先启用')

    const outside = path.join(
      os.tmpdir(),
      'modelvault-rename-outside.safetensors',
    )
    expect(
      (await handler(makeEvent(), { id: outside, name: 'x' })).error,
    ).toContain('不在当前根目录')
  })
})

describe('破坏性文件操作的 realpath 归属（O6）', () => {
  let root

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-realpath-'))
    roots.push(root)
    setDataRoot(root)
    await loadData()
    registerFilesHandlers()
  })

  afterAll(async () => {
    for (const dir of roots) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  /** 在库内创建指向库外的 junction，返回 { outsideDir, link, outsideFile } */
  async function makeOutsideLink(ctx, fileName = 'secret.safetensors') {
    const outsideDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'modelvault-outside-'),
    )
    roots.push(outsideDir)
    const outsideFile = path.join(outsideDir, fileName)
    await fs.writeFile(outsideFile, 'outside-data')
    const link = path.join(root, 'link')
    try {
      await fs.symlink(outsideDir, link, 'junction')
    } catch {
      ctx.skip()
    }
    return { outsideDir, link, outsideFile }
  }

  it('禁用改名：库内 junction 指向库外时拒绝且不改动外部文件', async (ctx) => {
    const { link, outsideFile } = await makeOutsideLink(ctx)
    const id = path.join(link, 'secret.safetensors')

    const res = await getRegisteredHandler('models:toggleDisabled')(
      makeEvent(),
      {
        id,
        disabled: true,
      },
    )

    expect(res.error).toBe('模型不在当前根目录内')
    await expect(fs.readFile(outsideFile, 'utf8')).resolves.toBe('outside-data')
    await expect(fs.access(`${outsideFile}.disabled`)).rejects.toThrow()
  })

  it('重命名：库内 junction 指向库外时拒绝且不改动外部文件', async (ctx) => {
    const { link, outsideFile } = await makeOutsideLink(ctx)
    const id = path.join(link, 'secret.safetensors')

    const res = await getRegisteredHandler('models:renameModel')(makeEvent(), {
      id,
      name: 'renamed',
    })

    expect(res.error).toBe('模型不在当前根目录内')
    await expect(fs.readFile(outsideFile, 'utf8')).resolves.toBe('outside-data')
    await expect(
      fs.access(path.join(path.dirname(outsideFile), 'renamed.safetensors')),
    ).rejects.toThrow()
  })

  it('库内移动：目标目录为指向库外的 junction 时拒绝', async (ctx) => {
    const source = path.join(root, 'm.safetensors')
    await fs.writeFile(source, 'model-data')
    const { link } = await makeOutsideLink(ctx)
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: [link],
    })

    const res = await getRegisteredHandler('models:moveModelTo')(makeEvent(), {
      id: source,
    })

    expect(res.error).toBe('目标文件夹真实路径不在当前模型库内')
    await expect(fs.readFile(source, 'utf8')).resolves.toBe('model-data')
  })

  it('一键整理：源模型通过库内 junction 指向库外时跳过', async (ctx) => {
    const { link, outsideFile } = await makeOutsideLink(ctx)
    const id = path.join(link, 'secret.safetensors')

    const res = await getRegisteredHandler('models:organizeByTags')(
      makeEvent(),
      {
        moves: [{ id, subCategory: 'role' }],
      },
    )

    expect(res.moved).toBe(0)
    expect(res.skipped).toContainEqual({ id, reason: 'out-of-root' })
    await expect(fs.readFile(outsideFile, 'utf8')).resolves.toBe('outside-data')
  })
})
