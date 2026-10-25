import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fakeUserData } from './setup'

/**
 * decorate.js 装饰管线单元测试（D2：IPC 层最大模块此前无直接测试）。
 * 依赖（thumbs/safetensors/scanner sidecar/协议 URL）均用真实实现 + 临时目录：
 * - 缩略图走 getThumbPathDeferred 未命中路径（返回 ''，登记后台任务，先用原图 URL）
 * - 元数据装饰合并（收藏/评分/别名/参数）与 checkpoint 自动基底分类
 * - 多封面校验：丢失的封面文件被过滤，默认封面回退 sidecar 预览图
 * - 增量装饰缓存：mtime 与元数据签名未变时复用结果对象
 * - 取消信号传播（AbortError）
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
}))

// 缩略图渲染（P2 改造后经隐藏渲染进程）在测试中打桩：
// 模拟「可缩放大图 → 返回 JPEG 字节」，使缩略图链路真实走完落盘路径
vi.mock('../src/main/services/thumb-renderer', () => ({
  renderThumbJpeg: vi.fn(),
  renderThumbFromPath: vi.fn(),
  destroyThumbRenderer: vi.fn(),
  setThumbRenderTimeoutForTests: vi.fn(),
}))

// scanner 侧 sidecar 纯函数保持真实实现；findSidecarText 单独可控，
// 用于在 await 间隙注入并发用户保存（E3 竞态回归）
vi.mock('../src/main/services/scanner.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, findSidecarText: vi.fn() }
})

import {
  computeDecorateCacheLimit,
  decorateModels,
  metaSignature,
  resolveCoverSafe,
  setDecorateCachePolicyForTests,
  startThumbDrain,
  clearDeferredOwners,
  trackDeferredOwner,
} from '../src/main/ipc/models/decorate'
import {
  awaitThumbDrain,
  decorateCache,
  getDecorateCacheLimit,
  getThumbDrainPromise,
  resetDecorateCache,
} from '../src/main/ipc/models/model-state'
import {
  loadData,
  setDataRoot,
  getModelMeta,
  setModelMeta,
  DATA_DIR,
  COVERS_DIR,
} from '../src/main/services/store'
import { findSidecarText } from '../src/main/services/scanner'
import { clearDeferredJobs } from '../src/main/services/thumbs'
import * as thumbsModule from '../src/main/services/thumbs'
import { renderThumbFromPath } from '../src/main/services/thumb-renderer'
import logger from '../src/main/logger'

const PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
])

let root
const roots = []

/** 构造扫描产出的模型对象（与 scanner.js 输出字段一致） */
function makeModel(id, overrides = {}) {
  return {
    id,
    name: path.basename(id, path.extname(id)),
    ext: path.extname(id),
    relDir: '',
    folder: root,
    type: 'checkpoint',
    size: 10,
    mtimeMs: 1000,
    ...overrides,
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-decorate-'))
  roots.push(root)
  setDataRoot(root)
  await loadData()
  setDecorateCachePolicyForTests()
  resetDecorateCache(root)
})

