import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import { fakeUserData } from './setup'
import { getRegisteredHandler, makeEvent } from './helpers/modelsIpc'

/**
 * 扫描链路 × 元数据重关联端到端测试（A-02）：
 * 使用真实 scanner（不 mock）+ 真实关联存储，模拟用户在资源管理器中把
 * 模型文件移动到新目录后重扫——标注应自动迁移到新路径，且装饰结果
 * （卡片/详情读取的数据）立即携带原标注。
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

// 默认 autoRescan=false，syncWatcher 不启动轮询定时器，无需 mock watcher
// （曾以 importOriginal 工厂 mock watcher，该写法会产生第二张模块图导致
// store 门面与 IPC 链各自持有不同单例）
vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([])

import { registerModelIpcHandlers } from '../src/main/ipc/models/index'
import { getModelMeta, loadData, loadSettings, setDataRoot, setModelMeta, updateSettings } from '../src/main/services/store'

const settingsFile = path.join(fakeUserData, 'settings.json')
const roots = []
let root

beforeEach(async () => {
  registerModelIpcHandlers()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-scan-relink-'))
  roots.push(root)
  // 必须 loadData：setDataRoot 预置根后扫描处理器的 ensureRootStore 见根未变
  // 会跳过加载，data 保持 null 将使 setModelMeta 按守卫拒绝写入
  setDataRoot(root)
  await loadSettings()
  await loadData()
})

afterEach(async () => {
  await fs.rm(settingsFile, { force: true }).catch(() => {})
  vi.mocked(dialog.showOpenDialog).mockReset()
})

afterAll(async () => {
  for (const dir of roots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('models:partialScan 局部增量扫描（A-03）', () => {
  it('只扫描指定子树：返回子树现状，装饰标注生效，子树外文件不出现在响应中', async () => {
    const scan = getRegisteredHandler('models:scan')
    const partial = getRegisteredHandler('models:partialScan')
    await updateSettings({ modelsFolder: root })

    // 初始布局：lora/a（有标注）+ checkpoint/c
    await fs.mkdir(path.join(root, 'lora'), { recursive: true })
    await fs.mkdir(path.join(root, 'checkpoint'), { recursive: true })
    const aAbs = path.join(root, 'lora', 'a.safetensors')
    const cAbs = path.join(root, 'checkpoint', 'c.safetensors')
    await fs.writeFile(aAbs, 'x')
    await fs.writeFile(cAbs, 'x')
    await scan(makeEvent(), { folder: root })
    setModelMeta(aAbs, { alias: 'A 模型', favorite: true })
    setModelMeta(cAbs, { note: '大模型备注' })

    // lora 子树：a 改名为 b
    await fs.rename(aAbs, path.join(root, 'lora', 'b.safetensors'))

    const res = await partial(makeEvent(), { folder: root, dirs: ['lora'] })

    expect(res.error).toBeUndefined()
    expect(res.relinked).toBe(1)
    expect(res.models).toHaveLength(1)
    expect(res.models[0].id).toBe(path.join(root, 'lora', 'b.safetensors'))
    // 重关联的标注在局部结果中即时生效
    expect(res.models[0].alias).toBe('A 模型')
    expect(res.models[0].favorite).toBe(true)
    // checkpoint 不在本次响应内
    expect(res.models.some((m) => m.id === cAbs)).toBe(false)
    // 子树外的元数据原样保留
    expect(getModelMeta(cAbs).note).toBe('大模型备注')
  })

  it('白名单外目录拒绝局部扫描', async () => {
    const partial = getRegisteredHandler('models:partialScan')
    const outside = path.join(root, '..', 'outside-' + Date.now())
    const res = await partial(makeEvent(), { folder: outside, dirs: [''] })
    expect(res.error).toBeTruthy()
  })

  it('dirs 非法（含 .. 逃逸/非数组/空）拒绝', async () => {
    const partial = getRegisteredHandler('models:partialScan')
    await updateSettings({ modelsFolder: root })
    expect((await partial(makeEvent(), { folder: root, dirs: [] })).error).toContain('子树')
    expect((await partial(makeEvent(), { folder: root, dirs: ['../escape'] })).error).toContain('子树')
    expect((await partial(makeEvent(), { folder: root, dirs: 'lora' })).error).toContain('子树')
  })
})

describe('models:scan × A-02 移动后自动重关联', () => {
  it('文件移动到新目录后重扫：relinked=1，装饰结果在新路径携带原标注', async () => {
    const scan = getRegisteredHandler('models:scan')
    await updateSettings({ modelsFolder: root })

    // 第一次扫描：模型位于 old-dir
    const oldDir = path.join(root, 'old-dir')
    await fs.mkdir(oldDir, { recursive: true })
    const oldAbs = path.join(oldDir, 'my-lora.safetensors')
    await fs.writeFile(oldAbs, 'fake model content')
    const first = await scan(makeEvent(), { folder: root })
    expect(first.error).toBeUndefined()
    expect(first.relinked).toBe(0)
    expect(first.models.map((m) => m.id)).toContain(oldAbs)

    // 用户在资源管理器中移动文件（同卷 rename 保留 mtime），并写入标注
    setModelMeta(oldAbs, { alias: '我的 LoRA', note: '重要', favorite: true, rating: 4 })
    const newDir = path.join(root, 'loras', 'characters')
    await fs.mkdir(newDir, { recursive: true })
    const newAbs = path.join(newDir, 'my-lora.safetensors')
    await fs.rename(oldAbs, newAbs)

    // 第二次扫描：R1 同名移动唯一匹配，自动重关联
    const second = await scan(makeEvent(), { folder: root })
    expect(second.error).toBeUndefined()
    expect(second.relinked).toBe(1)

    // 装饰结果在新路径上直接携带原标注（无需第三次扫描）
    const decorated = second.models.find((m) => m.id === newAbs)
    expect(decorated).toBeTruthy()
    expect(decorated.alias).toBe('我的 LoRA')
    expect(decorated.note).toBe('重要')
    expect(decorated.favorite).toBe(true)
    expect(decorated.rating).toBe(4)
    expect(second.models.find((m) => m.id === oldAbs)).toBeUndefined()

    // 存储层：旧键已删除，新键持有同一份元数据
    expect(getModelMeta(oldAbs)).toBeNull()
    expect(getModelMeta(newAbs).alias).toBe('我的 LoRA')
  })

  it('同目录改名后重扫（R2 1:1）：评分迁移', async () => {
    const scan = getRegisteredHandler('models:scan')
    await updateSettings({ modelsFolder: root })
    const oldAbs = path.join(root, 'before.safetensors')
    await fs.writeFile(oldAbs, 'content')
    await scan(makeEvent(), { folder: root })
    setModelMeta(oldAbs, { rating: 5 })

    const newAbs = path.join(root, 'after.safetensors')
    await fs.rename(oldAbs, newAbs)

    const res = await scan(makeEvent(), { folder: root })
    expect(res.relinked).toBe(1)
    expect(getModelMeta(newAbs).rating).toBe(5)
    expect(getModelMeta(oldAbs)).toBeNull()
  })
})
