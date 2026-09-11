import { BrowserWindow, app, ipcMain } from 'electron'
import logger from './logger'
import { registerModelIpcHandlers } from './ipc/models'
import { themeColors } from './theme'

/**
 * 注册所有主进程 IPC 处理器。
 * 渲染进程通过 preload 暴露的 window.api 调用这些处理器。
 */
export function registerIpcHandlers() {
  registerModelIpcHandlers()

  // 获取应用与运行时版本信息
  ipcMain.handle('app:getInfo', () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform
  }))

  // 主题切换时同步原生窗口颜色（标题栏叠加层 + 窗口背景）
  ipcMain.handle('window:setTheme', (event, { theme } = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const colors = themeColors(theme)
    if (win) {
      try {
        win.setBackgroundColor(colors.backgroundColor)
      } catch (err) {
        logger.warn(`窗口背景色更新失败: ${err.message}`)
      }
    }
    if (win && typeof win.setTitleBarOverlay === 'function') {
      try {
        win.setTitleBarOverlay({ color: colors.overlayColor, symbolColor: colors.symbolColor })
      } catch (err) {
        logger.warn(`标题栏主题更新失败: ${err.message}`)
      }
    }
  })

  logger.info('IPC 处理器注册完成')
}
