import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from 'vitest'
import { fakeUserData } from './setup'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
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
    getAllWindows: vi.fn(() => []),
  }),
  clipboard: { read: vi.fn(), writeText: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  shell: { trashItem: vi.fn(), showItemInFolder: vi.fn() },
  net: { fetch: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
}))

// OPT-19：loadStore 的 watcher 同步以 mock 观测，避免真实轮询定时器进入测试
vi.mock('../src/main/services/watcher', () => ({
  syncWatcher: vi.fn(),
  stopWatcher: vi.fn(),
}))

// 仅替换 computeFileHash：预热作废测试需要可控/可观测的哈希计算（避免真实
// worker 线程参与）；civitai 其余导出保持原实现供依赖链使用
vi.mock('../src/main/services/civitai', async (importOriginal) => ({
  ...(await importOriginal()),
  computeFileHash: vi.fn(),
}))

// OPT-19：atomicWriteFile 可按目录前缀挂起（模拟死亡网络盘/半挂载 USB 上
// fsync/rename 在内核层阻塞），其余调用透传真实实现；挂起的写入在用例
// 收尾统一 reject 释放，绝不遗留永久 pending 阻塞后续用例的写盘链
const { awHook } = vi.hoisted(() => ({
  awHook: { hangPrefix: null, pending: [], hungPaths: [] },
}))
vi.mock('../src/main/services/atomic-write', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    atomicWriteFile: (file, content, opts) => {
      if (awHook.hangPrefix && String(file).startsWith(awHook.hangPrefix)) {
        awHook.hungPaths.push(file)
        return new Promise((resolve, reject) => {
          awHook.pending.push({ resolve, reject })
        })
      }
      return actual.atomicWriteFile(file, content, opts)
    },
  }
})

import {
  paramSummaryFromMeta,
  sidecarFilesFor,
} from '../src/main/ipc/models/misc'
import { decorateModels } from '../src/main/ipc/models/decorate'
import { resetDecorateCache } from '../src/main/ipc/models/model-state'
import { registerStoreHandlers } from '../src/main/ipc/models/store'
import { syncWatcher } from '../src/main/services/watcher'
import { computeFileHash } from '../src/main/services/civitai'
import {
  pauseHashWarmup,
  requestHashWarmup,
  resetHashWarmupForTests,
  resumeHashWarmup,
  whenWarmupIdle,
} from '../src/main/services/hash-warmup'
import {
  flushStoreSaveBounded,
  getCurrentRoot,
  getSwitchFlushTimeoutMs,
  loadSettings,
  setFlushAwaitTimeoutForTests,
  setModelMeta,
  setSwitchFlushTimeoutForTests,
} from '../src/main/services/store'
import { ensureRootStore } from '../src/main/ipc/models/store'
import { metaState } from '../src/main/services/store-meta-state'
import { getRegisteredHandler, makeEvent } from './helpers/modelsIpc'

