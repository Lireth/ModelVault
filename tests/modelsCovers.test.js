import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { clipboard, dialog } from 'electron'
import { fakeUserData } from './setup'
import { PNG_MAGIC, getRegisteredHandler, makeEvent } from './helpers/modelsIpc'

/**
 * 封面域 5 个 handler 特征测试（D1，先测后拆基线）：
 * - 响应结构锚点：全部返回 { cover, coverUrl, covers, meta } 四键（项目约定）
 * - uploadCover / pasteCover 成功与非法输入
 * - setDefaultCover 切换与封面不存在
 * - deleteCover 三态：删默认回退 / 删非默认默认不变 / 删最后一张为空
 * - importCover 透传魔数校验拒绝（B7）与模型越界拒绝
 * 说明：covers.js 服务层（魔数校验/复制）真实执行，仅 mock electron 对话框与剪贴板。
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

import { registerModelIpcHandlers } from '../src/main/ipc/models/index'
import { getModelMeta, loadData, setModelMeta, setDataRoot } from '../src/main/services/store'

const roots = []
let root

/** 在当前根目录内创建模型占位文件，返回绝对路径 */
async function touchModel(rel = 'm.safetensors') {
  const abs = path.join(root, rel)
  await fs.writeFile(abs, 'x')
  return abs
}

/** 在根目录外创建真实 PNG 源文件（模拟用户拖入/选择的外部图片） */
async function createSourcePng() {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-cover-src-'))
  roots.push(outside)
  const src = path.join(outside, 'pic.png')
  await fs.writeFile(src, PNG_MAGIC)
  return src
}

/** 为模型预置两张封面元数据（封面物理文件无需存在，resolveCover 为纯路径拼接） */
function presetCovers(id, count = 2) {
  const covers = Array.from({ length: count }, (_, i) => `covers/a${i}.png`)
  return setModelMeta(id, { covers, cover: covers[0] })
}

beforeEach(async () => {
  registerModelIpcHandlers()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-covers-ipc-'))
  roots.push(root)
  setDataRoot(root)
  await loadData()
})

afterAll(async () => {
  for (const dir of roots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('封面响应结构锚点（项目约定：{cover,coverUrl,covers,meta}）', () => {
  const scenarios = [
    {
      channel: 'models:uploadCover',
      invoke: async (handler, id, png) => {
        vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [png] })
        return handler(makeEvent(), { id })
      }
    },
    {
      channel: 'models:pasteCover',
      invoke: async (handler, id) => {
        vi.mocked(clipboard.read).mockResolvedValue([
          { types: ['image/png'], getType: async () => new Blob([PNG_MAGIC]) }
        ])
        return handler(makeEvent(), { id })
      }
    },
    {
      channel: 'models:setDefaultCover',
      invoke: async (handler, id, _png, meta) => handler(makeEvent(), { id, cover: meta.covers[1] })
    },
    {
      channel: 'models:deleteCover',
      invoke: async (handler, id, _png, meta) => handler(makeEvent(), { id, cover: meta.covers[0] })
    },
    {
      channel: 'models:importCover',
      invoke: async (handler, id, png) => handler(makeEvent(), { id, path: png })
    }
  ]

  it.each(scenarios)('$channel 成功路径返回四键结构', async ({ channel, invoke }) => {
    const id = await touchModel()
    const png = await createSourcePng()
    let meta
    if (channel === 'models:setDefaultCover' || channel === 'models:deleteCover') {
      meta = presetCovers(id)
    }
    const handler = getRegisteredHandler(channel)
    const res = await invoke(handler, id, png, meta)
    expect(res.error).toBeUndefined()
    expect(typeof res.cover).toBe('string')
    expect(typeof res.coverUrl).toBe('string')
    expect(Array.isArray(res.covers)).toBe(true)
    expect(res.meta && typeof res.meta).toBe('object')
  })
})

describe('models:uploadCover', () => {
  it('无效模型标识拒绝', async () => {
    const handler = getRegisteredHandler('models:uploadCover')
    expect(await handler(makeEvent(), { id: '' })).toEqual({ error: '无效的模型标识' })
  })

  it('对话框取消返回 { canceled: true }', async () => {
    const id = await touchModel()
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] })
    const handler = getRegisteredHandler('models:uploadCover')
    expect(await handler(makeEvent(), { id })).toEqual({ canceled: true })
  })

  it('上传成功后追加封面并在无默认时设为默认', async () => {
    const id = await touchModel()
    const png = await createSourcePng()
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [png] })
    const handler = getRegisteredHandler('models:uploadCover')
    const res = await handler(makeEvent(), { id })
    expect(res.error).toBeUndefined()
    expect(res.cover.endsWith('.png')).toBe(true)
    // 首张封面自动成为默认
    expect(res.meta.cover).toBeTruthy()
    expect(res.meta.covers).toHaveLength(1)
    expect(getModelMeta(id).covers).toHaveLength(1)
  })
})

