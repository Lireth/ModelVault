import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fakeUserData } from './setup'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  BrowserWindow: Object.assign(vi.fn(), {
    fromWebContents: vi.fn(),
    getAllWindows: vi.fn(() => []),
  }),
}))

import { transferModelsToLibrary } from '../src/main/services/library-transfer'
import {
  flushSettingsSave,
  loadData,
  loadSettings,
  setDataRoot,
  updateSettings,
} from '../src/main/services/store'
import {
  flushStoreSave,
  getModelMeta,
  setModelMeta,
} from '../src/main/services/store-meta'

/**
 * 跨库移动/复制服务测试（F-3，O-1 覆盖盲区回补）：
 * library-transfer.js 是数据完整性关键路径（先写后传、fail-closed、回滚），
 * 此前仅 1.1% 覆盖。用例覆盖：
 * - 入参校验与前置守卫全链（无当前库/空 ids/无效目标/同库/未保存库/目录缺失/
 *   未合并 journal 拒绝）
 * - copy：文件 + sidecar + 封面 + 元数据镜像迁移、目标同名跳过、源缺失/越界
 *   失败、无元数据不写目标 store.json
 * - move：源文件与源元数据清理
 * - 先写后传回滚：目标元数据写回后文件传输失败 → 目标条目回滚，源不动
 * - 取消（规划阶段 AbortSignal）与目标库元数据损坏的 fail-closed 中止
 */

const settingsFile = path.join(fakeUserData, 'settings.json')
const roots = []
let rootA
let rootB

/** 在源库创建模型文件（可选 sidecar 与元数据），返回模型绝对路径 */
async function makeSourceModel({
  relDir = '',
  name,
  sidecarTxt = false,
  meta = null,
}) {
  const dir = path.join(rootA, relDir)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await fs.writeFile(file, 'model-bytes')
  if (sidecarTxt) {
    // sidecar 命名遵循 SD WebUI 惯例：模型基名（去扩展名）+ .txt
    const base = name.replace(/\.[^.]+$/, '')
    await fs.writeFile(path.join(dir, `${base}.txt`), 'trigger-words')
  }
  if (meta) await setModelMeta(file, meta)
  return file
}

/** 读取目标库 store.json（不存在返回 null） */
async function readTargetStore() {
  try {
    return JSON.parse(
      await fs.readFile(path.join(rootB, '.modelvault', 'store.json'), 'utf-8'),
    )
  } catch {
    return null
  }
}

beforeEach(async () => {
  rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-tx-a-'))
  rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-tx-b-'))
  roots.push(rootA, rootB)
  setDataRoot(rootA)
  await loadSettings()
  await updateSettings({
    modelsFolder: rootA,
    modelsFolders: [rootA, rootB],
  })
  await loadData()
})

afterEach(async () => {
  // 先冲刷防抖待写再清理：迟到的落盘不得在目录删除后重建文件泄漏状态
  await flushSettingsSave().catch(() => {})
  await flushStoreSave().catch(() => {})
  await fs.rm(settingsFile, { force: true }).catch(() => {})
  for (const r of roots.splice(0)) {
    await fs.rm(r, { recursive: true, force: true }).catch(() => {})
  }
})

describe('入参校验与前置守卫', () => {
  it('未设置当前库时拒绝传输', async () => {
    setDataRoot(null)
    const res = await transferModelsToLibrary({
      ids: ['x'],
      targetRoot: rootB,
      mode: 'copy',
    })
    expect(res.error).toBe('尚未设置模型文件夹')
  })

  it('空 ids 拒绝传输', async () => {
    const res = await transferModelsToLibrary({
      ids: [],
      targetRoot: rootB,
      mode: 'copy',
    })
    expect(res.error).toBe('没有可传输的模型')
  })

  it('无效目标库（空串）拒绝传输', async () => {
    const res = await transferModelsToLibrary({
      ids: [path.join(rootA, 'm.safetensors')],
      targetRoot: '',
      mode: 'copy',
    })
    expect(res.error).toBe('无效的目标库')
  })

  it('目标库不能是当前模型库', async () => {
    const res = await transferModelsToLibrary({
      ids: [path.join(rootA, 'm.safetensors')],
      targetRoot: rootA,
      mode: 'copy',
    })
    expect(res.error).toBe('目标库不能是当前模型库')
  })

  it('目标不在已保存库清单时拒绝（防任意目录写入）', async () => {
    const outsider = await fs.mkdtemp(
      path.join(os.tmpdir(), 'modelvault-tx-x-'),
    )
    roots.push(outsider)
    await updateSettings({ modelsFolders: [rootA] })
    const res = await transferModelsToLibrary({
      ids: [path.join(rootA, 'm.safetensors')],
      targetRoot: outsider,
      mode: 'copy',
    })
    expect(res.error).toBe('目标文件夹不是已保存的模型库，请先在侧栏添加该库')
  })

  it('目标目录不存在时拒绝', async () => {
    const missing = path.join(rootA, '..', 'modelvault-tx-missing-xx')
    await updateSettings({ modelsFolders: [rootA, missing] })
    const res = await transferModelsToLibrary({
      ids: [path.join(rootA, 'm.safetensors')],
      targetRoot: missing,
      mode: 'copy',
    })
    expect(res.error).toBe('目标库文件夹不存在或不可访问')
  })

  it('目标库存在未合并 journal 时拒绝迁移（防标注回退）', async () => {
    await fs.mkdir(path.join(rootB, '.modelvault', 'journal'), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(rootB, '.modelvault', 'journal', 'delta-000000000001.json'),
      '{}',
    )
    const res = await transferModelsToLibrary({
      ids: [path.join(rootA, 'm.safetensors')],
      targetRoot: rootB,
      mode: 'copy',
    })
    expect(res.error).toContain('未完成的同步')
  })
})