afterEach(async () => {
  setDecorateCachePolicyForTests()
  resetDecorateCache(null)
  for (const dir of roots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('decorateModels 元数据装饰', () => {
  it('合并元数据标注；checkpoint 未手动标注时自动标记基底模型', async () => {
    const abs = path.join(root, 'a.safetensors')
    await fs.writeFile(abs, 'x')
    setModelMeta(abs, {
      alias: '我的模型',
      note: '备注',
      favorite: true,
      nsfw: true,
      rating: 4,
      triggerWords: 'trigger-a',
      params: { steps: 28, cfgMin: 4, cfgMax: 12, sampler: 'euler' },
    })

    const [decorated] = await decorateModels([makeModel(abs)])
    expect(decorated.alias).toBe('我的模型')
    expect(decorated.note).toBe('备注')
    expect(decorated.favorite).toBe(true)
    expect(decorated.nsfw).toBe(true)
    expect(decorated.rating).toBe(4)
    expect(decorated.triggerWords).toBe('trigger-a')
    expect(decorated.params.steps).toBe(28)
    expect(decorated.subCategory).toBe('base')
    // 无封面且无 sidecar 预览图：cover 为空
    expect(decorated.cover).toBe('')
    expect(decorated.hasManualCover).toBe(false)
  })

  it('OPT-02：头部完好但数据区越过文件末尾时标记 suspect（截断检测）', async () => {
    // 头部声明数据区到 16 字节末尾，实际只写 4 字节数据——下载中断的典型形态
    const header = JSON.stringify({
      __metadata__: { 'modelspec.title': '截断模型' },
      'model.weight': { dtype: 'F32', shape: [2, 2], data_offsets: [0, 16] },
    })
    const lenBuf = Buffer.alloc(8)
    lenBuf.writeUInt32LE(Buffer.byteLength(header), 0)
    const abs = path.join(root, 'truncated.safetensors')
    await fs.writeFile(
      abs,
      Buffer.concat([lenBuf, Buffer.from(header), Buffer.alloc(4)]),
    )
    const stat = await fs.stat(abs)

    const [decorated] = await decorateModels([
      makeModel(abs, { size: stat.size, mtimeMs: stat.mtimeMs }),
    ])
    // 修复前：头部可解析 → 走成功路径，suspect 恒为 false（漏报）
    expect(decorated.suspect).toBe(true)
    // autoInfo 本身仍产出（头部完好），标题可读
    expect(decorated.autoInfo.title).toBe('截断模型')
  })

  it('OPT-02：数据区完整落在文件内时不误报 suspect', async () => {
    const header = JSON.stringify({
      'model.weight': { dtype: 'F32', shape: [2, 2], data_offsets: [0, 16] },
    })
    const lenBuf = Buffer.alloc(8)
    lenBuf.writeUInt32LE(Buffer.byteLength(header), 0)
    const abs = path.join(root, 'complete.safetensors')
    await fs.writeFile(
      abs,
      Buffer.concat([lenBuf, Buffer.from(header), Buffer.alloc(16)]),
    )
    const stat = await fs.stat(abs)

    const [decorated] = await decorateModels([
      makeModel(abs, { size: stat.size, mtimeMs: stat.mtimeMs }),
    ])
    // 8 + headerLen + 16 == 实际体积：恰好在边界内为健康
    expect(decorated.suspect).toBe(false)
    expect(decorated.autoInfo.expectedMinBytes).toBe(stat.size)
  })

  it('多封面校验：丢失文件被过滤，默认封面回退第一张有效封面', async () => {
    const abs = path.join(root, 'b.safetensors')
    await fs.writeFile(abs, 'x')
    const coversDir = path.join(root, DATA_DIR, COVERS_DIR)
    await fs.mkdir(coversDir, { recursive: true })
    const existsAbs = path.join(coversDir, 'exists.png')
    await fs.writeFile(existsAbs, PNG_MAGIC)
    setModelMeta(abs, {
      cover: `${DATA_DIR}/${COVERS_DIR}/exists.png`,
      covers: [
        `${DATA_DIR}/${COVERS_DIR}/exists.png`,
        `${DATA_DIR}/${COVERS_DIR}/gone.png`,
      ],
    })

    const [decorated] = await decorateModels([makeModel(abs)])
    // gone.png 不存在被过滤，仅保留有效封面
    expect(decorated.covers.map((c) => c.rel)).toEqual([
      `${DATA_DIR}/${COVERS_DIR}/exists.png`,
    ])
    expect(decorated.hasManualCover).toBe(true)
    // 缩略图未命中：登记后台任务，先用原图 URL
    expect(decorated.cover).toBe(existsAbs)
    expect(decorated.coverUrl).toContain('mvimg://local/')
    expect(decorated.thumbDeferred).toBeUndefined()
  })

  it('无元数据模型不产生封面，字段取安全默认值', async () => {
    const abs = path.join(root, 'c.ckpt')
    await fs.writeFile(abs, 'x')
    const [decorated] = await decorateModels([
      makeModel(abs, { type: 'other', ext: '.ckpt' }),
    ])
    expect(decorated.cover).toBe('')
    expect(decorated.favorite).toBe(false)
    expect(decorated.rating).toBe(0)
    expect(decorated.subCategory).toBe('')
    expect(decorated.autoInfo).toBeNull()
  })

  it('自动标签合成：lora 的文件夹标签优先于元数据标签', async () => {
    const abs = path.join(root, 'role-lora.safetensors')
    await fs.writeFile(abs, 'x')
    setModelMeta(abs, { subCategory: 'style' })
    const model = makeModel(abs, { type: 'lora', folderSubCategory: 'role' })
    const [decorated] = await decorateModels([model])
    expect(decorated.subCategory).toBe('role')
  })

  it('自动标签合成：lora 无文件夹标签时回退元数据标签（Civitai 分配结果保留）', async () => {
    const abs = path.join(root, 'style-lora.safetensors')
    await fs.writeFile(abs, 'x')
    setModelMeta(abs, { subCategory: 'style' })
    const model = makeModel(abs, { type: 'lora', folderSubCategory: '' })
    const [decorated] = await decorateModels([model])
    expect(decorated.subCategory).toBe('style')
  })

  it('自动标签合成：非 lora 类型忽略文件夹标签（checkpoint 仍自动 base）', async () => {
    const abs = path.join(root, 'ck.safetensors')
    await fs.writeFile(abs, 'x')
    const model = makeModel(abs, {
      type: 'checkpoint',
      folderSubCategory: 'role',
    })
    const [decorated] = await decorateModels([model])
    expect(decorated.subCategory).toBe('base')
  })

  it('增量缓存：mtime 与元数据签名未变时复用上次装饰结果', async () => {
    const abs = path.join(root, 'd.safetensors')
    await fs.writeFile(abs, 'x')
    setModelMeta(abs, { alias: '缓存命中' })
    const model = makeModel(abs)
    const [first] = await decorateModels([model])
    const [second] = await decorateModels([{ ...model }])
    // 同一对象引用：命中路径零文件 IO 直接复用
    expect(second).toBe(first)
    // 元数据变化后签名失效，重新装饰产生新对象
    setModelMeta(abs, { alias: '修改后' })
    const [third] = await decorateModels([{ ...model }])
    expect(third).not.toBe(first)
    expect(third.alias).toBe('修改后')
  })

  it('取消信号在批间生效：aborted 时抛出 AbortError', async () => {
    const abs = path.join(root, 'e.safetensors')
    await fs.writeFile(abs, 'x')
    const controller = new AbortController()
    controller.abort()
    await expect(
      decorateModels([makeModel(abs)], controller.signal),
    ).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('多批规模（>2×并发上限）下结果顺序与输入一致（流式池索引回填，P1-1）', async () => {
    // 150 超过原批模型的 2×64：流式池完成顺序不定（各模型 sidecar 探测/
    // 头部解析耗时不同），顺序只能由索引回填保证
    const models = []
    for (let i = 0; i < 150; i++) {
      const abs = path.join(
        root,
        `order-${String(i).padStart(3, '0')}.safetensors`,
      )
      await fs.writeFile(abs, 'x')
      models.push(makeModel(abs))
    }
    const decorated = await decorateModels(models)
    expect(decorated).toHaveLength(150)
    expect(decorated.map((m) => m.name)).toEqual(models.map((m) => m.name))
  })
})

describe('OPT-04 装饰缓存容量与生命周期', () => {
  it('容量策略：最小 8000、按模型数留 10% 余量、硬上限 50000', () => {
    expect(computeDecorateCacheLimit(0)).toBe(8000)
    expect(computeDecorateCacheLimit(100)).toBe(8000)
    expect(computeDecorateCacheLimit(9000)).toBe(9900)
    expect(computeDecorateCacheLimit(200000)).toBe(50000)
  })

  it('全量快照扩容缓存、清理已删除条目并按容量裁剪', async () => {
    setDecorateCachePolicyForTests({ min: 2, max: 10 })
    const models = []
    for (let i = 0; i < 6; i++) {
      const abs = path.join(root, `cache-${i}.safetensors`)
      await fs.writeFile(abs, 'x')
      models.push(makeModel(abs))
    }

    await decorateModels(models, undefined, { adaptCacheSize: true })
    // ceil(6 * 1.1) = 7：整库 6 条全部留在缓存
    expect(getDecorateCacheLimit()).toBe(7)
    expect(decorateCache.size).toBe(6)

    // 模拟库内 3 个文件被删除后的全量扫描：容量收敛到 4，陈旧条目清理
    await decorateModels(models.slice(0, 3), undefined, {
      adaptCacheSize: true,
    })
    expect(getDecorateCacheLimit()).toBe(4)
    expect(decorateCache.size).toBe(3)
    const ids = new Set(models.slice(0, 3).map((m) => m.id))
    expect([...decorateCache.keys()].every((id) => ids.has(id))).toBe(true)
  })

  it('模型数超过硬上限时按 LRU 保留不超过上限的条目', async () => {
    setDecorateCachePolicyForTests({ min: 2, max: 5 })
    const models = []
    for (let i = 0; i < 8; i++) {
      const abs = path.join(root, `cap-${i}.safetensors`)
      await fs.writeFile(abs, 'x')
      models.push(makeModel(abs))
    }
    await decorateModels(models, undefined, { adaptCacheSize: true })
    expect(getDecorateCacheLimit()).toBe(5)
    expect(decorateCache.size).toBe(5)
  })
})

describe('OPT-07 局部扫描缓存感知 sidecar/封面变化', () => {
  it('forceRefresh 重新读取新增 civitai.info sidecar（模型 mtime 未变）', async () => {
    const abs = path.join(root, 'late-info-lora.safetensors')
    await fs.writeFile(abs, 'x')
    const model = makeModel(abs, { type: 'lora' })
    const [first] = await decorateModels([model])
    expect(first.triggerWords).toBe('')

    // sidecar 新增不改变模型文件 mtime，默认缓存命中仍返回旧结果
    await fs.writeFile(
      path.join(root, 'late-info-lora.civitai.info'),
      JSON.stringify({ trainedWords: ['late-trigger'] }),
    )
    const [cached] = await decorateModels([{ ...model }])
    expect(cached.triggerWords).toBe('')

    // 局部扫描携带 forceRefresh：重新读取 sidecar 并导入触发词
    const [refreshed] = await decorateModels([{ ...model }], undefined, {
      forceRefresh: true,
    })
    expect(refreshed.triggerWords).toBe('late-trigger')
    expect(refreshed.triggerWordsSource).toBe('civitai')
  })

  it('forceRefresh 重新识别新增同名预览图（默认封面变化）', async () => {
    const abs = path.join(root, 'late-preview.safetensors')
    await fs.writeFile(abs, 'x')
    const model = makeModel(abs)
    const [first] = await decorateModels([model])
    expect(first.cover).toBe('')

    const preview = path.join(root, 'late-preview.png')
    await fs.writeFile(preview, PNG_MAGIC)
    const [cached] = await decorateModels([{ ...model }])
    expect(cached.cover).toBe('')

    const [refreshed] = await decorateModels([{ ...model }], undefined, {
      forceRefresh: true,
    })
    expect(refreshed.cover).toBe(preview)
    expect(refreshed.coverUrl).toContain('mvimg://local/')
  })
})

describe('sidecar 导入与用户并发保存的竞态（E3 回归）', () => {
  afterEach(() => {
    vi.mocked(findSidecarText).mockReset()
  })

  it('await 间隙内用户保存的字段不被 sidecar 写回覆盖', async () => {
    const abs = path.join(root, 'lora-race.ckpt')
    await fs.writeFile(abs, 'x')
    // sidecar 读取挂起，制造 importSidecarMeta 的读-写间隙
    let releaseSidecar
    vi.mocked(findSidecarText).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSidecar = () => resolve('自动导入的备注')
        }),
    )

    const pending = decorateModels([
      makeModel(abs, { type: 'lora', ext: '.ckpt' }),
    ])
    const deadline = Date.now() + 5000
    while (typeof releaseSidecar !== 'function' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(typeof releaseSidecar).toBe('function')

    // 间隙内模拟用户经 setMetaFlags 并发保存（同步读-改-写，即时落盘）
    setModelMeta(abs, { rating: 5, favorite: true })
    releaseSidecar()

    const [decorated] = await pending
    // sidecar 导入生效（基于重读后的最新 meta 计算）
    expect(decorated.note).toBe('自动导入的备注')
    expect(decorated.noteSource).toBe('sidecar')
    expect(decorated.triggerWords).toBe('自动导入的备注')
    // 用户并发保存的字段保留（旧实现基于 await 前的空 meta 展开写回而丢失）
    expect(decorated.rating).toBe(5)
    expect(decorated.favorite).toBe(true)
    const persisted = getModelMeta(abs)
    expect(persisted.rating).toBe(5)
    expect(persisted.favorite).toBe(true)
    expect(persisted.note).toBe('自动导入的备注')
    expect(persisted.noteSource).toBe('sidecar')
  })

  it('间隙内用户已填备注时，重读后不再导入 sidecar（用户编辑优先）', async () => {
    const abs = path.join(root, 'lora-race-user-note.ckpt')
    await fs.writeFile(abs, 'x')
    let releaseSidecar
    vi.mocked(findSidecarText).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSidecar = () => resolve('sidecar 全文')
        }),
    )

    const pending = decorateModels([
      makeModel(abs, { type: 'lora', ext: '.ckpt' }),
    ])
    const deadline = Date.now() + 5000
    while (typeof releaseSidecar !== 'function' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5))
    }
    // 间隙内用户保存了备注（saveModelData 语义：note + 清除来源标记）
    setModelMeta(abs, { note: '用户手写备注', noteSource: '' })
    releaseSidecar()

    await pending
    const persisted = getModelMeta(abs)
    expect(persisted.note).toBe('用户手写备注')
    expect(persisted.noteSource).toBe('')
  })
})

