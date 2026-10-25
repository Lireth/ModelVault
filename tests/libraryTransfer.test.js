import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const { getSettingsMock } = vi.hoisted(() => ({ getSettingsMock: vi.fn() }))

// 跨库传输的目标库注册校验依赖 settings；本文件直接注入受控值
vi.mock('../src/main/services/store-settings', () => ({
  getSettings: getSettingsMock,
}))

import { getCurrentRoot, setDataRoot } from '../src/main/services/store-paths'
import {
  loadData,
  setModelMeta,
  getModelMeta,
} from '../src/main/services/store-meta'
import { transferModelsToLibrary } from '../src/main/services/library-transfer'

/**
 * 跨库传输测试（F-3）：临时源库 + 目标库，逐项验证——
 * - copy/move 的文件与 sidecar 传输、源清理语义；
 * - 元数据键迁移（保持相对路径）、无标注模型不写条目；
 * - 封面文件随引用复制（同名不覆盖）；
 * - 目标同名文件跳过、journal 残留拒绝、目标未注册/当前库拒绝。
 */

/** 本文件产生的临时目录（测试结束后统一清理） */
const tmpDirs = []

function mkTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

afterAll(async () => {
  for (const dir of tmpDirs) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

/** 在库根下构造模型文件（可选子目录与 sidecar），返回绝对路径 */
async function writeModel(root, relPath, content, { sidecarText = '' } = {}) {
  const abs = path.join(root, relPath)
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  await fsp.writeFile(abs, content)
  if (sidecarText) {
    const base = relPath.replace(/\.[^.]+$/, '')
    await fsp.writeFile(path.join(root, `${base}.txt`), sidecarText)
  }
  return abs
}

/** 写目标库 store.json（预置既有条目用） */
async function writeTargetStore(root, models) {
  const dataDir = path.join(root, '.modelvault')
  await fsp.mkdir(dataDir, { recursive: true })
  await fsp.writeFile(
    path.join(dataDir, 'store.json'),
    JSON.stringify({ version: 1, models }, null, 2),
  )
}

async function readTargetStore(root) {
  return JSON.parse(
    await fsp.readFile(path.join(root, '.modelvault', 'store.json'), 'utf-8'),
  )
}

describe('transferModelsToLibrary（F-3 跨库传输）', () => {
  let sourceRoot
  let targetRoot

  beforeEach(async () => {
    sourceRoot = mkTmp('modelvault-transfer-src-')
    targetRoot = mkTmp('modelvault-transfer-dst-')
    // 目标库注册为已保存库（settings mock 在文件顶部）
    getSettingsMock.mockReturnValue({
      modelsFolders: [sourceRoot, targetRoot],
    })
    await fsp.mkdir(path.join(sourceRoot, '.modelvault'), { recursive: true })
    setDataRoot(sourceRoot)
    await loadData()
  })

  it('copy：文件/sidecar/元数据/封面迁移，源完整保留', async () => {
    const coverRel = '.modelvault/covers/c1.png'
    await fsp.mkdir(path.join(sourceRoot, '.modelvault', 'covers'), {
      recursive: true,
    })
    await fsp.writeFile(path.join(sourceRoot, coverRel), 'cover-bytes')
    const abs = await writeModel(
      sourceRoot,
      'LoRA/girl.safetensors',
      'model-bytes',
      {
        sidecarText: 'trigger words',
      },
    )
    setModelMeta(abs, {
      favorite: true,
      rating: 5,
      note: 'notes',
      covers: [coverRel],
      cover: coverRel,
    })

    const res = await transferModelsToLibrary({
      ids: [abs],
      targetRoot,
      mode: 'copy',
    })
    expect(res.error).toBeUndefined()
    expect(res.transferred).toBe(1)
    expect(res.failed).toHaveLength(0)

    // 目标库：文件 + sidecar + 封面 + 元数据键（相对路径一致）
    expect(
      await fsp.readFile(
        path.join(targetRoot, 'LoRA', 'girl.safetensors'),
        'utf-8',
      ),
    ).toBe('model-bytes')
    expect(
      await fsp.readFile(path.join(targetRoot, 'LoRA', 'girl.txt'), 'utf-8'),
    ).toBe('trigger words')
    expect(await fsp.readFile(path.join(targetRoot, coverRel), 'utf-8')).toBe(
      'cover-bytes',
    )
    const store = await readTargetStore(targetRoot)
    expect(store.models['LoRA/girl.safetensors'].favorite).toBe(true)
    expect(store.models['LoRA/girl.safetensors'].covers).toEqual([coverRel])

    // 源库完整保留（copy 语义）
    expect(await fsp.readFile(abs, 'utf-8')).toBe('model-bytes')
    expect(getModelMeta(abs)?.favorite).toBe(true)
  })

  it('move：成功后清理源文件/sidecar 与源元数据', async () => {
    const abs = await writeModel(sourceRoot, 'a.safetensors', 'data', {
      sidecarText: 'txt',
    })
    setModelMeta(abs, { note: 'n1' })

    const res = await transferModelsToLibrary({
      ids: [abs],
      targetRoot,
      mode: 'move',
    })
    expect(res.transferred).toBe(1)

    // 目标齐全、源清理
    expect(
      await fsp.readFile(path.join(targetRoot, 'a.safetensors'), 'utf-8'),
    ).toBe('data')
    expect(await fsp.readFile(path.join(targetRoot, 'a.txt'), 'utf-8')).toBe(
      'txt',
    )
    await expect(fsp.access(abs)).rejects.toThrow()
    await expect(fsp.access(path.join(sourceRoot, 'a.txt'))).rejects.toThrow()
    expect(getModelMeta(abs)).toBeNull()
  })

  it('无标注模型：文件照常迁移，不创建目标元数据条目', async () => {
    const abs = await writeModel(sourceRoot, 'plain.safetensors', 'x')
    const res = await transferModelsToLibrary({
      ids: [abs],
      targetRoot,
      mode: 'copy',
    })
    expect(res.transferred).toBe(1)
    expect(
      await fsp.readFile(path.join(targetRoot, 'plain.safetensors'), 'utf-8'),
    ).toBe('x')
    // 无元数据可写：目标库 store.json 保持未创建（首次扫描时由加载链路初始化）
    await expect(
      fsp.access(path.join(targetRoot, '.modelvault', 'store.json')),
    ).rejects.toThrow()
  })

  it('目标已有条目时合并写回，不破坏目标库原有数据', async () => {
    await writeTargetStore(targetRoot, {
      'existing.safetensors': { note: 'existing-note' },
    })
    const abs = await writeModel(sourceRoot, 'new.safetensors', 'x')
    setModelMeta(abs, { note: 'new-note' })

    const res = await transferModelsToLibrary({
      ids: [abs],
      targetRoot,
      mode: 'copy',
    })
    expect(res.transferred).toBe(1)
    const store = await readTargetStore(targetRoot)
    expect(store.models['existing.safetensors'].note).toBe('existing-note')
    expect(store.models['new.safetensors'].note).toBe('new-note')
  })

  it('目标已存在同名文件：跳过不覆盖（copy 与 move 均不动源）', async () => {
    const abs = await writeModel(sourceRoot, 'dup.safetensors', 'src')
    await writeModel(targetRoot, 'dup.safetensors', 'dst')
    setModelMeta(abs, { note: 'n' })

    const res = await transferModelsToLibrary({
      ids: [abs],
      targetRoot,
      mode: 'move',
    })
    expect(res.transferred).toBe(0)
    expect(res.skipped).toEqual([{ id: abs, reason: '目标库已存在同名文件' }])
    // 源不动（move 也不删）
    expect(await fsp.readFile(abs, 'utf-8')).toBe('src')
    expect(getModelMeta(abs)?.note).toBe('n')
  })

  it('源路径为库内 junction 指向库外时拒绝传输（O6 realpath 归属）', async (ctx) => {
    const outside = mkTmp('modelvault-transfer-out-')
    const outsideFile = await writeModel(
      outside,
      'secret.safetensors',
      'outside-data',
    )
    const link = path.join(sourceRoot, 'link')
    try {
      await fsp.symlink(outside, link, 'junction')
    } catch {
      ctx.skip()
    }
    const id = path.join(link, 'secret.safetensors')

    const res = await transferModelsToLibrary({
      ids: [id],
      targetRoot,
      mode: 'move',
    })

    expect(res.transferred).toBe(0)
    expect(res.failed[0].error).toContain('不在当前库内')
    await expect(fsp.access(outsideFile)).resolves.toBeUndefined()
  })

  it('目标库 journal 残留（未合并 delta）时拒绝迁移', async () => {
    const journalDir = path.join(targetRoot, '.modelvault', 'journal')
    await fsp.mkdir(journalDir, { recursive: true })
    await fsp.writeFile(path.join(journalDir, 'delta-000000000001.json'), '{}')
    const abs = await writeModel(sourceRoot, 'j.safetensors', 'x')

    const res = await transferModelsToLibrary({
      ids: [abs],
      targetRoot,
      mode: 'copy',
    })
    expect(res.error).toContain('未完成的同步')
    // 文件未被传输
    await expect(
      fsp.access(path.join(targetRoot, 'j.safetensors')),
    ).rejects.toThrow()
  })

  it('journal 目录不可读（非 ENOENT）按存在残留拒绝迁移（fail-closed）', async () => {
    // 用同名文件占位 journal 目录路径：readdir 抛 ENOTDIR，
    // 等价模拟杀毒/索引器占用导致的不可读——无法证明无残留即拒绝
    await fsp.mkdir(path.join(targetRoot, '.modelvault'), { recursive: true })
    await fsp.writeFile(path.join(targetRoot, '.modelvault', 'journal'), 'x')
    const abs = await writeModel(sourceRoot, 'jr.safetensors', 'x')

    const res = await transferModelsToLibrary({
      ids: [abs],
      targetRoot,
      mode: 'copy',
    })
    expect(res.error).toContain('未完成的同步')
    await expect(
      fsp.access(path.join(targetRoot, 'jr.safetensors')),
    ).rejects.toThrow()
  })

  it('入口校验：目标为当前库/未注册库/不存在时拒绝', async () => {
    const abs = await writeModel(sourceRoot, 'v.safetensors', 'x')
    // 当前库
    const r1 = await transferModelsToLibrary({
      ids: [abs],
      targetRoot: sourceRoot,
      mode: 'copy',
    })
    expect(r1.error).toContain('当前模型库')
    // 未注册库
    const unregistered = mkTmp('modelvault-transfer-unreg-')
    const r2 = await transferModelsToLibrary({
      ids: [abs],
      targetRoot: unregistered,
      mode: 'copy',
    })
    expect(r2.error).toContain('不是已保存的模型库')
    // 不存在
    const r3 = await transferModelsToLibrary({
      ids: [abs],
      targetRoot: path.join(targetRoot, 'ghost'),
      mode: 'copy',
    })
    expect(r3.error).toBeTruthy()
  })

  it('批量混合：正常项传输、越界项失败、目标冲突项跳过', async () => {
    const okA = await writeModel(sourceRoot, 'batch/a.safetensors', 'a')
    const dupB = await writeModel(sourceRoot, 'batch/b.safetensors', 'b')
    await writeModel(targetRoot, 'batch/b.safetensors', 'dst-b')
    setModelMeta(okA, { rating: 3 })

    const res = await transferModelsToLibrary({
      ids: [okA, dupB, path.join(sourceRoot, 'outside', 'c.safetensors')],
      targetRoot,
      mode: 'copy',
    })
    expect(res.transferred).toBe(1)
    expect(res.skipped).toHaveLength(1)
    expect(res.failed).toHaveLength(1)
    const store = await readTargetStore(targetRoot)
    expect(store.models['batch/a.safetensors'].rating).toBe(3)
    expect(store.models['batch/b.safetensors']).toBeUndefined()
  })

  it('当前根目录一致性：传输后源库当前根不变化', async () => {
    const abs = await writeModel(sourceRoot, 'keep.safetensors', 'x')
    await transferModelsToLibrary({ ids: [abs], targetRoot, mode: 'move' })
    expect(getCurrentRoot()).toBe(sourceRoot)
    expect(path.resolve(getCurrentRoot())).toBe(path.resolve(sourceRoot))
    expect(getModelMeta(abs)).toBeNull()
  })

  it('空壳标注（仅默认字段）也随条目迁移', async () => {
    // normalizeModelMeta 幂等，空壳条目在目标库可被健康检查清理
    const abs = await writeModel(sourceRoot, 'shell.safetensors', 'x')
    setModelMeta(abs, {})
    const res = await transferModelsToLibrary({
      ids: [abs],
      targetRoot,
      mode: 'copy',
    })
    expect(res.transferred).toBe(1)
    const store = await readTargetStore(targetRoot)
    expect(store.models['shell.safetensors']).toBeDefined()
  })
})
