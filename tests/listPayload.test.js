import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { fakeUserData } from './setup'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 列表通道载荷瘦身与详情按需拉取（OPT-PAYLOAD）特征测试：
 * - slimModelsForList：四条列表通道共用 IPC 边界瘦身的字段契约（详情消费面
 *   字段剔除、搜索/统计消费面字段保留）；
 * - models:getDetail：瘦身字段的补全通道（索引兜底 / 装饰缓存命中、store-meta
 *   覆盖与封面列表重建）。
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

// 避免真实轮询定时器进入测试
vi.mock('../src/main/services/watcher', () => ({
  syncWatcher: vi.fn(),
  stopWatcher: vi.fn(),
}))

vi.mock('../src/main/services/civitai', async (importOriginal) => ({
  ...(await importOriginal()),
  computeFileHash: vi.fn(),
}))

import { registerStoreHandlers } from '../src/main/ipc/models/store'
import {
  slimModelForList,
  slimModelsForList,
  logPayloadSize,
} from '../src/main/ipc/models/list-payload'
import { decorateCache } from '../src/main/ipc/models/model-state'
import { setModelMeta } from '../src/main/services/store'
import { getRegisteredHandler, makeEvent } from './helpers/modelsIpc'
import logger from '../src/main/logger'

/** 构造完整装饰模型（覆盖瘦身目标字段与刻意保留字段） */
function makeFullModel(root, name = 'a.safetensors') {
  const id = path.join(root, name)
  const coverRel = '.modelvault/covers/1.png'
  return {
    id,
    name: 'a',
    ext: '.safetensors',
    disabled: false,
    type: 'checkpoint',
    folderSubCategory: 'base',
    relDir: '',
    size: 123456,
    mtimeMs: 1000,
    ctimeMs: 1000,
    cover: path.join(root, '.modelvault', 'covers', '1.png'),
    coverUrl: `mvimg://local/${encodeURIComponent(path.join(root, '.modelvault', 'covers', '1.png'))}`,
    covers: [
      {
        rel: coverRel,
        path: path.join(root, '.modelvault', 'covers', '1.png'),
        url: `mvimg://local/${encodeURIComponent(path.join(root, '.modelvault', 'covers', '1.png'))}`,
        thumbPath: path.join(root, '.modelvault', 'thumbs', '1.jpg'),
        thumbUrl: `mvimg://local/${encodeURIComponent(path.join(root, '.modelvault', 'thumbs', '1.jpg'))}`,
      },
    ],
    hasManualCover: true,
    alias: '别名',
    note: '备注',
    noteSource: 'sidecar',
    favorite: false,
    nsfw: false,
    rating: 0,
    params: { steps: 20, sampler: 'euler' },
    tags: ['风格'],
    triggerWords: 'trigger',
    triggerWordsSource: 'civitai',
    subCategory: 'base',
    hash: 'f'.repeat(64),
    civitaiUrl: 'https://civitai.com/models/1',
    baseModel: 'SDXL 1.0',
    suspect: false,
    autoInfo: {
      title: '标题',
      author: '作者',
      baseModel: 'SDXL 1.0',
      triggerCandidates: ['候选词'],
      networkModule: 'LoRA',
      networkAlpha: 8,
      precision: 'FP16',
      resMin: 1024,
      resMax: 1024,
      expectedMinBytes: 1,
      tensorStats: { tensorCount: 1, paramCount: 2, dtypeMain: 'F16' },
    },
  }
}