describe('sidecarFilesFor', () => {
  it('返回同名 .txt/.civitai.info 与全部预览图候选（与展示侧一致，B17）', () => {
    const dir = path.join('D:', 'models', 'loras')
    const files = sidecarFilesFor(path.join(dir, 'style-a.safetensors'))
    expect(files[0]).toBe(path.join(dir, 'style-a.txt'))
    expect(files[1]).toBe(path.join(dir, 'style-a.civitai.info'))
    // .txt/.civitai.info 之后逐个列出预览图候选（.png/.preview.png/.jpg/.jpeg/.webp/.gif/.bmp，共 7 个）
    expect(files.length).toBe(2 + 7)
    expect(files).toContain(path.join(dir, 'style-a.preview.png'))
    expect(files).toContain(path.join(dir, 'style-a.bmp'))
  })

  it('文件名含多个点时仅按最后一个扩展名取基名', () => {
    const files = sidecarFilesFor(
      path.join('D:', 'm', 'flux.1.dev.safetensors'),
    )
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
      resMax: 1024,
    })
    expect(summary).toBe(
      'Steps: 28, CFG: 4~12, Sampler: euler, Scheduler: karras, Size: 512x1024',
    )
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
      JSON.stringify({ modelsFolder: root, modelsFolders: [root], ...patch }),
    )
    return root
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

  it('autoScan 关闭但 autoRescan 开启时，loadStore 仍同步启动 watcher', async () => {
    // 复现缺陷场景：关闭启动自动扫描后，此前 watcher 永不启动（E8 静默失效）
    const root = writeSettings({
      autoScan: false,
      autoRescan: true,
      excludeDirs: ['temp'],
    })
    const handler = getRegisteredHandler('models:loadStore')
    await handler(makeEvent())
    expect(syncWatcher).toHaveBeenCalledWith(root, true, ['temp'], {
      nativeWatch: true,
    })
  })

  it('autoRescan 关闭时按禁用状态同步（不启动监控）', async () => {
    const root = writeSettings({ autoScan: false, autoRescan: false })
    await getRegisteredHandler('models:loadStore')(makeEvent())
    expect(syncWatcher).toHaveBeenCalledWith(root, false, [], {
      nativeWatch: true,
    })
  })

  it('loadStore 用索引 size/mtime 播种预热：缓存有效且体积唯一的库启动零 stat 零哈希（P1-2）', async () => {
    const root = writeSettings({ autoScan: false })
    const id1 = path.join(root, 'a.safetensors')
    const id2 = path.join(root, 'b.safetensors')
    fs.writeFileSync(id1, 'x'.repeat(16))
    fs.writeFileSync(id2, 'y'.repeat(32))
    const s1 = await fsp.stat(id1)
    const s2 = await fsp.stat(id2)
    // 模拟「缓存了哈希的大库」：两模型哈希均已缓存且与 mtime 匹配
    fs.mkdirSync(path.join(root, '.modelvault'), { recursive: true })
    fs.writeFileSync(
      path.join(root, '.modelvault', 'store.json'),
      JSON.stringify({
        version: 1,
        models: {
          'a.safetensors': { hash: 'a'.repeat(64), hashMtime: s1.mtimeMs },
          'b.safetensors': { hash: 'b'.repeat(64), hashMtime: s2.mtimeMs },
        },
      }),
    )
    // 本地索引携带 size/mtime（上次扫描的装饰结果）
    fs.writeFileSync(
      path.join(root, '.modelvault', 'index.json'),
      JSON.stringify({
        version: 1,
        root,
        savedAt: 1,
        durationMs: 42,
        models: [
          {
            id: id1,
            name: 'a',
            type: 'lora',
            ext: '.safetensors',
            size: s1.size,
            mtimeMs: s1.mtimeMs,
            relDir: '',
          },
          {
            id: id2,
            name: 'b',
            type: 'lora',
            ext: '.safetensors',
            size: s2.size,
            mtimeMs: s2.mtimeMs,
            relDir: '',
          },
        ],
      }),
    )
    await loadSettings()

    vi.mocked(computeFileHash).mockResolvedValue('c'.repeat(64))
    const statSpy = vi.spyOn(fsp, 'stat')
    try {
      await getRegisteredHandler('models:loadStore')(makeEvent())
      // 旧实现播种裸 id：全部入队，3s 后由 drain 逐个 stat 复核缓存
      await whenWarmupIdle()
      const statPaths = statSpy.mock.calls.map((c) => String(c[0]))
      expect(statPaths).not.toContain(id1)
      expect(statPaths).not.toContain(id2)
      expect(computeFileHash).not.toHaveBeenCalled()
    } finally {
      statSpy.mockRestore()
    }
  })

  it('loadStore 用索引播种头部快照：冷启动装饰复用解析结果（IDX-REUSE）', async () => {
    const root = writeSettings({ autoScan: false })
    const id = path.join(root, 'indexed-ghost.safetensors')
    fs.mkdirSync(path.join(root, '.modelvault'), { recursive: true })
    fs.writeFileSync(
      path.join(root, '.modelvault', 'index.json'),
      JSON.stringify({
        version: 1,
        root,
        savedAt: 1,
        durationMs: 42,
        models: [
          {
            id,
            name: 'indexed-ghost',
            type: 'lora',
            ext: '.safetensors',
            size: 123,
            mtimeMs: 1000,
            relDir: '',
            autoInfo: { title: '索引中的头部信息', expectedMinBytes: 100 },
            suspect: false,
          },
        ],
      }),
    )
    await loadSettings()
    resetDecorateCache(null)

    await getRegisteredHandler('models:loadStore')(makeEvent())
    const [decorated] = await decorateModels([
      {
        id,
        name: 'indexed-ghost',
        type: 'lora',
        ext: '.safetensors',
        size: 123,
        mtimeMs: 1000,
        relDir: '',
      },
    ])
    expect(decorated.autoInfo.title).toBe('索引中的头部信息')
    expect(decorated.suspect).toBe(false)
    resetDecorateCache(null)
  })
})

