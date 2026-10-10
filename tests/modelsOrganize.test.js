import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import { fakeUserData } from './setup'
import { getRegisteredHandler, makeEvent } from './helpers/modelsIpc'

/**
 * 应用内整理链路 IPC 集成测试（B-06）：真实文件系统 + 真实关联存储。
 * 覆盖目录列举/新建/重命名（元数据前缀迁移）、模型+sidecar 移动（键迁移与
 * 装饰结果）、非法路径拦截、失联缺口查询与手动绑定。
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  BrowserWindow: Object.assign(vi.fn(), {
    fromWebContents: vi.fn(),
    getAllWindows: vi.fn(() => [])
  }),
  clipboard: { read: vi.fn(), writeText: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBox: vi.fn() },
  ipcMain: { handle: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  shell: { trashItem: vi.fn(), showItemInFolder: vi.fn(), openPath: vi.fn(() => '') },
  net: { fetch: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn(), createFromPath: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() }
}))

vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([])

import { registerModelIpcHandlers } from '../src/main/ipc/models/index'
import { getModelMeta, loadData, loadSettings, setDataRoot, setModelMeta } from '../src/main/services/store'

const settingsFile = path.join(fakeUserData, 'settings.json')
const roots = []
let root

beforeEach(async () => {
  registerModelIpcHandlers()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-organize-'))
  roots.push(root)
  setDataRoot(root)
  await loadSettings()
  await loadData()
})

afterEach(async () => {
  await fs.rm(settingsFile, { force: true }).catch(() => {})
})

afterAll(async () => {
  for (const dir of roots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

/** 写一个模型文件（可选 sidecar 文本），返回绝对路径 */
async function placeFile(rel, content = 'x', { txt } = {}) {
  const abs = path.join(root, ...rel.split('/'))
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content)
  if (txt) await fs.writeFile(abs.replace(/\.[^.]+$/, '.txt'), txt)
  return abs
}

describe('models:listDirs 目录列举', () => {
  it('递归列出全部目录（含空目录），跳过 .modelvault，根恒在首位', async () => {
    await fs.mkdir(path.join(root, 'lora', 'role'), { recursive: true })
    await fs.mkdir(path.join(root, 'empty-dir'), { recursive: true })
    await fs.mkdir(path.join(root, '.modelvault', 'covers'), { recursive: true })
    const handler = getRegisteredHandler('models:listDirs')
    const res = await handler(makeEvent(), {})
    expect(res.error).toBeUndefined()
    expect(res.dirs[0]).toBe('')
    expect(res.dirs).toContain('lora')
    expect(res.dirs).toContain('lora/role')
    expect(res.dirs).toContain('empty-dir')
    expect(res.dirs.some((d) => d.startsWith('.modelvault'))).toBe(false)
  })
})

describe('models:createFolder 新建文件夹', () => {
  it('创建多级新目录；已存在目录幂等返回 existed', async () => {
    const handler = getRegisteredHandler('models:createFolder')
    const r1 = await handler(makeEvent(), { relDir: 'a/b/c' })
    expect(r1.ok).toBe(true)
    expect(r1.dir).toBe('a/b/c')
    expect(r1.existed).toBeFalsy()
    await expect(fs.stat(path.join(root, 'a', 'b', 'c'))).resolves.toBeTruthy()

    const r2 = await handler(makeEvent(), { relDir: 'a/b/c' })
    expect(r2).toMatchObject({ ok: true, existed: true })
  })

  it('拒绝逃逸路径与保留目录名', async () => {
    const handler = getRegisteredHandler('models:createFolder')
    expect((await handler(makeEvent(), { relDir: '../evil' })).error).toBeTruthy()
    expect((await handler(makeEvent(), { relDir: '.modelvault' })).error).toBeTruthy()
  })
})

describe('models:renameFolder 重命名文件夹', () => {
  it('目录改名并整体迁移其下元数据键', async () => {
    const aAbs = await placeFile('lora/a.safetensors')
    const bAbs = await placeFile('lora/role/b.safetensors')
    setModelMeta(aAbs, { alias: 'A', favorite: true })
    setModelMeta(bAbs, { note: 'B 备注' })

    const handler = getRegisteredHandler('models:renameFolder')
    const res = await handler(makeEvent(), { relDir: 'lora', newName: 'loras' })
    expect(res.error).toBeUndefined()
    expect(res).toMatchObject({ ok: true, oldDir: 'lora', newDir: 'loras', moved: 2 })

    // 文件在新路径，旧路径不存在
    await expect(fs.stat(path.join(root, 'loras', 'a.safetensors'))).resolves.toBeTruthy()
    await expect(fs.stat(path.join(root, 'lora'))).rejects.toMatchObject({ code: 'ENOENT' })
    // 标注随键迁移，旧键不再有数据
    expect(getModelMeta(path.join(root, 'loras', 'a.safetensors')).alias).toBe('A')
    expect(getModelMeta(path.join(root, 'loras', 'role', 'b.safetensors')).note).toBe('B 备注')
    expect(getModelMeta(aAbs)).toBeNull()
  })

  it('根目录不可重命名；目标已存在时拒绝', async () => {
    await fs.mkdir(path.join(root, 'a'), { recursive: true })
    await fs.mkdir(path.join(root, 'b'), { recursive: true })
    const handler = getRegisteredHandler('models:renameFolder')
    expect((await handler(makeEvent(), { relDir: '', newName: 'x' })).error).toBeTruthy()
    const res = await handler(makeEvent(), { relDir: 'a', newName: 'b' })
    expect(res.error).toBeTruthy()
  })
})

