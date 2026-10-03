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

import { decorateModels, resolveCoverSafe, startThumbDrain, clearDeferredOwners } from '../src/main/ipc/models/decorate'
import { awaitThumbDrain } from '../src/main/ipc/models/model-state'
import { loadData, setDataRoot, setModelMeta, DATA_DIR, COVERS_DIR } from '../src/main/services/store'
import { clearDeferredJobs } from '../src/main/services/thumbs'
import { nativeImage } from 'electron'
import logger from '../src/main/logger'

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
    // nativeImage 桩：返回可缩放图像，使缩略图生成真实走完落盘路径
    vi.mocked(nativeImage.createFromBuffer).mockReturnValue({
      isEmpty: () => false,
      getSize: () => ({ width: 800, height: 600 }),
      resize: () => ({ toJPEG: () => Buffer.from('fake-jpeg') })
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
    const misleading = warnSpy.mock.calls.filter((c) => String(c[0]).includes('后台缩略图生成失败'))
    expect(misleading).toHaveLength(0)
  })

  it('窗口存活时 drain 完成推送 thumbsReady 更新（回归护栏）', async () => {
    const { abs } = await setupDeferredThumb()
    const win = { isDestroyed: () => false, webContents: { send: vi.fn() } }

    startThumbDrain(win)
    await awaitThumbDrain()

    expect(win.webContents.send).toHaveBeenCalledWith('models:thumbsReady', {
      updates: [{ id: abs, coverUrl: expect.stringContaining('thumbs') }]
    })
  })
})
