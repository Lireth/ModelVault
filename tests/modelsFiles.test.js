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
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() }
}))

import { planOrganizeMoves, registerFilesHandlers } from '../src/main/ipc/models/files'
import { getRegisteredHandler, makeEvent } from './helpers/modelsIpc'
import { getModelMeta, loadData, setDataRoot, setModelMeta } from '../src/main/services/store'

/** 本文件创建的全部临时目录（afterAll 只清理这些，不动系统临时目录） */
const roots = []

describe('planOrganizeMoves', () => {
  const root = path.join(os.tmpdir(), 'plan-root')

  it('按标签 label 生成「根目录/LoRA/标签文件夹/原文件名」目标路径', () => {
    const { planned, skipped } = planOrganizeMoves(
      [{ id: path.join(root, 'lora', 'a.safetensors'), subCategory: 'role' }],
      root
    )
    expect(planned).toEqual([{ id: path.join(root, 'lora', 'a.safetensors'), newPath: path.join(root, 'LoRA', '角色', 'a.safetensors') }])
    expect(skipped).toEqual([])
  })

  it('未标注模型（subCategory 为空）目标为 LoRA 根目录', () => {
    const { planned, skipped } = planOrganizeMoves(
      [{ id: path.join(root, 'misc', 'c.safetensors'), subCategory: '' }],
      root
    )
    expect(planned).toEqual([{ id: path.join(root, 'misc', 'c.safetensors'), newPath: path.join(root, 'LoRA', 'c.safetensors') }])
    expect(skipped).toEqual([])
  })

  it('非法标签与已在目标位置的模型分别跳过', () => {
    const inPlace = path.join(root, 'LoRA', '角色', 'b.safetensors')
    const { planned, skipped } = planOrganizeMoves(
      [
        { id: path.join(root, 'x.safetensors'), subCategory: 'embedding' },
        { id: inPlace, subCategory: 'role' },
        { id: path.join(root, 'y.safetensors'), subCategory: 'base' }
      ],
      root
    )
    expect(planned).toEqual([])
    expect(skipped.map((s) => s.reason)).toEqual(['invalid-tag', 'same-dir', 'invalid-tag'])
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

    const res = await handler(makeEvent(), { moves: [{ id, subCategory: 'role' }] })
    expect(res.error).toBeUndefined()
    expect(res.moved).toBe(1)
    expect(res.failed).toEqual([])
    expect(res.skipped).toEqual([])

    // LoRA 目录及其下 7 个标签子文件夹全部创建
    for (const folder of ['角色', '风格', '概念', '服饰', '背景', '姿势', '工具']) {
      const stat = await fs.stat(path.join(root, 'LoRA', folder))
      expect(stat.isDirectory()).toBe(true)
    }
    // 文件已移动，原位置不存在
    const newPath = path.join(root, 'LoRA', '角色', 'a.safetensors')
    await expect(fs.readFile(newPath, 'utf-8')).resolves.toBe('model-data')
    await expect(fs.access(id)).rejects.toThrow()
    // 元数据键迁移：标注与封面等用户数据完整保留
    expect(getModelMeta(newPath)).toMatchObject({ subCategory: 'role', note: '标注' })
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

    const res = await handler(makeEvent(), { moves: [{ id, subCategory: 'style' }] })
    expect(res.moved).toBe(1)
    const newPath = path.join(root, 'LoRA', '风格', 'b.safetensors')
    await expect(fs.readFile(path.join(root, 'LoRA', '风格', 'b.txt'), 'utf-8')).resolves.toBe('说明文本')
    await expect(fs.readFile(path.join(root, 'LoRA', '风格', 'b.preview.png'), 'utf-8')).resolves.toBe('png')
    await expect(fs.access(newPath)).resolves.toBeUndefined()
  })

  it('目标位置同名冲突计入 failed，其余模型不受影响', async () => {
    const a = await makeModel('a.safetensors', 'concept')
    const b = await makeModel(path.join('sub', 'c.safetensors'), 'concept')
    // 预占目标位置（与 a 同名）
    await fs.mkdir(path.join(root, 'LoRA', '概念'), { recursive: true })
    await fs.writeFile(path.join(root, 'LoRA', '概念', 'a.safetensors'), 'occupied')

    const res = await handler(makeEvent(), {
      moves: [
        { id: a, subCategory: 'concept' },
        { id: b, subCategory: 'concept' }
      ]
    })
    expect(res.error).toBeUndefined()
    expect(res.moved).toBe(1)
    expect(res.failed).toEqual([{ id: a, error: '目标位置已存在同名文件' }])
    await expect(fs.access(a)).resolves.toBeUndefined()
    await expect(fs.access(path.join(root, 'LoRA', '概念', 'c.safetensors'))).resolves.toBeUndefined()
  })

  it('已在目标位置的模型跳过', async () => {
    const id = await makeModel(path.join('LoRA', '背景', 'd.safetensors'), 'background')
    const res = await handler(makeEvent(), { moves: [{ id, subCategory: 'background' }] })
    expect(res.moved).toBe(0)
    expect(res.skipped).toEqual([{ id, reason: 'same-dir' }])
    await expect(fs.access(id)).resolves.toBeUndefined()
  })

  it('空 moves 拒绝执行', async () => {
    expect(await handler(makeEvent(), {})).toEqual({ error: '没有需要移动的模型' })
    expect(await handler(makeEvent(), { moves: [] })).toEqual({ error: '没有需要移动的模型' })
  })
})
