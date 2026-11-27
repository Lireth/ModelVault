import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fakeUserData } from './setup'
import logger from '../src/main/logger'
import {
  buildLibraryOverview,
  collectLibraryOverview,
  normalizeLibraryRoots,
} from '../src/main/services/library-overview'
import { writeLibraryIndex } from '../src/main/services/library-index'
import {
  loadData,
  setDataRoot,
  updateSettings,
} from '../src/main/services/store'

/**
 * 跨库存储总览（FN-01）：
 * 纯函数测试覆盖 —— 跨库分组、库内重复计数、容量未知回退、索引过期标记；
 * collectLibraryOverview 集成覆盖 —— 索引/元数据回退读取、越界键过滤、
 * 损坏数据静默降级、四类告警文案。
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

const ROOT_A = path.join(os.tmpdir(), 'mv-overview-a')
const ROOT_B = path.join(os.tmpdir(), 'mv-overview-b')

function entry(root, rel, hash, size = 0) {
  return {
    absPath: path.join(root, rel),
    relPath: rel,
    name: path.basename(rel),
    size,
    hash,
  }
}

function library(root, models, overrides = {}) {
  return {
    root,
    name: path.basename(root),
    exists: true,
    source: 'index',
    savedAt: Date.now(),
    models,
    ...overrides,
  }
}

describe('normalizeLibraryRoots', () => {
  it('去空、去重（Windows 大小写不敏感）并保持顺序', () => {
    const lower = ROOT_A.toLowerCase()
    expect(normalizeLibraryRoots([ROOT_A, lower, '', null, ROOT_B])).toEqual([
      ROOT_A,
      ROOT_B,
    ])
  })
})

describe('buildLibraryOverview', () => {
  it('跨库同哈希聚合：副本数、可释放空间与库内统计', () => {
    const overview = buildLibraryOverview([
      library(ROOT_A, [
        entry(ROOT_A, 'a.safetensors', 'h1', 100),
        entry(ROOT_A, 'b.safetensors', 'h2', 50),
      ]),
      library(ROOT_B, [entry(ROOT_B, 'c.safetensors', 'h1', 100)]),
    ])

    expect(overview.totals.libraries).toBe(2)
    expect(overview.totals.availableLibraries).toBe(2)
    expect(overview.totals.models).toBe(3)
    expect(overview.totals.knownBytes).toBe(250)
    expect(overview.totals.crossGroups).toBe(1)
    expect(overview.totals.redundantCopies).toBe(1)
    expect(overview.totals.wastedBytes).toBe(100)
    expect(overview.crossLibraryGroups[0].libraries).toBe(2)
    expect(overview.crossLibraryGroups[0].members).toHaveLength(2)
    for (const lib of overview.libraries)
      expect(lib.localDuplicateGroups).toBe(0)
  })

  it('仅库内重复不进入跨库组，但计数用于指引现有「重复」筛选', () => {
    const overview = buildLibraryOverview([
      library(ROOT_A, [
        entry(ROOT_A, 'x.safetensors', 'local', 10),
        entry(ROOT_A, 'y.safetensors', 'local', 10),
      ]),
    ])
    expect(overview.totals.crossGroups).toBe(0)
    expect(overview.libraries[0].localDuplicateGroups).toBe(1)
    expect(overview.totals.redundantCopies).toBe(0)
  })

  it('元数据回退（size=0）时标记容量未知，仍统计副本数', () => {
    const overview = buildLibraryOverview([
      library(ROOT_A, [entry(ROOT_A, 'a.safetensors', 'h', 0)], {
        source: 'store',
      }),
      library(ROOT_B, [entry(ROOT_B, 'b.safetensors', 'h', 0)], {
        source: 'store',
      }),
    ])
    expect(overview.totals.crossGroups).toBe(1)
    expect(overview.totals.redundantCopies).toBe(1)
    expect(overview.totals.wastedBytes).toBe(0)
    expect(overview.totals.unknownSizeGroups).toBe(1)
    expect(overview.crossLibraryGroups[0].sizeKnown).toBe(false)
  })

  it('索引超过 7 天标记 staleIndex', () => {
    const now = Date.now()
    const overview = buildLibraryOverview(
      [library(ROOT_A, [], { savedAt: now - 8 * 24 * 3600 * 1000 })],
      now,
    )
    expect(overview.libraries[0].staleIndex).toBe(true)
  })

  it('同一库内重复路径（异常索引）只计一次', () => {
    const duplicate = entry(ROOT_A, 'one.safetensors', 'h1', 100)
    const overview = buildLibraryOverview([
      library(ROOT_A, [duplicate, { ...duplicate }]),
      library(ROOT_B, [entry(ROOT_B, 'two.safetensors', 'h1', 100)]),
    ])
    expect(overview.totals.crossGroups).toBe(1)
    expect(overview.crossLibraryGroups[0].copies).toBe(2)
  })
})

describe('collectLibraryOverview 集成（只读聚合与回退）', () => {
  const roots = []
  let rootA
  let rootB
  const ghost = path.join(os.tmpdir(), 'modelvault-ov-ghost-nonexistent')

  beforeEach(async () => {
    rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-ov-a-'))
    rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-ov-b-'))
    roots.push(rootA, rootB)
    setDataRoot(rootA)
    await loadData()
    await updateSettings({
      modelsFolder: rootA,
      modelsFolders: [rootA, rootB, ghost],
    })
  })

  afterAll(async () => {
    for (const dir of roots) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  /** 直接写某库的 store.json（模拟索引缺失时的元数据回退来源） */
  async function writeStoreJson(root, models) {
    await fs.mkdir(path.join(root, '.modelvault'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.modelvault', 'store.json'),
      JSON.stringify({ models }),
    )
  }
  const libOf = (overview, root) =>
    overview.libraries.find((l) => l.root === root)

  it('索引 + 元数据回退：跨库聚合、来源标注、越界键过滤与告警', async () => {
    await writeLibraryIndex(rootA, {
      models: [
        {
          id: path.join(rootA, 'a1.safetensors'),
          name: 'a1.safetensors',
          type: 'lora',
          size: 100,
          mtimeMs: 1,
          hash: 'h1',
        },
        {
          id: path.join(rootA, 'sub', 'a2.safetensors'),
          name: 'a2.safetensors',
          type: 'lora',
          size: 50,
          mtimeMs: 1,
        },
      ],
    })
    await writeStoreJson(rootB, {
      'b1.safetensors': { hash: 'h1' },
      'sub\\b2.safetensors': { hash: 'h2' },
      '../escape.safetensors': { hash: 'hX' },
      '/abs.safetensors': { hash: 'hY' },
    })

    const { overview, warnings } = await collectLibraryOverview()
    // 激活根与列表去重后共 3 库（ghost 不可访问）
    expect(overview.totals.libraries).toBe(3)
    expect(overview.totals.availableLibraries).toBe(2)

    const libA = libOf(overview, rootA)
    expect(libA.source).toBe('index')
    expect(libA.models).toBe(2)
    expect(libA.totalBytes).toBe(150)
    expect(libA.hashedModels).toBe(1)
    expect(libA.staleIndex).toBe(false)

    const libB = libOf(overview, rootB)
    expect(libB.source).toBe('store')
    // 越界相对键与绝对键被过滤，反斜杠键归一为 POSIX 相对路径
    expect(libB.models).toBe(2)
    expect(libB.totalBytes).toBe(0)

    const group = overview.crossLibraryGroups.find((g) => g.hash === 'h1')
    expect(group.copies).toBe(2)
    expect(group.sizeBytes).toBe(100)
    expect(group.wastedBytes).toBe(100)
    const memberB = group.members.find((m) => m.relPath === 'b1.safetensors')
    expect(memberB).toBeTruthy()
    const memberA = group.members.find((m) => m.relPath === 'a1.safetensors')
    expect(memberA.relPath).toBe('a1.safetensors')

    expect(warnings.some((w) => w.includes('库目录不可访问，已跳过统计'))).toBe(
      true,
    )
    expect(
      warnings.some((w) => w.includes('未找到本地索引，已使用元数据统计')),
    ).toBe(true)
  })

  it('异常索引记录防御：库外路径回退文件名、非数值 size 归零', async () => {
    await writeLibraryIndex(rootA, {
      models: [
        {
          id: path.join(os.tmpdir(), 'elsewhere', 'x.safetensors'),
          name: 'x.safetensors',
          type: 'lora',
          size: 5,
          mtimeMs: 1,
          hash: 'hx',
        },
        {
          id: path.join(rootA, 'y.safetensors'),
          name: 'y.safetensors',
          type: 'lora',
          size: 'big',
          mtimeMs: 1,
        },
      ],
    })
    // rootB 同哈希成员：使库外记录进入重复组以断言 relPath 回退
    await writeStoreJson(rootB, { 'x-copy.safetensors': { hash: 'hx' } })
    const { overview } = await collectLibraryOverview()
    const libA = libOf(overview, rootA)
    expect(libA.models).toBe(2)
    // size 'big' 非有限数 → 0；仅 x 计入已知容量
    expect(libA.sizeKnownModels).toBe(1)
    expect(libA.totalBytes).toBe(5)
    const group = overview.crossLibraryGroups.find((g) => g.hash === 'hx')
    // 库外 id：relativeWithin 不命中 → relPath 回退文件名
    expect(group.members.find((m) => m.root === rootA).relPath).toBe(
      'x.safetensors',
    )
  })

  it('索引超过 7 天：staleIndex 标记并汇入告警', async () => {
    await writeLibraryIndex(rootA, { models: [] })
    const file = path.join(rootA, '.modelvault', 'index.json')
    const raw = JSON.parse(await fs.readFile(file, 'utf-8'))
    raw.savedAt = Date.now() - 8 * 24 * 3600 * 1000
    await fs.writeFile(file, JSON.stringify(raw))

    const { overview, warnings } = await collectLibraryOverview()
    expect(libOf(overview, rootA).staleIndex).toBe(true)
    expect(warnings.some((w) => w.includes('超过 7 天未更新'))).toBe(true)
  })

  it('损坏/非法形态的元数据与缺失数据逐库降级为 none', async () => {
    // rootA：store.json 非法 JSON（catch 告警后按缺失处理）
    await fs.mkdir(path.join(rootA, '.modelvault'), { recursive: true })
    await fs.writeFile(path.join(rootA, '.modelvault', 'store.json'), '{broken')
    // rootB：store.json 的 models 为数组（形态非法）
    await fs.mkdir(path.join(rootB, '.modelvault'), { recursive: true })
    await fs.writeFile(
      path.join(rootB, '.modelvault', 'store.json'),
      JSON.stringify({ models: [] }),
    )
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const { overview, warnings } = await collectLibraryOverview()
      expect(libOf(overview, rootA).source).toBe('none')
      expect(libOf(overview, rootB).source).toBe('none')
      expect(libOf(overview, ghost).source).toBe('none')
      expect(
        warnings.filter((w) => w.includes('库内缺少本地索引与元数据')).length,
      ).toBe(2)
      expect(
        warnings.some((w) => w.includes('库目录不可访问，已跳过统计')),
      ).toBe(true)
      // 非法 JSON 走 catch 留痕；ENOENT（无文件）静默
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('跨库总览读取元数据失败'),
      )
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('store.json 不是文件（目录占位）时按缺失降级', async () => {
    await fs.mkdir(path.join(rootB, '.modelvault', 'store.json'), {
      recursive: true,
    })
    const { overview } = await collectLibraryOverview()
    expect(libOf(overview, rootB).source).toBe('none')
  })

  it('全部成员容量未知的跨库重复组：统计副本数并告警', async () => {
    await writeStoreJson(rootA, { 'a.safetensors': { hash: 'hz' } })
    await writeStoreJson(rootB, { 'b.safetensors': { hash: 'hz' } })
    const { overview, warnings } = await collectLibraryOverview()
    expect(overview.totals.unknownSizeGroups).toBe(1)
    expect(overview.totals.crossGroups).toBe(1)
    expect(overview.totals.wastedBytes).toBe(0)
    expect(warnings.some((w) => w.includes('容量未知'))).toBe(true)
  })

  it('未发现跨库重复时提示使用库内「重复」筛选', async () => {
    await writeLibraryIndex(rootA, {
      models: [
        {
          id: path.join(rootA, 'only.safetensors'),
          name: 'only.safetensors',
          type: 'lora',
          size: 10,
          mtimeMs: 1,
          hash: 'solo',
        },
      ],
    })
    const { overview, warnings } = await collectLibraryOverview()
    expect(overview.totals.crossGroups).toBe(0)
    expect(warnings.some((w) => w.includes('未发现跨库重复模型'))).toBe(true)
  })
})