describe('resolveCoverSafe', () => {
  it('相对路径换算为绝对路径；非法输入容错返回空串', () => {
    const abs = path.join(root, DATA_DIR, COVERS_DIR, 'x.png')
    expect(resolveCoverSafe(`${DATA_DIR}/${COVERS_DIR}/x.png`)).toBe(abs)
    expect(resolveCoverSafe(null)).toBe('')
  })
})

describe('startThumbDrain 窗口生命周期（A7）', () => {
  // 前后用例可能往模块级队列登记了指向已删临时目录的陈旧任务，
  // 其 fs.stat 失败会产生「合法但与本用例无关」的失败警告，先清空再测
  beforeEach(() => {
    clearDeferredOwners()
    clearDeferredJobs()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** 准备一个缩略图未命中的模型：装饰阶段登记后台生成任务 */
  async function setupDeferredThumb() {
    const abs = path.join(root, 'with-cover.safetensors')
    await fs.writeFile(abs, 'x')
    const coversDir = path.join(root, DATA_DIR, COVERS_DIR)
    await fs.mkdir(coversDir, { recursive: true })
    await fs.writeFile(path.join(coversDir, 'cover.png'), PNG_MAGIC)
    setModelMeta(abs, { cover: `${DATA_DIR}/${COVERS_DIR}/cover.png` })
    // 缩略图渲染桩：模拟可缩放大图，使缩略图生成真实走完落盘路径
    vi.mocked(renderThumbFromPath).mockResolvedValue({
      jpeg: Buffer.from('fake-jpeg'),
    })
    const [decorated] = await decorateModels([makeModel(abs)])
    return { abs, decorated }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('扫描中窗口关闭（win 为 null）时 drain 正常完成：缓存更新且无误导性失败日志', async () => {
    const { decorated } = await setupDeferredThumb()
    // 未命中缓存：先用原图 URL
    const urlBefore = decorated.coverUrl
    expect(urlBefore).toContain('cover.png')
    const warnSpy = vi.spyOn(logger, 'warn')

    // win 为 null：模拟扫描进行中窗口被关闭（scan.js 经 fromWebContents 取得 null）
    startThumbDrain(null)
    await awaitThumbDrain()

    // drain 正常完成且装饰缓存已更新为缩略图 URL（下一轮扫描命中即显示缩略图）。
    // 未修复时：回调内 win.isDestroyed() 抛 TypeError，被 allSettled 吞掉并记为
    // 「后台缩略图生成失败」误导日志，推送中断但无人知晓
    // （toImageUrl 对路径做百分位编码，按编码中立的 'thumbs' 目录名断言）
    expect(decorated.coverUrl).toContain('thumbs')
    expect(decorated.coverUrl).not.toBe(urlBefore)
    const misleading = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('后台缩略图生成失败'),
    )
    expect(misleading).toHaveLength(0)
  })

  it('窗口存活时 drain 完成推送 thumbsReady 更新（回归护栏）', async () => {
    const { abs } = await setupDeferredThumb()
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }

    startThumbDrain(win)
    await awaitThumbDrain()

    // OPT-1：默认封面同时是 covers 条目，更新携带 coverUrl 与 coverThumb 双字段
    expect(win.webContents.send).toHaveBeenCalledWith('models:thumbsReady', {
      updates: [
        {
          id: abs,
          coverUrl: expect.stringContaining('thumbs'),
          coverThumb: {
            path: expect.any(String),
            thumbUrl: expect.stringContaining('thumbs'),
          },
        },
      ],
    })
  })

  it('上一轮 drain 未完成时新一轮排队等待：不并发执行，链尾才清登记（B5）', async () => {
    // spy 真实 drainDeferredThumbs：按调用序挂起，手动释放以控制时序
    const releases = []
    const drainSpy = vi
      .spyOn(thumbsModule, 'drainDeferredThumbs')
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            releases.push(() => resolve())
          }),
      )

    try {
      const win1 = { isDestroyed: () => false, webContents: { send: vi.fn() } }
      const win2 = { isDestroyed: () => false, webContents: { send: vi.fn() } }

      await setupDeferredThumb() // 登记任务 1
      startThumbDrain(win1) // 第一轮取走任务 1（drain 挂起中）
      // 第二轮的归属登记：第二模型不能走 setupDeferredThumb——同一模型会命中
      // 装饰缓存而不登记任何新任务，导致第二轮被 deferredOwners 空表短路
      trackDeferredOwner(
        path.join(root, 'second.safetensors'),
        path.join(root, 'second.png'),
      )
      startThumbDrain(win2) // 第二轮登记：必须排队，不得并发启动

      // 让出事件循环：排队实现的 spy 调用发生在微任务中。
      // 修复前：覆盖式登记使两轮并发执行（drain 内部现取 getThumbsDir()，
      // 切根窗口期会把旧根源图写进新根 thumbs 目录），此处已有 2 个调用
      await new Promise((resolve) => setImmediate(resolve))
      expect(releases).toHaveLength(1)

      releases[0]() // 放行第一轮
      await new Promise((resolve) => setImmediate(resolve))
      // 第一轮完成后第二轮才启动
      expect(releases).toHaveLength(2)

      releases[1]()
      await awaitThumbDrain()
      // 链尾正确清空登记（修复前旧轮的 finally 会把新轮 promise 误清为 null，
      // 使 awaitThumbDrain 的切根保护彻底失效）
      expect(getThumbDrainPromise()).toBeNull()
    } finally {
      drainSpy.mockRestore()
    }
  })
})