describe('models:openLibrary 秒切库（F1）', () => {
  const tmpRoots = []

  function writeSettings(patch) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modelvault-open-'))
    tmpRoots.push(root)
    fs.writeFileSync(
      path.join(fakeUserData, 'settings.json'),
      JSON.stringify({ modelsFolder: root, modelsFolders: [root], ...patch }),
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
        models,
      }),
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
      JSON.stringify({
        modelsFolder: rootA,
        modelsFolders: [rootA, rootB],
        autoScan: false,
      }),
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
        relDir: '',
      },
      {
        id: idB2,
        name: 'b2',
        type: 'lora',
        ext: '.safetensors',
        size: 16,
        mtimeMs: 1,
        relDir: '',
      },
    ])

    vi.mocked(computeFileHash).mockResolvedValue('a'.repeat(64))
    // 模拟旧库的后台批量预热在途：暂停取队 + delayMs:0，任务确定性滞留队列
    pauseHashWarmup()
    requestHashWarmup([idA], { mode: 'full', full: true, delayMs: 0 })

    const res = await getRegisteredHandler('models:openLibrary')(makeEvent(), {
      folder: rootB,
    })
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
      relDir: '',
    }
    writeIndex(root, [model])
    // 索引之后修改的标注应从当前元数据覆盖显示（F1）
    fs.writeFileSync(
      path.join(root, '.modelvault', 'store.json'),
      JSON.stringify({
        version: 1,
        models: { 'a.safetensors': { favorite: true, note: '索引后修改' } },
      }),
    )

    const res = await getRegisteredHandler('models:openLibrary')(makeEvent(), {
      folder: root,
    })

    expect(res.error).toBeUndefined()
    expect(res.cached).toBe(true)
    expect(res.root).toBe(root)
    expect(res.models[0]).toMatchObject({ favorite: true, note: '索引后修改' })
    expect(res.durationMs).toBe(42)
    expect(res.settings.modelsFolder).toBe(root)
    expect(getCurrentRoot()).toBe(root)
    expect(syncWatcher).toHaveBeenCalledWith(root, false, [], {
      nativeWatch: true,
    })
  })

  it('openLibrary 用索引播种头部快照：随后的装饰复用解析结果（IDX-REUSE）', async () => {
    const root = writeSettings({})
    await loadSettings()
    const id = path.join(root, 'indexed-ghost.safetensors')
    const indexed = {
      id,
      name: 'indexed-ghost',
      type: 'lora',
      ext: '.safetensors',
      size: 123,
      mtimeMs: 1000,
      relDir: '',
      // 上次扫描的完整装饰结果（文件本身刻意不存在，命中快照才可能得到该值）
      autoInfo: { title: '索引中的头部信息', expectedMinBytes: 100 },
      suspect: false,
    }
    writeIndex(root, [indexed])
    resetDecorateCache(null)

    const res = await getRegisteredHandler('models:openLibrary')(makeEvent(), {
      folder: root,
    })
    expect(res.cached).toBe(true)

    const [decorated] = await decorateModels([
      {
        id,
        name: 'indexed-ghost',
        type: 'lora',
        ext: '.safetensors',
        size: 123,
        mtimeMs: 1000,
        relDir: '',
      },
    ])
    expect(decorated.autoInfo.title).toBe('索引中的头部信息')
    expect(decorated.suspect).toBe(false)
    resetDecorateCache(null)
  })

  it('索引覆盖含 civitaiUrl/baseModel：识别回填即时生效，快照头部值不被抹掉（OPT-06）', async () => {
    const root = writeSettings({})
    await loadSettings()
    const withSnapshot = {
      id: path.join(root, 'snap.safetensors'),
      name: 'snap',
      type: 'lora',
      ext: '.safetensors',
      size: 1,
      mtimeMs: 1,
      relDir: '',
      // 扫描装饰写入索引的文件头部解析值与哈希
      baseModel: 'Flux.1',
      hash: 'f'.repeat(64),
    }
    const withoutSnapshot = {
      id: path.join(root, 'plain.ckpt'),
      name: 'plain',
      type: 'other',
      ext: '.ckpt',
      size: 1,
      mtimeMs: 1,
      relDir: '',
    }
    writeIndex(root, [withSnapshot, withoutSnapshot])
    // 扫描后的 Civitai 识别回填（civitaiUrl/baseModel 均写入 meta）
    fs.writeFileSync(
      path.join(root, '.modelvault', 'store.json'),
      JSON.stringify({
        version: 1,
        models: {
          'snap.safetensors': {
            civitaiUrl: 'https://civitai.com/models/1',
            baseModel: 'Pony',
          },
          'plain.ckpt': {
            civitaiUrl: 'https://civitai.com/models/2',
            baseModel: 'Illustrious',
          },
        },
      }),
    )

    const res = await getRegisteredHandler('models:openLibrary')(makeEvent(), {
      folder: root,
    })

    expect(res.cached).toBe(true)
    const [snap, plain] = res.models
    // 识别回填的 civitaiUrl 即时生效（修复前索引路径不覆盖该字段，
    // 要等下一次全量扫描才在秒开列表显示）
    expect(snap.civitaiUrl).toBe('https://civitai.com/models/1')
    expect(plain.civitaiUrl).toBe('https://civitai.com/models/2')
    // baseModel 与装饰路径同语义：快照的头部解析值优先，meta 回填兜底
    expect(snap.baseModel).toBe('Flux.1')
    expect(plain.baseModel).toBe('Illustrious')
    // 快照哈希保留（meta 无哈希时的兜底）
    expect(snap.hash).toBe('f'.repeat(64))
  })

  it('无索引时不切换根目录，返回 cached=false 交由扫描链路', async () => {
    const root = writeSettings({})
    await loadSettings()
    const before = getCurrentRoot()
    const res = await getRegisteredHandler('models:openLibrary')(makeEvent(), {
      folder: root,
    })

    expect(res).toEqual({ root, cached: false })
    expect(getCurrentRoot()).toBe(before)
  })

  it('模型库列表之外 / 不存在的目录拒绝', async () => {
    writeSettings({})
    await loadSettings()
    const outside = path.join(os.tmpdir(), 'modelvault-not-in-list')
    expect(
      (
        await getRegisteredHandler('models:openLibrary')(makeEvent(), {
          folder: outside,
        })
      ).error,
    ).toBe('该目录不在模型库列表中')

    const missing = path.join(os.tmpdir(), 'modelvault-missing-root')
    writeSettings({ modelsFolder: missing, modelsFolders: [missing] })
    await loadSettings()
    // loadSettings 可能为目标库初始化 .modelvault；删除后模拟目录已不存在
    fs.rmSync(missing, { recursive: true, force: true })
    expect(
      (
        await getRegisteredHandler('models:openLibrary')(makeEvent(), {
          folder: missing,
        })
      ).error,
    ).toContain('模型文件夹不存在')
  })

  it('目标库不存在时返回 folderMissing 标志（F1-offline：渲染层据此进入离线态）', async () => {
    const missing = path.join(os.tmpdir(), 'modelvault-open-gone')
    writeSettings({ modelsFolder: missing, modelsFolders: [missing] })
    await loadSettings()
    fs.rmSync(missing, { recursive: true, force: true })
    const res = await getRegisteredHandler('models:openLibrary')(makeEvent(), {
      folder: missing,
    })
    expect(res.error).toContain('模型文件夹不存在')
    expect(res.folderMissing).toBe(true)
  })
})

