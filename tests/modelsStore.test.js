import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { fakeUserData } from './setup'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * models 域辅助纯函数特征测试（D1，先测后拆基线）：
 * - sidecarFilesFor：删除模型时需一并清理的同名 sidecar 清单（deleteModel 正确性核心）
 * - paramSummaryFromMeta：右键菜单「复制推荐参数」的格式化
 * - models:loadStore 的目录监控启动路径（OPT-19）
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  BrowserWindow: Object.assign(vi.fn(), {
    fromWebContents: vi.fn(),
    getAllWindows: vi.fn(() => [])
  }),
  clipboard: { read: vi.fn(), writeText: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  shell: { trashItem: vi.fn(), showItemInFolder: vi.fn() },
  net: { fetch: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() }
}))

// OPT-19：loadStore 的 watcher 同步以 mock 观测，避免真实轮询定时器进入测试
vi.mock('../src/main/services/watcher', () => ({
  syncWatcher: vi.fn(),
  stopWatcher: vi.fn()
}))

// 仅替换 computeFileHash：预热作废测试需要可控/可观测的哈希计算（避免真实
// worker 线程参与）；civitai 其余导出保持原实现供依赖链使用
vi.mock('../src/main/services/civitai', async (importOriginal) => ({
  ...(await importOriginal()),
  computeFileHash: vi.fn()
}))

import { paramSummaryFromMeta, sidecarFilesFor } from '../src/main/ipc/models/misc'
import { registerStoreHandlers } from '../src/main/ipc/models/store'
import { syncWatcher } from '../src/main/services/watcher'
import { computeFileHash } from '../src/main/services/civitai'
import {
  pauseHashWarmup,
  requestHashWarmup,
  resetHashWarmupForTests,
  resumeHashWarmup,
  whenWarmupIdle
} from '../src/main/services/hash-warmup'
import { getCurrentRoot, loadSettings } from '../src/main/services/store'
import { getRegisteredHandler, makeEvent } from './helpers/modelsIpc'

describe('sidecarFilesFor', () => {
  it('返回同名 .txt 与全部预览图候选（与展示侧 SIDECAR_PREVIEW_EXTS 一致，B17）', () => {
    const dir = path.join('D:', 'models', 'loras')
    const files = sidecarFilesFor(path.join(dir, 'style-a.safetensors'))
    expect(files[0]).toBe(path.join(dir, 'style-a.txt'))
    // .txt 之后逐个列出预览图候选（.png/.preview.png/.jpg/.jpeg/.webp/.gif/.bmp，共 7 个）
    expect(files.length).toBe(1 + 7)
    expect(files).toContain(path.join(dir, 'style-a.preview.png'))
    expect(files).toContain(path.join(dir, 'style-a.bmp'))
  })

  it('文件名含多个点时仅按最后一个扩展名取基名', () => {
    const files = sidecarFilesFor(path.join('D:', 'm', 'flux.1.dev.safetensors'))
    expect(files[0]).toBe(path.join('D:', 'm', 'flux.1.dev.txt'))
  })
})

describe('paramSummaryFromMeta', () => {
  it('空参数返回空字符串（右键菜单不显示「复制推荐参数」）', () => {
    expect(paramSummaryFromMeta(null)).toBe('')
    expect(paramSummaryFromMeta({})).toBe('')
  })

  it('cfg 区间与单值两种格式', () => {
    expect(paramSummaryFromMeta({ cfgMin: 7, cfgMax: 7 })).toBe('CFG: 7')
    expect(paramSummaryFromMeta({ cfgMin: 4, cfgMax: 12 })).toBe('CFG: 4~12')
  })

  it('全字段按固定顺序拼接', () => {
    const summary = paramSummaryFromMeta({
      steps: 28,
      cfgMin: 4,
      cfgMax: 12,
      sampler: 'euler',
      scheduler: 'karras',
      resMin: 512,
      resMax: 1024
    })
    expect(summary).toBe('Steps: 28, CFG: 4~12, Sampler: euler, Scheduler: karras, Size: 512x1024')
  })
})