describe('models:pasteCover', () => {
  it('剪贴板无图片内容时返回错误', async () => {
    const id = await touchModel()
    vi.mocked(clipboard.read).mockResolvedValue([])
    const handler = getRegisteredHandler('models:pasteCover')
    const res = await handler(makeEvent(), { id })
    expect(res.error).toBe('剪贴板中没有图片内容')
  })

  it('粘贴成功后写入封面目录并关联元数据', async () => {
    const id = await touchModel()
    vi.mocked(clipboard.read).mockResolvedValue([
      { types: ['image/png'], getType: async () => new Blob([PNG_MAGIC]) }
    ])
    const handler = getRegisteredHandler('models:pasteCover')
    const res = await handler(makeEvent(), { id })
    expect(res.error).toBeUndefined()
    expect(res.cover).toContain(path.join('.modelvault', 'covers'))
    expect(getModelMeta(id).covers).toHaveLength(1)
  })
})

describe('models:setDefaultCover', () => {
  it('封面不存在时拒绝', async () => {
    const id = await touchModel()
    presetCovers(id)
    const handler = getRegisteredHandler('models:setDefaultCover')
    expect(await handler(makeEvent(), { id, cover: 'covers/missing.png' })).toEqual({
      error: '封面不存在，无法设为默认'
    })
  })

  it('切换默认封面后 meta.cover 指向新默认', async () => {
    const id = await touchModel()
    const meta = presetCovers(id)
    const handler = getRegisteredHandler('models:setDefaultCover')
    const res = await handler(makeEvent(), { id, cover: meta.covers[1] })
    expect(res.error).toBeUndefined()
    expect(res.meta.cover).toBe(meta.covers[1])
    expect(getModelMeta(id).cover).toBe(meta.covers[1])
  })
})

describe('models:deleteCover 三态（项目约定：删默认自动回退）', () => {
  it('删除默认封面时自动回退到下一张', async () => {
    const id = await touchModel()
    const meta = presetCovers(id, 2)
    const handler = getRegisteredHandler('models:deleteCover')
    const res = await handler(makeEvent(), { id, cover: meta.covers[0] })
    expect(res.error).toBeUndefined()
    expect(res.meta.cover).toBe(meta.covers[1])
    expect(res.meta.covers).toEqual([meta.covers[1]])
  })

  it('删除非默认封面时默认封面不变', async () => {
    const id = await touchModel()
    const meta = presetCovers(id, 2)
    const handler = getRegisteredHandler('models:deleteCover')
    const res = await handler(makeEvent(), { id, cover: meta.covers[1] })
    expect(res.error).toBeUndefined()
    expect(res.meta.cover).toBe(meta.covers[0])
    expect(res.meta.covers).toEqual([meta.covers[0]])
  })

  it('删除最后一张封面时默认为空字符串', async () => {
    const id = await touchModel()
    const meta = presetCovers(id, 1)
    const handler = getRegisteredHandler('models:deleteCover')
    const res = await handler(makeEvent(), { id, cover: meta.covers[0] })
    expect(res.error).toBeUndefined()
    expect(res.meta.cover).toBe('')
    expect(res.meta.covers).toEqual([])
    expect(res.cover).toBe('')
    expect(res.coverUrl).toBe('')
  })
})

describe('models:importCover', () => {
  it('伪装图片扩展名的文件拒绝导入（B7 外泄链）', async () => {
    const id = await touchModel()
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-cover-src-'))
    roots.push(outside)
    const fake = path.join(outside, 'secret.png')
    await fs.writeFile(fake, '敏感文本内容')
    const handler = getRegisteredHandler('models:importCover')
    const res = await handler(makeEvent(), { id, path: fake })
    expect(res.error).toBe('文件内容不是有效的图片，已拒绝导入')
    expect(getModelMeta(id)).toBeNull()
  })

  it('模型不在当前根目录内时拒绝关联', async () => {
    const png = await createSourcePng()
    const outsideId = path.join(os.tmpdir(), 'modelvault-outside-model.safetensors')
    const handler = getRegisteredHandler('models:importCover')
    const res = await handler(makeEvent(), { id: outsideId, path: png })
    expect(res.error).toBe('封面关联失败（模型需位于当前模型根目录内）')
  })
})