describe('copy 模式', () => {
  it('文件 + sidecar + 封面 + 元数据按相对路径镜像迁移，源保留', async () => {
    const coverSrc = path.join(rootA, '.modelvault', 'covers', 'c1.png')
    await fs.mkdir(path.dirname(coverSrc), { recursive: true })
    await fs.writeFile(coverSrc, 'png-bytes')
    const file = await makeSourceModel({
      relDir: 'sub',
      name: 'm.safetensors',
      sidecarTxt: true,
      meta: {
        favorite: true,
        note: 'keep-me',
        tags: ['x'],
        cover: '.modelvault/covers/c1.png',
        covers: ['.modelvault/covers/c1.png'],
      },
    })

    const res = await transferModelsToLibrary({
      ids: [file],
      targetRoot: rootB,
      mode: 'copy',
    })

    expect(res).toMatchObject({
      transferred: 1,
      mode: 'copy',
      failed: [],
      skipped: [],
    })
    // 目标：文件/sidecar 内容镜像
    expect(
      await fs.readFile(path.join(rootB, 'sub', 'm.safetensors'), 'utf-8'),
    ).toBe('model-bytes')
    expect(await fs.readFile(path.join(rootB, 'sub', 'm.txt'), 'utf-8')).toBe(
      'trigger-words',
    )
    // 源保留（copy 语义）
    expect(await fs.access(file).then(() => true)).toBe(true)
    // 元数据迁移到目标 store.json（相对键一致，标注零重写生效）
    const store = await readTargetStore()
    expect(store.models['sub/m.safetensors']).toMatchObject({
      favorite: true,
      note: 'keep-me',
      tags: ['x'],
    })
    // 封面文件复制到目标库，源封面保留
    expect(
      await fs.readFile(
        path.join(rootB, '.modelvault', 'covers', 'c1.png'),
        'utf-8',
      ),
    ).toBe('png-bytes')
    expect(await fs.access(coverSrc).then(() => true)).toBe(true)
  })

  it('目标已存在同相对路径文件时跳过不覆盖', async () => {
    const file = await makeSourceModel({ relDir: 'sub', name: 'm.safetensors' })
    await fs.mkdir(path.join(rootB, 'sub'), { recursive: true })
    await fs.writeFile(path.join(rootB, 'sub', 'm.safetensors'), 'existing')

    const res = await transferModelsToLibrary({
      ids: [file],
      targetRoot: rootB,
      mode: 'copy',
    })

    expect(res.transferred).toBe(0)
    expect(res.skipped).toEqual([{ id: file, reason: '目标库已存在同名文件' }])
    expect(
      await fs.readFile(path.join(rootB, 'sub', 'm.safetensors'), 'utf-8'),
    ).toBe('existing')
  })

  it('源文件不存在计入失败', async () => {
    const ghost = path.join(rootA, 'ghost.safetensors')
    const res = await transferModelsToLibrary({
      ids: [ghost],
      targetRoot: rootB,
      mode: 'copy',
    })
    expect(res.transferred).toBe(0)
    expect(res.failed).toEqual([{ id: ghost, error: '模型文件不存在' }])
  })

  it('库外路径计入失败（越界防护）', async () => {
    const outside = path.join(rootA, '..', 'outside.safetensors')
    const res = await transferModelsToLibrary({
      ids: [outside],
      targetRoot: rootB,
      mode: 'copy',
    })
    expect(res.transferred).toBe(0)
    expect(res.failed).toEqual([{ id: outside, error: '模型不在当前库内' }])
  })

  it('条目无元数据时迁移文件但不写目标 store.json', async () => {
    const file = await makeSourceModel({ name: 'bare.safetensors' })
    const res = await transferModelsToLibrary({
      ids: [file],
      targetRoot: rootB,
      mode: 'copy',
    })
    expect(res.transferred).toBe(1)
    expect(await readTargetStore()).toBeNull()
  })
})

