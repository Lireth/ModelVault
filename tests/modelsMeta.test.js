import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ipcMain, net, protocol } from 'electron'
import { fakeUserData } from './setup'
/**
 * models:saveModelData 合并逻辑回归测试（B2）：
 * 局部保存（仅传部分字段）时不得将未传字段静默清空。
 * models.js 依赖链较重，此处对 electron 提供完整最小桩。
 */
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  clipboard: { readImage: vi.fn() },
  net: { fetch: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() }
}))

import { mergeSaveModelData, registerModelIpcHandlers } from '../src/main/ipc/models'
import { importCoverFromPath } from '../src/main/services/covers'
import { setDataRoot } from '../src/main/services/store'
import { registerImageProtocolHandler, toImageUrl } from '../src/main/protocol'

const baseMeta = {
  alias: '旧别名',
  params: { steps: 28, cfg: 7 },
  note: '旧备注',
  noteSource: 'sidecar',
  subCategory: 'Pony',
  covers: ['covers/a.png'],
  cover: 'covers/a.png'
}

/** 本文件创建的全部临时目录（afterAll 只清理这些，不动系统临时目录） */
const roots = []

describe('mergeSaveModelData', () => {
  it('全字段显式传入时正常覆盖', () => {
    const merged = mergeSaveModelData(baseMeta, {
      alias: '新别名',
      params: { steps: 30 },
      note: '新备注',
      subCategory: 'SDXL'
    })
    expect(merged.alias).toBe('新别名')
    expect(merged.params).toEqual({ steps: 30 })
    expect(merged.note).toBe('新备注')
    expect(merged.subCategory).toBe('SDXL')
    // 用户编辑备注后清除 sidecar 来源标记
    expect(merged.noteSource).toBe('')
  })

  it('局部保存仅传 note 时，其余字段保留原值不被清空', () => {
    const merged = mergeSaveModelData(baseMeta, { note: '只改备注' })
    expect(merged.note).toBe('只改备注')
    expect(merged.alias).toBe('旧别名')
    expect(merged.params).toEqual({ steps: 28, cfg: 7 })
    expect(merged.subCategory).toBe('Pony')
    expect(merged.noteSource).toBe('')
  })

  it('patch 全部未传时 existing 字段原样保留（含 noteSource）', () => {
    const merged = mergeSaveModelData(baseMeta, {})
    expect(merged).toEqual(baseMeta)
  })

  it('显式传 null/空串仍视为有效覆盖（允许主动清空）', () => {
    const merged = mergeSaveModelData(baseMeta, { params: null, subCategory: '' })
    expect(merged.params).toBeNull()
    expect(merged.subCategory).toBe('')
    expect(merged.alias).toBe('旧别名')
  })

  it('纯函数不修改入参', () => {
    const snapshot = { ...baseMeta }
    mergeSaveModelData(baseMeta, { note: '改', alias: '改' })
    expect(baseMeta).toEqual(snapshot)
  })
})

describe('importCoverFromPath 封面导入', () => {
  let root

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-covers-'))
    roots.push(root)
    setDataRoot(root)
  })

  // 只清理自建临时目录：删除整个系统临时目录会连带摧毁并行测试的目录与 vite 缓存
  afterAll(async () => {
    for (const dir of roots) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  /** 最小 PNG 文件头（魔数校验所需 8 字节 + 补足数据） */
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

  it('伪装图片扩展名的文本文件拒绝导入（B7 外泄链）', async () => {
    const fake = path.join(root, 'secret.png')
    await fs.writeFile(fake, '敏感文本内容，非图片')
    const res = await importCoverFromPath(fake)
    expect(res.error).toBeTruthy()
    // covers 目录不应被创建/写入
    await expect(fs.access(path.join(root, '.modelvault', 'covers'))).rejects.toThrow()
  })

  it('真实 PNG 内容导入成功并复制到封面目录', async () => {
    const real = path.join(root, 'real.png')
    await fs.writeFile(real, PNG_MAGIC)
    const res = await importCoverFromPath(real)
    expect(res.error).toBeUndefined()
    expect(res.cover).toBeTruthy()
    expect(await fs.readFile(res.cover)).toEqual(PNG_MAGIC)
  })

  it('非图片扩展名直接拒绝', async () => {
    const txt = path.join(root, 'note.txt')
    await fs.writeFile(txt, 'hello')
    const res = await importCoverFromPath(txt)
    expect(res.error).toContain('不支持的图片格式')
  })
})

