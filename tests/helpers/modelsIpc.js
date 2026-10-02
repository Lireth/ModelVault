import { vi } from 'vitest'
import { ipcMain } from 'electron'

/**
 * models IPC handler 测试共享工具。
 * electron 已由各测试文件内的 vi.mock 提供完整桩（ipcMain.handle 为 vi.fn()），
 * 此处从注册记录中按通道名取最新 handler 直接调用，绕过真实 IPC 层。
 */

/**
 * 从 ipcMain.handle 的注册记录中取指定通道的 handler（取最新一次注册，
 * 与多次调用 registerModelIpcHandlers 的场景兼容）。
 * @param {string} channel IPC 通道名
 * @returns {Function} 注册的 handler
 */
export function getRegisteredHandler(channel) {
  const call = vi
    .mocked(ipcMain.handle)
    .mock.calls.filter((c) => c[0] === channel)
    .pop()
  if (!call) {
    throw new Error(`handler 未注册: ${channel}`)
  }
  return call[1]
}

/** 最小 PNG 文件头（魔数校验所需字节 + 补足内容） */
export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

/**
 * 构造带假窗口的 IPC event。
 * 配合测试文件 electron mock 中 BrowserWindow.fromWebContents 的返回值使用：
 * 先 mock fromWebContents 返回 win，再以本 event 调用 handler。
 * @param {object} [win] 假窗口（缺省为最小可用桩）
 */
export function makeEvent(win = makeWindow()) {
  return { sender: { __win: win } }
}

/** 构造假 BrowserWindow：send 收集调用、isDestroyed 可控 */
export function makeWindow({ destroyed = false } = {}) {
  return {
    isDestroyed: () => destroyed,
    webContents: { send: vi.fn() }
  }
}