describe('models:loadStore 库路径失效检测（F1-offline）', () => {
  const tmpRoots = []

  beforeEach(() => {
    vi.mocked(syncWatcher).mockClear()
    vi.mocked(computeFileHash).mockReset()
    resetHashWarmupForTests()
    registerStoreHandlers()
  })

  afterAll(() => {
    for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true })
  })

  /** 直接写 settings.json（绕过服务层校验，允许指向不存在的路径） */
  function writeRawSettings(raw) {
    fs.writeFileSync(
      path.join(fakeUserData, 'settings.json'),
      JSON.stringify(raw),
    )
  }

  it('激活库不存在时返回 folderMissing: true，rootStatuses 覆盖库列表全量', async () => {
    const existing = fs.mkdtempSync(path.join(os.tmpdir(), 'modelvault-ls-ok-'))
    tmpRoots.push(existing)
    const gone = path.join(os.tmpdir(), 'modelvault-ls-gone-never')
    fs.rmSync(gone, { recursive: true, force: true })
    writeRawSettings({ modelsFolder: gone, modelsFolders: [gone, existing] })

    const res = await getRegisteredHandler('models:loadStore')(makeEvent())

    expect(res.folderMissing).toBe(true)
    expect(res.cachedIndex).toBeNull()
    expect(res.rootStatuses).toEqual([
      { folder: gone, exists: false },
      { folder: existing, exists: true },
    ])
    // 失效路径不得被重建 .modelvault（既有 C6/O5 防护保持）
    expect(fs.existsSync(path.join(gone, '.modelvault'))).toBe(false)
  })

  it('未配置激活库时 folderMissing: false 且 rootStatuses 为空', async () => {
    writeRawSettings({ modelsFolder: '', modelsFolders: [] })
    const res = await getRegisteredHandler('models:loadStore')(makeEvent())
    expect(res.folderMissing).toBe(false)
    expect(res.rootStatuses).toEqual([])
  })

  it('激活库正常时 folderMissing: false，失效的非激活库仍被标记', async () => {
    const ok = fs.mkdtempSync(path.join(os.tmpdir(), 'modelvault-ls-main-'))
    tmpRoots.push(ok)
    const goneOther = path.join(os.tmpdir(), 'modelvault-ls-gone-other')
    fs.rmSync(goneOther, { recursive: true, force: true })
    writeRawSettings({ modelsFolder: ok, modelsFolders: [ok, goneOther] })

    const res = await getRegisteredHandler('models:loadStore')(makeEvent())

    expect(res.folderMissing).toBe(false)
    expect(res.rootStatuses).toEqual([
      { folder: ok, exists: true },
      { folder: goneOther, exists: false },
    ])
  })
})