describe('mvimg 协议路径白名单', () => {
  let root
  let handler

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-proto-'))
    roots.push(root)
    setDataRoot(root)
    vi.mocked(protocol.handle).mockClear()
    registerImageProtocolHandler()
    handler = vi.mocked(protocol.handle).mock.calls[0][1]
    vi.mocked(net.fetch).mockResolvedValue(new Response('ok'))
  })

  afterAll(async () => {
    for (const dir of roots) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })

  /** 经 toImageUrl 构造请求并调用协议 handler，返回响应 */
  async function request(filePath) {
    return handler({ url: toImageUrl(filePath) })
  }

  it('根目录内图片放行', async () => {
    const img = path.join(root, 'cover.png')
    await fs.writeFile(img, 'x')
    const res = await request(img)
    expect(res.status).toBe(200)
  })

  it('根目录外路径拒绝（403）', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-outside-'))
    roots.push(outsideDir)
    const img = path.join(outsideDir, 'secret.png')
    await fs.writeFile(img, 'x')
    const res = await request(img)
    expect(res.status).toBe(403)
  })

  it('根目录内 junction 指向外部文件被拒绝（B8 绕过）', async (ctx) => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-outside-'))
    const img = path.join(outsideDir, 'secret.png')
    await fs.writeFile(img, 'x')
    const linkPath = path.join(root, 'link')
    try {
      // junction 创建在 Windows 普通权限下可用；受限环境跳过
      await fs.symlink(outsideDir, linkPath, 'junction')
    } catch {
      ctx.skip()
    }
    // 字面路径在 root 内，真实路径在外 → 必须拒绝
    const res = await request(path.join(linkPath, 'secret.png'))
    expect(res.status).toBe(403)
  })

  it('不存在的路径返回 404', async () => {
    const res = await request(path.join(root, 'missing.png'))
    expect(res.status).toBe(404)
  })
})

describe('civitaiMatch 并发防重入（B3）', () => {
  let root

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-match-'))
    roots.push(root)
    setDataRoot(root)
  })

  /** 从 ipcMain.handle 的注册记录中取 civitaiMatch 的 handler（取最新一次注册） */
  function getMatchHandler() {
    registerModelIpcHandlers()
    const call = vi
      .mocked(ipcMain.handle)
      .mock.calls.filter((c) => c[0] === 'models:civitaiMatch')
      .pop()
    return call[1]
  }

  it('首个匹配进行中时，并发请求立即拒绝，不重复计算哈希', async () => {
    const handler = getMatchHandler()
    const modelFile = path.join(root, 'm.safetensors')
    await fs.writeFile(modelFile, 'x')

    // 让首个请求挂起在网络阶段（本地哈希已算完，等待 fetch 返回）
    let releaseFetch
    vi.mocked(net.fetch).mockImplementation(
      () => new Promise((resolve) => { releaseFetch = resolve })
    )

    const first = handler({}, { id: modelFile })
    // 第二个并发请求必须立即被互斥拒绝，而非再排一次哈希计算
    const second = await handler({}, { id: modelFile })
    expect(second).toEqual({ error: '正在匹配中，请稍候' })

    // 首个请求经 stat/流式哈希等多个 IO 宏任务后才到达网络阶段，轮询等待挂起点就绪
    const deadline = Date.now() + 5000
    while (typeof releaseFetch !== 'function' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    releaseFetch(new Response(null, { status: 404 }))
    const firstResult = await first
    expect(firstResult.matched).toBe(false)
    expect(firstResult.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('匹配结束后标记复位，后续请求可正常进入', async () => {
    const handler = getMatchHandler()
    vi.mocked(net.fetch).mockResolvedValue(new Response(null, { status: 404 }))
    const modelFile = path.join(root, 'm.safetensors')
    await fs.writeFile(modelFile, 'x')

    const first = await handler({}, { id: modelFile })
    expect(first.matched).toBe(false)
    // 互斥标记已释放：第二次请求正常进入（命中 matchCache 直接返回）
    const second = await handler({}, { id: modelFile })
    expect(second.matched).toBe(false)
  })
})