describe('健康检查与 civitai 自动导入（F6/F8 集成）', () => {
  /** 构造合法 safetensors 文件（可无 __metadata__） */
  async function writeSafetensors(abs, metadata) {
    const header = JSON.stringify({
      weight: { dtype: 'F16', shape: [1], data_offsets: [0, 2] },
      ...(metadata ? { __metadata__: metadata } : {}),
    })
    const lenBuf = Buffer.alloc(8)
    lenBuf.writeUInt32LE(Buffer.byteLength(header), 0)
    await fs.writeFile(
      abs,
      Buffer.concat([lenBuf, Buffer.from(header), Buffer.from([1, 2])]),
    )
  }

  it('0 字节与损坏 safetensors 标记 suspect；合法但无元信息的不标记（F6）', async () => {
    // 0 字节文件（任意扩展名）
    const empty = path.join(root, 'empty.ckpt')
    await fs.writeFile(empty, '')
    const [d0] = await decorateModels([
      makeModel(empty, { ext: '.ckpt', type: 'other', size: 0 }),
    ])
    expect(d0.suspect).toBe(true)

    // 损坏 safetensors（垃圾字节，头部不可解析）
    const broken = path.join(root, 'broken.safetensors')
    await fs.writeFile(
      broken,
      Buffer.from('garbage — not a safetensors container!!'),
    )
    const [d1] = await decorateModels([makeModel(broken)])
    expect(d1.suspect).toBe(true)
    expect(d1.autoInfo).toBeNull()

    // 合法但无 __metadata__：F-1 起返回仅含张量统计的 autoInfo，不标记 suspect
    // （结构合法；健康补检仅在解析失败时触发，此处装饰结果直接可用）。
    // OPT-02 起数据区比对依赖真实体积，须按 scanner 语义传真实 stat
    const healthy = path.join(root, 'healthy.safetensors')
    await writeSafetensors(healthy, null)
    const hs = await fs.stat(healthy)
    const [d2] = await decorateModels([
      makeModel(healthy, { size: hs.size, mtimeMs: hs.mtimeMs }),
    ])
    expect(d2.suspect).toBe(false)
    expect(d2.autoInfo).not.toBeNull()
    expect(d2.autoInfo.tensorStats).toMatchObject({ tensorCount: 1 })
  })

  it('civitai.info 的 trainedWords 与 nsfw 空字段自动导入（F8）', async () => {
    const abs = path.join(root, 'girl-lora.safetensors')
    await writeSafetensors(abs, null)
    await fs.writeFile(
      path.join(root, 'girl-lora.civitai.info'),
      JSON.stringify({
        name: 'Girl LoRA',
        trainedWords: ['cat-girl', 'masterpiece'],
        nsfw: true,
      }),
    )
    const [decorated] = await decorateModels([makeModel(abs, { type: 'lora' })])
    expect(decorated.triggerWords).toBe('cat-girl, masterpiece')
    expect(decorated.triggerWordsSource).toBe('civitai')
    expect(decorated.nsfw).toBe(true)

    // 已导入字段不被再次装饰覆盖（幂等；「空字段才写入」原则）
    const [again] = await decorateModels([makeModel(abs, { type: 'lora' })])
    expect(again.triggerWords).toBe('cat-girl, masterpiece')
  })

  it('civitai 导入不覆盖用户已有触发词（空字段才写入）', async () => {
    const abs = path.join(root, 'owned-lora.safetensors')
    await writeSafetensors(abs, null)
    await fs.writeFile(
      path.join(root, 'owned-lora.civitai.info'),
      JSON.stringify({ trainedWords: ['should-not-apply'] }),
    )
    setModelMeta(abs, { triggerWords: '用户已有' })
    const [decorated] = await decorateModels([makeModel(abs, { type: 'lora' })])
    expect(decorated.triggerWords).toBe('用户已有')
    expect(decorated.triggerWordsSource).toBe('')
  })
})