describe('models:moveModels 模型移动', () => {
  it('移动模型与同名 sidecar，元数据键迁移，返回装饰后的新条目', async () => {
    const aAbs = await placeFile('lora/a.safetensors', 'weights', { txt: 'trigger-one' })
    setModelMeta(aAbs, { alias: 'A 模型', favorite: true })
    const sidecarTxt = path.join(root, 'lora', 'a.txt')

    const handler = getRegisteredHandler('models:moveModels')
    const res = await handler(makeEvent(), { ids: [aAbs], destDir: '角色/洛' })
    expect(res.error).toBeUndefined()
    expect(res.failed).toEqual([])
    expect(res.moved).toHaveLength(1)

    const destAbs = path.join(root, '角色', '洛', 'a.safetensors')
    expect(res.moved[0].to).toBe(destAbs)
    await expect(fs.stat(destAbs)).resolves.toBeTruthy()
    await expect(fs.stat(aAbs)).rejects.toMatchObject({ code: 'ENOENT' })
    // sidecar 随行
    await expect(fs.stat(path.join(root, '角色', '洛', 'a.txt'))).resolves.toBeTruthy()
    await expect(fs.stat(sidecarTxt)).rejects.toMatchObject({ code: 'ENOENT' })
    // 标注在新键即时生效（装饰结果携带），旧键清空
    expect(res.moved[0].model.alias).toBe('A 模型')
    expect(res.moved[0].model.favorite).toBe(true)
    expect(getModelMeta(destAbs).favorite).toBe(true)
    expect(getModelMeta(aAbs)).toBeNull()
  })

  it('目标已存在同名文件、移动到原目录、库外路径均进入 failed 且不影响其他条目', async () => {
    const aAbs = await placeFile('lora/a.safetensors')
    const bAbs = await placeFile('lora/b.safetensors')
    await fs.mkdir(path.join(root, 'dest'), { recursive: true })
    // dest 中预置同名 a.safetensors 制造冲突
    await fs.writeFile(path.join(root, 'dest', 'a.safetensors'), 'y')

    const handler = getRegisteredHandler('models:moveModels')
    const res = await handler(makeEvent(), {
      ids: [aAbs, bAbs, 'D:\\outside\\x.safetensors'],
      destDir: 'dest'
    })
    expect(res.moved).toHaveLength(1)
    expect(res.moved[0].from).toBe(bAbs)
    expect(res.failed).toHaveLength(2)
    // 冲突文件未被覆盖
    await expect(fs.readFile(path.join(root, 'dest', 'a.safetensors'), 'utf-8')).resolves.toBe('y')
    // 移动到自身所在目录
    const self = await handler(makeEvent(), { ids: [bAbs], destDir: 'dest' })
    expect(self.failed).toHaveLength(1)
  })

  it('拒绝空请求与超长批次', async () => {
    const handler = getRegisteredHandler('models:moveModels')
    expect((await handler(makeEvent(), { ids: [], destDir: '' })).error).toBeTruthy()
    expect((await handler(makeEvent(), { ids: Array(1001).fill('x'), destDir: '' })).error).toBeTruthy()
  })
})

describe('models:metaGaps / models:bindMeta 失联标注', () => {
  it('列出含数据孤儿与无标注新模型，手动绑定后标注挂到新键并返回装饰结果', async () => {
    const newAbs = await placeFile('lora/new-name.safetensors')
    const goneAbs = path.join(root, 'old', 'gone.safetensors')
    setModelMeta(goneAbs, { alias: '失联模型', favorite: true })

    const gapsHandler = getRegisteredHandler('models:metaGaps')
    const gaps = await gapsHandler(makeEvent(), { ids: [newAbs] })
    expect(gaps.orphans.map((o) => o.key)).toContain('old/gone.safetensors')
    expect(gaps.newcomers.map((n) => n.key)).toContain('lora/new-name.safetensors')
    const orphan = gaps.orphans.find((o) => o.key === 'old/gone.safetensors')
    expect(orphan.favorite).toBe(true)

    const bindHandler = getRegisteredHandler('models:bindMeta')
    const res = await bindHandler(makeEvent(), {
      oldKey: 'old/gone.safetensors',
      newKey: 'lora/new-name.safetensors'
    })
    expect(res.error).toBeUndefined()
    expect(res.model.id).toBe(newAbs)
    expect(res.model.alias).toBe('失联模型')
    expect(res.model.favorite).toBe(true)
    expect(getModelMeta(newAbs).alias).toBe('失联模型')
    expect(getModelMeta(goneAbs)).toBeNull()
  })

  it('非法相对键与不存在的目标文件拒绝绑定', async () => {
    const handler = getRegisteredHandler('models:bindMeta')
    expect((await handler(makeEvent(), { oldKey: '../a.safetensors', newKey: 'b.safetensors' })).error).toBeTruthy()
    expect(
      (await handler(makeEvent(), { oldKey: 'a.safetensors', newKey: 'ghost/x.safetensors' })).error
    ).toBeTruthy()
  })

  it('目标模型已有标注时拒绝绑定（不覆盖）', async () => {
    const aAbs = await placeFile('a.safetensors')
    setModelMeta(aAbs, { note: '已有标注' })
    const goneAbs = path.join(root, 'old', 'gone.safetensors')
    setModelMeta(goneAbs, { alias: '失联' })

    const handler = getRegisteredHandler('models:bindMeta')
    const res = await handler(makeEvent(), { oldKey: 'old/gone.safetensors', newKey: 'a.safetensors' })
    expect(res.error).toBeTruthy()
    expect(getModelMeta(aAbs).note).toBe('已有标注')
  })
})
