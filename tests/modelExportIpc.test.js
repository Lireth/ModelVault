import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { dialog } from 'electron'
import { fakeUserData } from './setup'

/**
 * models:exportModelList（FN-04）：
 * 主进程仅接受 format + content，路径由原生保存对话框决定；
 * 落盘为原子写，取消/非法格式不写文件。
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  BrowserWindow: Object.assign(vi.fn(), { fromWebContents: vi.fn(() => null) }),
  Menu: { buildFromTemplate: vi.fn() },
  clipboard: { writeText: vi.fn() },
  shell: { showItemInFolder: vi.fn(), trashItem: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  net: { fetch: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() }
}))

import { registerMiscHandlers } from '../src/main/ipc/models/misc'
import { getRegisteredHandler, makeEvent } from './helpers/modelsIpc'

const files = []

beforeEach(() => {
  vi.mocked(dialog.showSaveDialog).mockReset()
  registerMiscHandlers()
})

afterAll(async () => {
  for (const file of files) await fs.rm(file, { force: true }).catch(() => {})
})

describe('models:exportModelList', () => {
  it('将渲染层文本原子写入用户选择的路径', async () => {
    const target = path.join(os.tmpdir(), `modelvault-list-${Date.now()}.csv`)
    files.push(target)
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: target })

    const handler = getRegisteredHandler('models:exportModelList')
    const content = '\uFEFF名称,别名\r\na.safetensors,别名\r\n'
    const res = await handler(makeEvent(), { format: 'csv', content })

    expect(res.ok).toBe(true)
    expect(res.path).toBe(target)
    expect(await fs.readFile(target, 'utf-8')).toBe(content)
    // 对话框使用 csv 扩展名与“导出模型清单”标题
    const options = vi.mocked(dialog.showSaveDialog).mock.calls[0][1]
    expect(options.title).toBe('导出模型清单')
    expect(options.defaultPath.endsWith('.csv')).toBe(true)
  })

  it('非法格式拒绝且不弹保存框', async () => {
    const handler = getRegisteredHandler('models:exportModelList')
    const res = await handler(makeEvent(), { format: 'exe', content: 'x' })
    expect(res).toEqual({ error: '不支持的导出格式' })
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()
  })

  it('用户取消保存时不写文件', async () => {
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: true })
    const handler = getRegisteredHandler('models:exportModelList')
    const res = await handler(makeEvent(), { format: 'json', content: '[]' })
    expect(res).toEqual({ canceled: true })
  })
})
