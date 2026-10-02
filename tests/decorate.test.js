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
  nativeImage: { createFromPath: vi.fn(), createFromBuffer: vi.fn() }
}))

import { decorateModels, resolveCoverSafe } from '../src/main/ipc/models/decorate'
import { loadData, setDataRoot, setModelMeta, DATA_DIR, COVERS_DIR } from '../src/main/services/store'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

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
    ...overrides
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-decorate-'))
  roots.push(root)
  setDataRoot(root)
  await loadData()
})

afterEach(async () => {
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
      params: { steps: 28, cfgMin: 4, cfgMax: 12, sampler: 'euler' }
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

  it('多封面校验：丢失文件被过滤，默认封面回退第一张有效封面', async () => {
    const abs = path.join(root, 'b.safetensors')
    await fs.writeFile(abs, 'x')
    const coversDir = path.join(root, DATA_DIR, COVERS_DIR)
    await fs.mkdir(coversDir, { recursive: true })
    const existsAbs = path.join(coversDir, 'exists.png')
    await fs.writeFile(existsAbs, PNG_MAGIC)
    setModelMeta(abs, {
      cover: `${DATA_DIR}/${COVERS_DIR}/exists.png`,
      covers: [`${DATA_DIR}/${COVERS_DIR}/exists.png`, `${DATA_DIR}/${COVERS_DIR}/gone.png`]
    })

    const [decorated] = await decorateModels([makeModel(abs)])
    // gone.png 不存在被过滤，仅保留有效封面
    expect(decorated.covers.map((c) => c.rel)).toEqual([`${DATA_DIR}/${COVERS_DIR}/exists.png`])
    expect(decorated.hasManualCover).toBe(true)
    // 缩略图未命中：登记后台任务，先用原图 URL
    expect(decorated.cover).toBe(existsAbs)
    expect(decorated.coverUrl).toContain('mvimg://local/')
    expect(decorated.thumbDeferred).toBeUndefined()
  })

  it('无元数据模型不产生封面，字段取安全默认值', async () => {
    const abs = path.join(root, 'c.ckpt')
    await fs.writeFile(abs, 'x')
    const [decorated] = await decorateModels([makeModel(abs, { type: 'other', ext: '.ckpt' })])
    expect(decorated.cover).toBe('')
    expect(decorated.favorite).toBe(false)
    expect(decorated.rating).toBe(0)
    expect(decorated.subCategory).toBe('')
    expect(decorated.autoInfo).toBeNull()
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
    await expect(decorateModels([makeModel(abs)], controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
  })
})

describe('resolveCoverSafe', () => {
  it('相对路径换算为绝对路径；非法输入容错返回空串', () => {
    const abs = path.join(root, DATA_DIR, COVERS_DIR, 'x.png')
    expect(resolveCoverSafe(`${DATA_DIR}/${COVERS_DIR}/x.png`)).toBe(abs)
    expect(resolveCoverSafe(null)).toBe('')
  })
})
