import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import logger from './logger'
import { registerModelIpcHandlers } from './ipc/models'

/**
 * 注册所有主进程 IPC 处理器。
 * 渲染进程通过 preload 暴露的 window.api 调用这些处理器。
 */
export function registerIpcHandlers() {
  registerModelIpcHandlers()

  // ---- invoke 型通信（渲染进程 -> 主进程，带返回值） ----

  // 获取应用与运行时版本信息
  ipcMain.handle('app:getInfo', () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform
  }))

  // 窗口控制
  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.handle('window:toggleMaximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) {
      win.unmaximize()
    } else {
      win.maximize()
    }
  })

  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  // 主题切换时同步原生窗口颜色（标题栏叠加层 + 窗口背景）
  ipcMain.handle('window:setTheme', (event, { theme } = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const colors = theme === 'light'
      ? { overlay: '#f5f7fa', symbol: '#24292f', background: '#f5f7fa' }
      : { overlay: '#101418', symbol: '#e6eaee', background: '#101418' }
    if (win) {
      try {
        win.setBackgroundColor(colors.background)
      } catch (err) {
        logger.warn(`窗口背景色更新失败: ${err.message}`)
      }
    }
    if (win && typeof win.setTitleBarOverlay === 'function') {
      try {
        win.setTitleBarOverlay({ color: colors.overlay, symbolColor: colors.symbol })
      } catch (err) {
        logger.warn(`标题栏主题更新失败: ${err.message}`)
      }
    }
  })

  // 原生对话框示例
  ipcMain.handle('dialog:info', (event, { title = '提示', message = '' } = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    dialog.showMessageBox(win, { type: 'info', title, message })
    logger.info(`弹出对话框: ${title}`)
  })

  // ---- on 型通信（双向消息示例） ----

  // 接收渲染进程消息并原路回复
  ipcMain.on('message:send', (event, payload) => {
    const text = String(payload ?? '')
    logger.info(`收到渲染进程消息: ${text.slice(0, 200)}`)
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.webContents.send('message:reply', `[主进程回复] 已收到你的消息：「${text}」（${new Date().toLocaleTimeString()}）`)
  })

  logger.info('IPC 处理器注册完成')
}
