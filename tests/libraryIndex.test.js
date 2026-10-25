import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * 本地扫描索引（F1）：
 * - 写入/读取 roundtrip；
 * - root/version 不匹配、损坏、缺失时返回 null；
 * - 记录结构最低校验（坏记录剔除）。
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), isPackaged: true },
}))

import {
  INDEX_VERSION,
  flushIndexWrites,
  getQueuedIndexUpdateCountForTests,
  queueLibraryIndexUpdate,
  readLibraryIndex,
  resetIndexWriteStateForTests,
  setIndexWorkerThresholdForTests,
  updateLibraryIndex,
  writeLibraryIndex,
} from '../src/main/services/library-index'
import { resetJsonSerializerForTests } from '../src/main/services/json-serializer'

let root
const roots = []

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-index-'))
  roots.push(root)
})

afterEach(async () => {
  resetIndexWriteStateForTests()
  await resetJsonSerializerForTests()
  for (const dir of roots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

function model(id, extra = {}) {
  return {
    id: path.join(root, id),
    name: path.basename(id),
    type: 'lora',
    ext: '.safetensors',
    size: 1,
    mtimeMs: 1,
    relDir: '',
    ...extra,
  }
}

describe('library-index', () => {
  it('写入后可读取，root/savedAt/duration/models 完整往返', async () => {
    const models = [model('a.safetensors'), model('b.safetensors')]
    expect(await writeLibraryIndex(root, { models, durationMs: 123 })).toBe(
      true,
    )

    const cached = await readLibraryIndex(root)
    expect(cached.models).toEqual(models)
    expect(cached.durationMs).toBe(123)
    expect(cached.savedAt).toBeGreaterThan(0)
  })

  it('缺失索引返回 null', async () => {
    expect(await readLibraryIndex(root)).toBeNull()
  })

  it('root 不匹配 / 版本不匹配时返回 null', async () => {
    await writeLibraryIndex(root, { models: [model('a.safetensors')] })
    const file = path.join(root, '.modelvault', 'index.json')
    const raw = JSON.parse(await fs.readFile(file, 'utf-8'))

    await fs.writeFile(
      file,
      JSON.stringify({ ...raw, root: path.join(root, 'other') }),
    )
    expect(await readLibraryIndex(root)).toBeNull()

    await fs.writeFile(
      file,
      JSON.stringify({ ...raw, version: INDEX_VERSION + 1 }),
    )
    expect(await readLibraryIndex(root)).toBeNull()
  })

  it('损坏 JSON 与坏记录：整体返回 null / 坏记录被剔除', async () => {
    const file = path.join(root, '.modelvault', 'index.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{broken')
    expect(await readLibraryIndex(root)).toBeNull()

    await fs.writeFile(
      file,
      JSON.stringify({
        version: INDEX_VERSION,
        root,
        savedAt: 1,
        durationMs: 1,
        models: [model('ok.safetensors'), null, { id: '', name: 'x' }, 'bad'],
      }),
    )
    const cached = await readLibraryIndex(root)
    expect(cached.models).toHaveLength(1)
    expect(cached.models[0].name).toBe('ok.safetensors')
  })
})

describe('OPT-03 大库索引写盘降载', () => {
  it('内容未变化时跳过重复写盘（savedAt/durationMs 不参与指纹）', async () => {
    const models = [model('a.safetensors'), model('b.safetensors')]
    expect(await writeLibraryIndex(root, { models, durationMs: 123 })).toBe(
      true,
    )
    const file = path.join(root, '.modelvault', 'index.json')
    const first = JSON.parse(await fs.readFile(file, 'utf-8'))
    await new Promise((resolve) => setTimeout(resolve, 10))

    // 内容完全一致：即使扫描耗时不同也不重写
    expect(await writeLibraryIndex(root, { models, durationMs: 999 })).toBe(
      true,
    )
    const second = JSON.parse(await fs.readFile(file, 'utf-8'))
    expect(second.savedAt).toBe(first.savedAt)
    expect(second.durationMs).toBe(123)

    // 内容变化必须写盘
    models[0].size = 2
    expect(await writeLibraryIndex(root, { models, durationMs: 456 })).toBe(
      true,
    )
    const third = JSON.parse(await fs.readFile(file, 'utf-8'))
    expect(third.models[0].size).toBe(2)
    expect(third.savedAt).toBeGreaterThanOrEqual(first.savedAt)
  })

  it('索引文件被外部删除时即使指纹一致也重新写入', async () => {
    const models = [model('a.safetensors')]
    await writeLibraryIndex(root, { models })
    const file = path.join(root, '.modelvault', 'index.json')
    await fs.rm(file)
    expect(await writeLibraryIndex(root, { models })).toBe(true)
    await expect(fs.access(file)).resolves.toBeUndefined()
  })

  it('超过阈值时走 JSON worker 序列化路径', async () => {
    setIndexWorkerThresholdForTests(0)
    const models = [model('a.safetensors'), model('b.safetensors')]
    expect(await writeLibraryIndex(root, { models, durationMs: 7 })).toBe(true)
    const cached = await readLibraryIndex(root)
    expect(cached.models).toEqual(models)
    expect(cached.durationMs).toBe(7)
  })

  it('局部索引更新合并入队，flush 后一次应用全部变化', async () => {
    await writeLibraryIndex(root, { models: [model('a.safetensors')] })
    queueLibraryIndexUpdate(root, {
      upsertModels: [model('b.safetensors')],
    })
    queueLibraryIndexUpdate(root, {
      upsertModels: [model('c.safetensors')],
      removeIds: [path.join(root, 'a.safetensors')],
    })
    expect(getQueuedIndexUpdateCountForTests()).toBe(1)

    await flushIndexWrites()
    expect(getQueuedIndexUpdateCountForTests()).toBe(0)
    const cached = await readLibraryIndex(root)
    expect(cached.models.map((m) => m.name)).toEqual([
      'b.safetensors',
      'c.safetensors',
    ])
  })
})

describe('updateLibraryIndex（O8 增量维护）', () => {
  it('受影响子树内旧记录移除、incoming 更新、子树外保留；durationMs 不丢', async () => {
    await writeLibraryIndex(root, {
      models: [
        model('a.safetensors'),
        model('lora/old.safetensors', { relDir: 'lora' }),
        model('ckpt/keep.safetensors', { relDir: 'ckpt' }),
      ],
      durationMs: 99,
    })

    const ok = await updateLibraryIndex(root, {
      upsertModels: [model('lora/new.safetensors', { relDir: 'lora' })],
      affectedDirs: ['lora'],
    })

    expect(ok).toBe(true)
    const cached = await readLibraryIndex(root)
    const ids = cached.models.map((m) => path.basename(m.id))
    expect(ids).toContain('a.safetensors')
    expect(ids).toContain('ckpt/keep.safetensors'.split('/').pop())
    expect(ids).toContain('new.safetensors')
    expect(ids).not.toContain('old.safetensors')
    expect(cached.durationMs).toBe(99)
  })

  it('removeIds 精确移除（删除模型），大小写不敏感', async () => {
    const target = model('gone.safetensors')
    await writeLibraryIndex(root, {
      models: [target, model('keep.safetensors')],
    })

    expect(
      await updateLibraryIndex(root, { removeIds: [target.id.toUpperCase()] }),
    ).toBe(true)
    const cached = await readLibraryIndex(root)
    expect(cached.models.map((m) => m.name)).toEqual(['keep.safetensors'])
  })

  it('upsert 已存在 id 时以新记录替换，不产生重复条目', async () => {
    await writeLibraryIndex(root, {
      models: [model('a.safetensors', { size: 1 })],
    })

    await updateLibraryIndex(root, {
      upsertModels: [model('a.safetensors', { size: 2, note: '新记录' })],
    })

    const cached = await readLibraryIndex(root)
    expect(cached.models).toHaveLength(1)
    expect(cached.models[0]).toMatchObject({ size: 2, note: '新记录' })
  })

  it('索引缺失/损坏时跳过，不凭空创建不完整索引', async () => {
    expect(
      await updateLibraryIndex(root, {
        upsertModels: [model('a.safetensors')],
      }),
    ).toBe(false)
    await expect(
      fs.access(path.join(root, '.modelvault', 'index.json')),
    ).rejects.toThrow()

    const file = path.join(root, '.modelvault', 'index.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '{broken')
    expect(
      await updateLibraryIndex(root, {
        upsertModels: [model('a.safetensors')],
      }),
    ).toBe(false)
  })

  it('旧记录缺 relDir 时按 id 推导目录，仍能正确按子树清理', async () => {
    const legacy = model('lora/legacy.safetensors')
    delete legacy.relDir
    await writeLibraryIndex(root, { models: [legacy, model('a.safetensors')] })

    await updateLibraryIndex(root, { affectedDirs: ['lora'] })

    const cached = await readLibraryIndex(root)
    expect(cached.models.map((m) => path.basename(m.id))).toEqual([
      'a.safetensors',
    ])
  })

  it('并发增量更新经串行链合并，不丢失任一变更', async () => {
    await writeLibraryIndex(root, { models: [model('a.safetensors')] })

    await Promise.all([
      updateLibraryIndex(root, { upsertModels: [model('b.safetensors')] }),
      updateLibraryIndex(root, {
        removeIds: [path.join(root, 'a.safetensors')],
      }),
    ])

    const cached = await readLibraryIndex(root)
    expect(cached.models.map((m) => path.basename(m.id))).toEqual([
      'b.safetensors',
    ])
  })
})
