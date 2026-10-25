import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'
import { shell } from 'electron'
import { fakeUserData } from './setup'
import { getRegisteredHandler, makeEvent } from './helpers/modelsIpc'

/**
 * app:openLogs 回归测试（B-04）：
 * shell.openPath 自 Electron 9 起返回 Promise（resolve 空串=成功，错误消息=失败）。
 * 此前 handler 未 await，把 Promise 本身当失败值判断——恒为真值导致该功能
 * 必然返回「打开日志目录失败」。本文件锁定 await 后的成功/失败两分支行为，
 * 成功用例以「返回 Promise 的桩」复现旧缺陷场景：未 await 时必返回 error。
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
  shell: { openPath: vi.fn(), trashItem: vi.fn(), showItemInFolder: vi.fn() },
  net: { fetch: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
}))

import { registerIpcHandlers } from '../src/main/ipc'

const logDir = path.join(fakeUserData, 'logs')

beforeEach(() => {
  vi.mocked(shell.openPath).mockReset()
  registerIpcHandlers()
})

describe('app:openLogs（B-04 回归）', () => {
  it('openPath 成功（resolve 空串）返回 ok，并以应用日志目录为唯一入参', async () => {
    // 关键回归：桩返回 Promise——未 await 的旧实现会把 Promise 误判为失败
    vi.mocked(shell.openPath).mockResolvedValue('')
    const handler = getRegisteredHandler('app:openLogs')
    const res = await handler(makeEvent())
    expect(res).toEqual({ ok: true })
    expect(shell.openPath).toHaveBeenCalledTimes(1)
    expect(shell.openPath).toHaveBeenCalledWith(logDir)
  })

  it('openPath 失败（resolve 错误消息）返回统一错误文案', async () => {
    vi.mocked(shell.openPath).mockResolvedValue('拒绝访问。')
    const handler = getRegisteredHandler('app:openLogs')
    const res = await handler(makeEvent())
    expect(res).toEqual({ error: '打开日志目录失败' })
    expect(shell.openPath).toHaveBeenCalledWith(logDir)
  })
})