describe('slimModelForList（列表瘦身字段契约）', () => {
  it('剔除详情消费面字段：covers url/thumbUrl、autoInfo 详情字段、folderSubCategory', () => {
    const m = makeFullModel('D:\\lib')
    const out = slimModelForList(m)
    expect(out.covers[0]).toEqual({
      rel: m.covers[0].rel,
      path: m.covers[0].path,
      thumbPath: m.covers[0].thumbPath,
    })
    expect(out.autoInfo).toEqual({
      title: '标题',
      author: '作者',
      baseModel: 'SDXL 1.0',
      triggerCandidates: ['候选词'],
    })
    expect('folderSubCategory' in out).toBe(false)
  })

  it('保留搜索/统计/导出消费面字段（note/triggerWords/params/tags/hash 等）', () => {
    const m = makeFullModel('D:\\lib')
    const out = slimModelForList(m)
    expect(out.note).toBe('备注')
    expect(out.triggerWords).toBe('trigger')
    expect(out.params).toEqual({ steps: 20, sampler: 'euler' })
    expect(out.tags).toEqual(['风格'])
    expect(out.hash).toBe(m.hash)
    expect(out.baseModel).toBe('SDXL 1.0')
    expect(out.civitaiUrl).toBe(m.civitaiUrl)
    expect(out.relDir).toBe('')
    expect(out.size).toBe(m.size)
    expect(out.triggerWordsSource).toBe('civitai')
  })

  it('不修改入参（瘦身发生在 IPC 边界，装饰缓存/索引仍持完整对象）', () => {
    const m = makeFullModel('D:\\lib')
    slimModelForList(m)
    expect('folderSubCategory' in m).toBe(true)
    expect(m.covers[0].url).toBeTruthy()
    expect(m.autoInfo.tensorStats).toBeTruthy()
  })

  it('容错：无 covers/autoInfo 的条目原样通过（旧索引/手工构造）', () => {
    const out = slimModelForList({ id: 'x', name: 'x', type: 'lora' })
    expect(out.id).toBe('x')
    expect('autoInfo' in out).toBe(false)
    expect('covers' in out).toBe(false)
  })

  it('slimModelsForList 返回估算体积；logPayloadSize 按体积分级输出', () => {
    const { models, approxBytes } = slimModelsForList([
      makeFullModel('D:\\lib'),
    ])
    expect(models).toHaveLength(1)
    expect(approxBytes).toBeGreaterThan(0)
    const spy = vi.spyOn(logger, 'info').mockImplementation(() => {})
    logPayloadSize('test:channel', approxBytes)
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('[perf] test:channel 列表载荷约'),
    )
    spy.mockRestore()
  })
})

describe('models:getDetail（详情按需补全通道）', () => {
  const tmpRoots = []

  function writeSettings(root, patch = {}) {
    fs.writeFileSync(
      path.join(fakeUserData, 'settings.json'),
      JSON.stringify({
        modelsFolder: root,
        modelsFolders: [root],
        autoScan: false,
        autoRescan: false,
        hashWarmup: 'off',
        ...patch,
      }),
    )
    return root
  }

  function writeIndex(root, models = []) {
    const dir = path.join(root, '.modelvault')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'index.json'),
      JSON.stringify({ version: 1, root, savedAt: 1, durationMs: 42, models }),
    )
  }

  beforeEach(() => {
    decorateCache.clear()
    registerStoreHandlers()
  })

  afterAll(() => {
    for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('当前根未设置时拒绝（checkModelIdInRoot 门禁）', async () => {
    fs.writeFileSync(
      path.join(fakeUserData, 'settings.json'),
      JSON.stringify({ modelsFolder: '', modelsFolders: [] }),
    )
    const handler = getRegisteredHandler('models:getDetail')
    const res = await handler(makeEvent(), { id: 'D:\\any\\x.safetensors' })
    expect(res.error).toBe('模型不在当前根目录内')
  })

  it('索引兜底：返回完整 autoInfo/封面 URL 形状，且以 store-meta 覆盖标注与封面列表', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-detail-'))
    tmpRoots.push(root)
    writeSettings(root)
    const full = makeFullModel(root)
    writeIndex(root, [full])
    const loadStore = getRegisteredHandler('models:loadStore')
    await loadStore(makeEvent())

    // store-meta：新增第二张封面 + 切换默认封面 + 收藏（快照 rel 集合因此分歧）
    setModelMeta(full.id, {
      covers: ['.modelvault/covers/1.png', '.modelvault/covers/2.png'],
      cover: '.modelvault/covers/2.png',
      favorite: true,
      rating: 4,
    })

    const handler = getRegisteredHandler('models:getDetail')
    const res = await handler(makeEvent(), { id: full.id })
    expect(res.error).toBeUndefined()
    const m = res.model
    // 详情消费面字段完整（索引兜底保留全文）
    expect(m.autoInfo.tensorStats).toBeTruthy()
    expect(m.autoInfo.networkModule).toBe('LoRA')
    // 封面列表按当前 meta 重建：新增条目以路径解析构造，URL 由主进程补齐
    expect(m.covers).toHaveLength(2)
    expect(m.covers[0].url).toContain('mvimg://')
    expect(m.covers[1].path).toBe(
      path.join(root, '.modelvault', 'covers', '2.png'),
    )
    expect(m.covers[1].url).toContain('mvimg://')
    // 默认封面随 meta.cover 切换；标注三元组随 meta 覆盖
    expect(m.cover).toBe(m.covers[1].path)
    expect(m.favorite).toBe(true)
    expect(m.rating).toBe(4)
    // 原索引对象不被修改（瘦身/覆盖发生在响应构造层）
    expect(m.autoInfo).not.toBe(full.autoInfo)
  })

  it('装饰缓存命中：优先于索引兜底；meta 仅改默认封面时 rel 集合不变、快照条目沿用', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-detail-'))
    tmpRoots.push(root)
    writeSettings(root)
    const full = makeFullModel(root)
    writeIndex(root, [{ ...full, note: '索引里的旧备注' }])
    await getRegisteredHandler('models:loadStore')(makeEvent())

    decorateCache.set(full.id, {
      mtimeMs: full.mtimeMs,
      signature: 'sig',
      thumbPath: full.covers[0].thumbPath,
      deferredCover: '',
      sidecarFacts: '',
      decorated: {
        ...full,
        note: '缓存里的新备注',
        autoInfo: { ...full.autoInfo, networkModule: 'LoRA-FromCache' },
      },
    })
    setModelMeta(full.id, {
      covers: ['.modelvault/covers/1.png'],
      cover: '.modelvault/covers/1.png',
      note: '当前备注',
    })

    const handler = getRegisteredHandler('models:getDetail')
    const res = await handler(makeEvent(), { id: full.id })
    const m = res.model
    // 装饰缓存优先于索引（autoInfo 详情字段取缓存值而非索引值）
    expect(m.autoInfo.networkModule).toBe('LoRA-FromCache')
    // 标注字段以当前 store-meta 为权威（metaDisplayFields 覆盖）
    expect(m.note).toBe('当前备注')
    // rel 集合一致：快照条目沿用（保留 thumbPath），URL 形状完整
    expect(m.covers[0]).toEqual(full.covers[0])
    expect(m.cover).toBe(full.covers[0].path)
  })

  it('缓存与索引均未命中时返回可识别错误', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-detail-'))
    tmpRoots.push(root)
    writeSettings(root)
    writeIndex(root, [])
    await getRegisteredHandler('models:loadStore')(makeEvent())
    const handler = getRegisteredHandler('models:getDetail')
    const res = await handler(makeEvent(), {
      id: path.join(root, 'missing.safetensors'),
    })
    expect(res.error).toContain('模型不在当前库索引中')
  })
})

