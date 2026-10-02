import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { shell } from 'electron'
import { fakeUserData } from './setup'
import { getRegisteredHandler, makeEvent } from './helpers/modelsIpc'

/**
 * models:deleteModel 特征测试（D1，先测后拆基线）：
 * - 模型文件移入回收站（shell.trashItem）且元数据同步移除
 * - 同名 sidecar 文件（.txt / 预览图候选）全部随删（B17 约定）
 * - 无效标识 / 越界路径 / 文件不存在的拒绝路径
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

beforeEach(async () => {
  vi.mocked(shell.trashItem).mockReset()
  vi.mocked(shell.trashItem).mockResolvedValue()
  registerModelIpcHandlers()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-misc-'))
  roots.push(root)
  setDataRoot(root)
  await loadData()
})

afterAll(async () => {
  for (const dir of roots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('models:deleteModel', () => {
  it('模型移入回收站 + 元数据移除 + sidecar 文件全部随删', async () => {
    const abs = path.join(root, 'style-a.safetensors')
    await fs.writeFile(abs, 'x')
    // 制造同名 sidecar：说明文本 + 预览图（仅校验随删清单，物理内容任意）
    const txt = path.join(root, 'style-a.txt')
    const preview = path.join(root, 'style-a.preview.png')
    const jpg = path.join(root, 'style-a.jpg')
    await fs.writeFile(txt, 'trigger words')
    await fs.writeFile(preview, 'p')
    await fs.writeFile(jpg, 'j')
    setModelMeta(abs, { alias: '测试' })

    const handler = getRegisteredHandler('models:deleteModel')
    const res = await handler(makeEvent(), { id: abs })
    expect(res).toEqual({ ok: true })
    // 回收站调用覆盖模型与存在的 sidecar（不存在的候选静默跳过）
    const trashed = vi.mocked(shell.trashItem).mock.calls.map((c) => c[0])
    expect(trashed).toContain(abs)
    expect(trashed).toContain(txt)
    expect(trashed).toContain(preview)
    expect(trashed).toContain(jpg)
    expect(getModelMeta(abs)).toBeNull()
  })

  it('无效模型标识拒绝', async () => {
    const handler = getRegisteredHandler('models:deleteModel')
    expect(await handler(makeEvent(), { id: '' })).toEqual({ error: '无效的模型标识' })
  })

  it('模型不在当前根目录内时拒绝', async () => {
    const outside = path.join(os.tmpdir(), 'modelvault-outside-x.safetensors')
    const handler = getRegisteredHandler('models:deleteModel')
    expect(await handler(makeEvent(), { id: outside })).toEqual({
      error: '模型不在当前根目录内，无法删除'
    })
  })

  it('模型文件不存在时拒绝', async () => {
    const handler = getRegisteredHandler('models:deleteModel')
    const res = await handler(makeEvent(), { id: path.join(root, 'missing.safetensors') })
    expect(res.error).toBe('模型文件不存在')
  })

  it('回收站调用失败时返回错误且元数据保留', async () => {
    const abs = path.join(root, 'keep.safetensors')
    await fs.writeFile(abs, 'x')
    setModelMeta(abs, { alias: '保留' })
    vi.mocked(shell.trashItem).mockRejectedValue(new Error('回收站不可用'))
    const handler = getRegisteredHandler('models:deleteModel')
    const res = await handler(makeEvent(), { id: abs })
    expect(res.error).toBe('删除失败: 回收站不可用')
    expect(getModelMeta(abs)?.alias).toBe('保留')
  })
})

describe('models:reveal 越界校验（C6）', () => {
  it('根目录外的路径拒绝', async () => {
    const handler = getRegisteredHandler('models:reveal')
    const outside = path.join(os.tmpdir(), 'modelvault-reveal-outside.safetensors')
    expect(await handler(makeEvent(), { path: outside })).toEqual({ error: '无效的路径' })
    expect(shell.showItemInFolder).not.toHaveBeenCalled()
  })

  it('根目录内的路径放行', async () => {
    const handler = getRegisteredHandler('models:reveal')
    const inside = path.join(root, 'm.safetensors')
    expect(await handler(makeEvent(), { path: inside })).toEqual({ ok: true })
    expect(shell.showItemInFolder).toHaveBeenCalledWith(inside)
  })
})