describe('切库链路超时保护与同根判定（OPT-19 切库防线）', () => {
  const tmpRoots = []

  /** 丢弃元数据防抖定时器：失败计数与写盘行为只由显式操作驱动 */
  function discardDebouncedSave() {
    if (metaState.saveTimer) {
      clearTimeout(metaState.saveTimer)
      metaState.saveTimer = null
    }
  }

  /** 轮询等待写盘链静止（真实时钟） */
  async function waitForIdle(deadlineMs = 5000) {
    const start = Date.now()
    while (metaState.saving || metaState.pendingSave) {
      if (Date.now() - start > deadlineMs) return false
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return true
  }

  /** 建立旧根 A（已激活）并挂起其后续全部原子写，注入毫秒级切库超时 */
  async function setupHangOnOldRoot() {
    const rootA = await fsp.mkdtemp(path.join(os.tmpdir(), 'modelvault-sw-a-'))
    const rootB = await fsp.mkdtemp(path.join(os.tmpdir(), 'modelvault-sw-b-'))
    tmpRoots.push(rootA, rootB)
    await ensureRootStore(rootA)
    setModelMeta(path.join(rootA, 'a.safetensors'), { alias: '旧根未落盘' })
    discardDebouncedSave()
    awHook.hangPrefix = path.join(rootA, '.modelvault')
    setSwitchFlushTimeoutForTests(50)
    return { rootA, rootB }
  }

  afterEach(async () => {
    // 先恢复透传再释放挂起写入：reject 使残尾走错误路径（通知降级为日志），
    // 等一个事件循环周转让 catch 内排程的重试定时器落定后再清理
    awHook.hangPrefix = null
    for (const p of awHook.pending.splice(0)) {
      p.reject(new Error('用例收尾：释放挂起写入'))
    }
    await new Promise((resolve) => setImmediate(resolve))
    setSwitchFlushTimeoutForTests()
    setFlushAwaitTimeoutForTests()
    if (metaState.offlineRetryTimer) {
      clearTimeout(metaState.offlineRetryTimer)
      metaState.offlineRetryTimer = null
    }
    metaState.saveRetryFailures = 0
  })

  afterAll(() => {
    for (const dir of tmpRoots) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('同根大小写变体直接返回：不切根、不重载（R6）', async () => {
    const rootA = await fsp.mkdtemp(path.join(os.tmpdir(), 'modelvault-sw-c-'))
    tmpRoots.push(rootA)
    await ensureRootStore(rootA)
    const dataBefore = metaState.data

    // 渲染层可能传来的同目录另一种拼写（盘符/路径段大小写差异）
    await ensureRootStore(rootA.toLowerCase())

    // 内存根保持原拼写（路径键口径不漂移），元数据引用未变（未重载）
    expect(getCurrentRoot()).toBe(rootA)
    expect(metaState.data).toBe(dataBefore)
  })

  it('切库 flush 挂起时超时放弃落盘，切换继续不卡死（R3）', async () => {
    const { rootA, rootB } = await setupHangOnOldRoot()
    expect(getSwitchFlushTimeoutMs()).toBe(50)

    const started = Date.now()
    await ensureRootStore(rootB)
    // 挂起磁盘场景下不再永久阻塞（退出路径 5s 底线的切库对等物）
    expect(Date.now() - started).toBeLessThan(2000)
    expect(getCurrentRoot()).toBe(rootB)

    // 放弃落盘语义：旧根 store.json 不含未落盘修改（写入挂起未落地）
    await expect(
      fsp.readFile(path.join(rootA, '.modelvault', 'store.json'), 'utf-8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    // 新根未被旧根数据污染：无快照文件
    await expect(
      fsp.readFile(path.join(rootB, '.modelvault', 'store.json'), 'utf-8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    // 挂起的写入目标路径全部固定在旧根（路径不随切根漂移）
    expect(awHook.hungPaths.length).toBeGreaterThan(0)
    expect(
      awHook.hungPaths.every((f) =>
        f.startsWith(path.join(rootA, '.modelvault')),
      ),
    ).toBe(true)
  })

  it('迟到的 flush 残尾完成后续跑不污染新根（同根守卫收尾）', async () => {
    const { rootB } = await setupHangOnOldRoot()
    await ensureRootStore(rootB)
    expect(metaState.hasSnapshot).toBe(false) // 新根空库，无快照基线

    // 模拟磁盘恢复：挂起的旧根写入完成——同根守卫必须跳过收尾段，
    // 否则 hasSnapshot/日志清理会作用到新根（其增量日志刚被 loadData 回放）
    awHook.hangPrefix = null
    for (const p of awHook.pending.splice(0)) p.resolve()
    expect(await waitForIdle()).toBe(true)

    expect(getCurrentRoot()).toBe(rootB)
    expect(metaState.hasSnapshot).toBe(false)
    // 新根 store.json 仍不存在：迟到的写入没有落进新根目录
    await expect(
      fsp.readFile(path.join(rootB, '.modelvault', 'store.json'), 'utf-8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('flushStoreSaveBounded：写盘挂起时超时返回 false 而非永久悬挂（B3）', async () => {
    const { rootA } = await setupHangOnOldRoot()
    setFlushAwaitTimeoutForTests(50)

    const started = Date.now()
    const settled = await flushStoreSaveBounded()
    expect(settled).toBe(false)
    // 挂起磁盘场景下按注入上限返回，不再永久阻塞持锁调用方
    expect(Date.now() - started).toBeLessThan(2000)
    // 超时只是放弃等待：挂起的写入仍在途（未被取消/截断）
    expect(awHook.pending.length).toBeGreaterThan(0)

    // 超时路径验证完毕：恢复生产默认等待上限。50ms 注入只用于上面的
    // 超时断言，若继续沿用到下方「真实落盘」的等待，CI 慢盘上会误报未静止
    setFlushAwaitTimeoutForTests()

    // 磁盘恢复：放行后续写入，reject 挂起的残尾（失败路径不清脏标记）
    awHook.hangPrefix = null
    for (const p of awHook.pending.splice(0)) p.reject(new Error('磁盘恢复'))
    expect(await waitForIdle()).toBe(true)
    // 后续 flush 真实落盘：脏数据完整写入（无覆盖/截断）
    expect(await flushStoreSaveBounded()).toBe(true)
    const store = JSON.parse(
      await fsp.readFile(
        path.join(rootA, '.modelvault', 'store.json'),
        'utf-8',
      ),
    )
    expect(store.models['a.safetensors'].alias).toBe('旧根未落盘')
  })

  it('flushStoreSaveBounded：无待落盘内容时立即返回 true（快进路径）', async () => {
    const rootA = await fsp.mkdtemp(path.join(os.tmpdir(), 'modelvault-fl-a-'))
    tmpRoots.push(rootA)
    await ensureRootStore(rootA)
    await flushStoreSaveBounded()
    setFlushAwaitTimeoutForTests(50)
    await expect(flushStoreSaveBounded()).resolves.toBe(true)
  })
})