describe('models:loadStore / openLibrary 响应瘦身（列表通道契约）', () => {
  const tmpRoots = []

  function writeSettings(root) {
    fs.writeFileSync(
      path.join(fakeUserData, 'settings.json'),
      JSON.stringify({
        modelsFolder: root,
        modelsFolders: [root],
        autoScan: false,
        autoRescan: false,
        hashWarmup: 'off',
      }),
    )
    return root
  }

  function writeIndex(root, models = []) {
    const dir = path.join(root, '.modelvault')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'index.json'),
      JSON.stringify({ version: 1, root, savedAt: 1, durationMs: 42, models }),
    )
  }

  beforeEach(() => {
    decorateCache.clear()
    registerStoreHandlers()
  })

  afterAll(() => {
    for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('loadStore 的 cachedIndex.models 为瘦身形状（先合成 meta 展示字段再剥离）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-slim-'))
    tmpRoots.push(root)
    writeSettings(root)
    const full = makeFullModel(root)
    writeIndex(root, [full])
    const loadStore = getRegisteredHandler('models:loadStore')
    // 首次调用建立根目录与关联存储（loadData 读盘），随后写入的 meta 常驻内存
    await loadStore(makeEvent())
    setModelMeta(full.id, { favorite: true })
    // 同根二次调用：ensureRootStore 早退不重载 metaState，覆盖对响应可见
    const res = await loadStore(makeEvent())
    const m = res.cachedIndex.models[0]
    // 详情消费面字段已剥离
    expect('folderSubCategory' in m).toBe(false)
    expect(m.covers[0].url).toBeUndefined()
    expect(m.covers[0].thumbUrl).toBeUndefined()
    expect(m.autoInfo.tensorStats).toBeUndefined()
    expect(m.autoInfo.triggerCandidates).toEqual(['候选词'])
    // meta 展示字段合成发生在剥离之前：标注以 meta 为权威（部分写入已将
    // note 重置为空，覆盖索引快照值），favorite 同步
    expect(m.favorite).toBe(true)
    expect(m.note).toBe('')
    // 搜索/统计消费面字段保留：params 随 meta 归一化覆盖（骨架形状），
    // 字段本身保留（列表参数列 formatParamSummary 消费）
    expect(m.params).toBeTypeOf('object')
    expect(m.hash).toBe(full.hash)
  })
})