describe('OPT-1 轮播封面复用缩略图管线', () => {
  beforeEach(() => {
    clearDeferredOwners()
    clearDeferredJobs()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** 准备一个双封面模型（默认封面 c0），缩略图渲染桩允许缩略图真实落盘 */
  async function setupMultiCover() {
    const abs = path.join(root, 'multi.safetensors')
    await fs.writeFile(abs, 'x')
    const coversDir = path.join(root, DATA_DIR, COVERS_DIR)
    await fs.mkdir(coversDir, { recursive: true })
    const c0 = path.join(coversDir, 'c0.png')
    const c1 = path.join(coversDir, 'c1.png')
    await fs.writeFile(c0, PNG_MAGIC)
    await fs.writeFile(c1, PNG_MAGIC)
    setModelMeta(abs, {
      cover: `${DATA_DIR}/${COVERS_DIR}/c0.png`,
      covers: [
        `${DATA_DIR}/${COVERS_DIR}/c0.png`,
        `${DATA_DIR}/${COVERS_DIR}/c1.png`,
      ],
    })
    vi.mocked(renderThumbFromPath).mockResolvedValue({
      jpeg: Buffer.from('fake-jpeg'),
    })
    return { abs, c0, c1 }
  }

  it('装饰阶段为全部封面登记缩略图；drain 后回写 covers 条目并推送 coverThumb', async () => {
    const { abs, c0, c1 } = await setupMultiCover()
    const [decorated] = await decorateModels([makeModel(abs)])
    // 缩略图未命中：所有封面先用原图 URL，登记后台任务
    expect(decorated.covers.map((c) => c.thumbUrl)).toEqual(['', ''])
    expect(decorated.coverUrl).toContain('c0.png')

    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }
    startThumbDrain(win)
    await awaitThumbDrain()

    // drain 后：默认封面 coverUrl 与全部 covers 条目均回写缩略图 URL
    expect(decorated.coverUrl).toContain('thumbs')
    expect(decorated.covers.map((c) => c.thumbUrl)).toEqual([
      expect.stringContaining('thumbs'),
      expect.stringContaining('thumbs'),
    ])
    // O2：同一轮 drain 的两张缩略图完成事件合并为一次 thumbsReady 推送
    const readyCalls = win.webContents.send.mock.calls.filter(
      (c) => c[0] === 'models:thumbsReady',
    )
    expect(readyCalls).toHaveLength(1)
    // 推送载荷：默认封面条目 coverUrl + coverThumb 双字段；非默认仅 coverThumb
    const updates = readyCalls.flatMap((c) => c[1].updates)
    expect(updates).toHaveLength(2)
    const defaultUpdate = updates.find((u) => u.coverUrl)
    const carouselUpdate = updates.find((u) => !u.coverUrl)
    expect(defaultUpdate.id).toBe(abs)
    expect(defaultUpdate.coverThumb).toEqual({
      path: c0,
      thumbUrl: expect.any(String),
    })
    expect(carouselUpdate.id).toBe(abs)
    expect(carouselUpdate.coverUrl).toBe('')
    expect(carouselUpdate.coverThumb).toEqual({
      path: c1,
      thumbUrl: expect.any(String),
    })
  })

  it('缩略图生成后再次装饰命中缓存：thumbUrl 保留且缓存文件不被 prune 误删', async () => {
    const { abs } = await setupMultiCover()
    await decorateModels([makeModel(abs)])
    startThumbDrain(null)
    await awaitThumbDrain()

    // 二次装饰（mtime/签名未变）走缓存命中路径：保留 drain 回写的 thumbUrl
    const [cached] = await decorateModels([{ ...makeModel(abs) }])
    expect(cached.covers.every((c) => c.thumbUrl.includes('thumbs'))).toBe(true)
    // prune 名单必须包含全部封面缩略图（命中路径计入），文件仍然存在
    for (const c of cached.covers) {
      await expect(fs.access(c.thumbPath)).resolves.toBeUndefined()
    }
  })

  it('默认封面回退 sidecar 预览图时仍走既有 coverUrl 链路（不进 covers）', async () => {
    const abs = path.join(root, 'sidecar-default.safetensors')
    await fs.writeFile(abs, 'x')
    // 同名 sidecar 预览图（非 covers 成员）
    const sidecar = path.join(root, 'sidecar-default.png')
    await fs.writeFile(sidecar, PNG_MAGIC)
    vi.mocked(renderThumbFromPath).mockResolvedValue({
      jpeg: Buffer.from('fake-jpeg'),
    })

    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }
    const [decorated] = await decorateModels([makeModel(abs)])
    expect(decorated.covers).toEqual([])
    startThumbDrain(win)
    await awaitThumbDrain()
    expect(decorated.coverUrl).toContain('thumbs')
    // sidecar 默认封面不在 covers 列表内：更新仅含 coverUrl，无 coverThumb
    const updates = win.webContents.send.mock.calls
      .filter((c) => c[0] === 'models:thumbsReady')
      .flatMap((c) => c[1].updates)
    expect(updates).toHaveLength(1)
    expect(updates[0].coverUrl).toContain('thumbs')
    expect(updates[0].coverThumb).toBeUndefined()
  })
})