describe('models:loadStore 目录监控启动路径（OPT-19）', () => {
  const tmpRoots = []

  /** 写一份 settings.json 并返回其指向的模型根目录 */
  function writeSettings(patch) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modelvault-ls-'))
    tmpRoots.push(root)
    fs.writeFileSync(
      path.join(fakeUserData, 'settings.json'),
      JSON.stringify({ modelsFolder: root, modelsFolders: [root], ...patch })
    )
    return root
  }

  beforeEach(() => {
    vi.mocked(syncWatcher).mockClear()
    registerStoreHandlers()
  })

  afterAll(() => {
    for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('autoScan 关闭但 autoRescan 开启时，loadStore 仍同步启动 watcher', async () => {
    // 复现缺陷场景：关闭启动自动扫描后，此前 watcher 永不启动（E8 静默失效）
    const root = writeSettings({ autoScan: false, autoRescan: true, excludeDirs: ['temp'] })
    const handler = getRegisteredHandler('models:loadStore')
    await handler(makeEvent())
    expect(syncWatcher).toHaveBeenCalledWith(root, true, ['temp'], { nativeWatch: true })
  })

  it('autoRescan 关闭时按禁用状态同步（不启动监控）', async () => {
    const root = writeSettings({ autoScan: false, autoRescan: false })
    await getRegisteredHandler('models:loadStore')(makeEvent())
    expect(syncWatcher).toHaveBeenCalledWith(root, false, [], { nativeWatch: true })
  })
})

describe('models:openLibrary 秒切库（F1）', () => {
  const tmpRoots = []

  function writeSettings(patch) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modelvault-open-'))
    tmpRoots.push(root)
    fs.writeFileSync(
      path.join(fakeUserData, 'settings.json'),
      JSON.stringify({ modelsFolder: root, modelsFolders: [root], ...patch })
    )
    return root
  }

  function writeIndex(root, models = []) {
    const dir = path.join(root, '.modelvault')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'index.json'),
      JSON.stringify({
        version: 1,
        root,
        savedAt: 1,
        durationMs: 42,
        models
      })
    )
  }

  beforeEach(() => {
    vi.mocked(syncWatcher).mockClear()
    vi.mocked(computeFileHash).mockReset()
    resetHashWarmupForTests()
    registerStoreHandlers()
  })

  afterAll(() => {
    for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('切库后作废旧库的后台哈希预热队列并按新库索引重播种', async () => {
    // 复现缺陷：秒切库不经过扫描链路的 full 快照重播种，旧库排队中的批量
    // 哈希任务继续消费，对已不在当前根内的文件白算 SHA256（结果被跨根
    // 写守卫丢弃，纯浪费磁盘 IO）
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'modelvault-open-a-'))
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'modelvault-open-b-'))
    tmpRoots.push(rootA, rootB)
    fs.writeFileSync(
      path.join(fakeUserData, 'settings.json'),
      JSON.stringify({ modelsFolder: rootA, modelsFolders: [rootA, rootB], autoScan: false })
    )
    await loadSettings()
    // 库 A 激活为当前根（loadStore 的 ensureRootStore 路径）
    const idA = path.join(rootA, 'old.safetensors')
    fs.writeFileSync(idA, 'x'.repeat(16))
    await getRegisteredHandler('models:loadStore')(makeEvent())
    expect(getCurrentRoot()).toBe(rootA)

    // 库 B 索引：同尺寸双模型（缺省 candidates 策略下碰撞组 ≥2 才会入队）
    const idB1 = path.join(rootB, 'b1.safetensors')
    const idB2 = path.join(rootB, 'b2.safetensors')
    fs.writeFileSync(idB1, 'y'.repeat(16))
    fs.writeFileSync(idB2, 'y'.repeat(16))
    writeIndex(rootB, [
      {
        id: idB1,
        name: 'b1',
        type: 'lora',
        ext: '.safetensors',
        size: 16,
        mtimeMs: 1,
        relDir: ''
      },
      {
        id: idB2,
        name: 'b2',
        type: 'lora',
        ext: '.safetensors',
        size: 16,
        mtimeMs: 1,
        relDir: ''
      }
    ])

    vi.mocked(computeFileHash).mockResolvedValue('a'.repeat(64))
    // 模拟旧库的后台批量预热在途：暂停取队 + delayMs:0，任务确定性滞留队列
    pauseHashWarmup()
    requestHashWarmup([idA], { mode: 'full', full: true, delayMs: 0 })

    const res = await getRegisteredHandler('models:openLibrary')(makeEvent(), { folder: rootB })
    expect(res.cached).toBe(true)
    expect(getCurrentRoot()).toBe(rootB)

    // 恢复取队（重播种的 3s 延迟启动到期后 drain 自动执行）：旧库任务必须
    // 已被作废，仅新库碰撞组入队计算
    resumeHashWarmup()
    await whenWarmupIdle()

    const hashed = vi.mocked(computeFileHash).mock.calls.map((c) => c[0])
    expect(hashed).not.toContain(idA)
    expect(hashed).toContain(idB1)
    expect(hashed).toContain(idB2)
  })

  it('有索引时切换根目录并返回缓存模型/设置', async () => {
    const root = writeSettings({})
    await loadSettings()
    const model = {
      id: path.join(root, 'a.safetensors'),
      name: 'a',
      type: 'lora',
      ext: '.safetensors',
      size: 1,
      mtimeMs: 1,
      relDir: ''
    }
    writeIndex(root, [model])
    // 索引之后修改的标注应从当前元数据覆盖显示（F1）
    fs.writeFileSync(
      path.join(root, '.modelvault', 'store.json'),
      JSON.stringify({
        version: 1,
        models: { 'a.safetensors': { favorite: true, note: '索引后修改' } }
      })
    )

    const res = await getRegisteredHandler('models:openLibrary')(makeEvent(), { folder: root })

    expect(res.error).toBeUndefined()
    expect(res.cached).toBe(true)
    expect(res.root).toBe(root)
    expect(res.models[0]).toMatchObject({ favorite: true, note: '索引后修改' })
    expect(res.durationMs).toBe(42)
    expect(res.settings.modelsFolder).toBe(root)
    expect(getCurrentRoot()).toBe(root)
    expect(syncWatcher).toHaveBeenCalledWith(root, false, [], { nativeWatch: true })
  })

  it('无索引时不切换根目录，返回 cached=false 交由扫描链路', async () => {
    const root = writeSettings({})
    await loadSettings()
    const before = getCurrentRoot()
    const res = await getRegisteredHandler('models:openLibrary')(makeEvent(), { folder: root })

    expect(res).toEqual({ root, cached: false })
    expect(getCurrentRoot()).toBe(before)
  })

  it('模型库列表之外 / 不存在的目录拒绝', async () => {
    writeSettings({})
    await loadSettings()
    const outside = path.join(os.tmpdir(), 'modelvault-not-in-list')
    expect(
      (await getRegisteredHandler('models:openLibrary')(makeEvent(), { folder: outside })).error
    ).toBe('该目录不在模型库列表中')

    const missing = path.join(os.tmpdir(), 'modelvault-missing-root')
    writeSettings({ modelsFolder: missing, modelsFolders: [missing] })
    await loadSettings()
    // loadSettings 可能为目标库初始化 .modelvault；删除后模拟目录已不存在
    fs.rmSync(missing, { recursive: true, force: true })
    expect(
      (await getRegisteredHandler('models:openLibrary')(makeEvent(), { folder: missing })).error
    ).toContain('模型文件夹不存在')
  })
})