describe('move 模式', () => {
  it('传输成功后清理源文件与源元数据，目标完整', async () => {
    const file = await makeSourceModel({
      relDir: 'sub',
      name: 'm.safetensors',
      sidecarTxt: true,
      meta: { favorite: true, note: 'n' },
    })

    const res = await transferModelsToLibrary({
      ids: [file],
      targetRoot: rootB,
      mode: 'move',
    })

    expect(res).toMatchObject({ transferred: 1, mode: 'move', failed: [] })
    // 源清理：模型文件与 sidecar 移除、元数据移除
    await expect(fs.access(file)).rejects.toThrow()
    await expect(fs.access(path.join(rootA, 'sub', 'm.txt'))).rejects.toThrow()
    expect(getModelMeta(file)).toBeFalsy()
    // 目标完整
    expect(
      await fs.readFile(path.join(rootB, 'sub', 'm.safetensors'), 'utf-8'),
    ).toBe('model-bytes')
    const store = await readTargetStore()
    expect(store.models['sub/m.safetensors']).toMatchObject({ favorite: true })
    // 源 store.json 落盘后不再含该条目
    await flushStoreSave().catch(() => {})
    const sourceStore = JSON.parse(
      await fs.readFile(path.join(rootA, '.modelvault', 'store.json'), 'utf-8'),
    )
    expect(sourceStore.models['sub/m.safetensors']).toBeUndefined()
  })

  it('文件传输失败时回滚目标元数据条目，源文件不动（先写后传配套）', async () => {
    const file = await makeSourceModel({
      relDir: 'sub',
      name: 'm.safetensors',
      meta: { favorite: true },
    })
    // 目标相对目录被同名文件占用：mkdir 失败 → 传输失败 → 回滚已写条目
    await fs.writeFile(path.join(rootB, 'sub'), 'occupied')

    const res = await transferModelsToLibrary({
      ids: [file],
      targetRoot: rootB,
      mode: 'copy',
    })

    expect(res.transferred).toBe(0)
    expect(res.failed).toHaveLength(1)
    expect(res.failed[0].error).toContain('文件传输失败')
    // 元数据先写后传：写入过一次（可证于 store.json 存在），失败后条目已回滚
    const store = await readTargetStore()
    expect(store).not.toBeNull()
    expect(store.models['sub/m.safetensors']).toBeUndefined()
    // 源文件不受影响
    expect(await fs.readFile(file, 'utf-8')).toBe('model-bytes')
  })
})

describe('取消与 fail-closed 中止', () => {
  it('规划阶段取消：零写入干净退出', async () => {
    const file = await makeSourceModel({
      name: 'm.safetensors',
      meta: { favorite: true },
    })
    const res = await transferModelsToLibrary({
      ids: [file],
      targetRoot: rootB,
      mode: 'copy',
      signal: AbortSignal.abort(),
    })
    expect(res).toMatchObject({
      canceled: true,
      transferred: 0,
      mode: 'copy',
    })
    // 未写目标元数据、未复制文件
    expect(await readTargetStore()).toBeNull()
    await expect(fs.access(path.join(rootB, 'm.safetensors'))).rejects.toThrow()
  })

  it('目标库元数据损坏时中止传输（fail-closed，不按空库覆盖）', async () => {
    const file = await makeSourceModel({ name: 'm.safetensors' })
    await fs.mkdir(path.join(rootB, '.modelvault'), { recursive: true })
    await fs.writeFile(path.join(rootB, '.modelvault', 'store.json'), '{broken')

    const res = await transferModelsToLibrary({
      ids: [file],
      targetRoot: rootB,
      mode: 'copy',
    })

    expect(res.error).toContain('目标库元数据读取失败')
    expect(res.error).toContain('已中止')
    // 干净回退：未复制文件，损坏文件未被覆盖
    await expect(fs.access(path.join(rootB, 'm.safetensors'))).rejects.toThrow()
    expect(
      await fs.readFile(path.join(rootB, '.modelvault', 'store.json'), 'utf-8'),
    ).toBe('{broken')
  })
})