describe('metaSignature（装饰缓存签名，A-08 记忆化表征）', () => {
  function baseMeta(overrides = {}) {
    return {
      cover: '',
      covers: [],
      alias: '',
      note: '',
      subCategory: '',
      triggerWords: '',
      favorite: false,
      nsfw: false,
      rating: 0,
      params: { steps: 20 },
      hash: '',
      noteSource: '',
      triggerWordsSource: '',
      ...overrides,
    }
  }

  it('内容相同的独立对象签名一致（按值语义，缓存不得按引用返回不同结果）', () => {
    expect(metaSignature(baseMeta())).toBe(metaSignature(baseMeta()))
  })

  it('同一对象重复调用结果稳定', () => {
    const meta = baseMeta()
    const first = metaSignature(meta)
    expect(typeof first).toBe('string')
    expect(metaSignature(meta)).toBe(first)
  })

  it.each([
    ['cover', { cover: '.modelvault/covers/a.png' }],
    ['covers', { covers: ['a.png'] }],
    ['alias', { alias: '别名' }],
    ['note', { note: '备注' }],
    ['subCategory', { subCategory: 'role' }],
    ['triggerWords', { triggerWords: 'word' }],
    ['favorite', { favorite: true }],
    ['nsfw', { nsfw: true }],
    ['rating', { rating: 5 }],
    ['params', { params: { steps: 28 } }],
    ['hash', { hash: 'a'.repeat(64) }],
    ['noteSource', { noteSource: 'sidecar' }],
    ['triggerWordsSource', { triggerWordsSource: 'sidecar' }],
  ])('%s 变化时签名改变', (_key, overrides) => {
    expect(metaSignature(baseMeta(overrides))).not.toBe(
      metaSignature(baseMeta()),
    )
  })
})
