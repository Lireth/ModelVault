import { BrowserWindow, app, ipcMain, shell } from 'electron'
import logger, { getLogDir } from './logger'
import { registerModelIpcHandlers } from './ipc/models/index.js'
import { themeColors } from './theme'
import { checkForUpdate } from './services/updater'

/**
 * 注册所有主进程 IPC 处理器。
 * 渲染进程通过 preload 暴露的 window.api 调用这些处理器。
 */
export function registerIpcHandlers() {
  registerModelIpcHandlers()

  // 渲染进程异常上报（Vue errorHandler / unhandledrejection），写入主进程日志
  ipcMain.handle('app:reportError', (event, { message, stack } = {}) => {
    const msg = typeof message === 'string' ? message.slice(0, 2000) : '未知渲染进程错误'
    const stackText = typeof stack === 'string' ? `\n${stack.slice(0, 4000)}` : ''
    logger.error(`[渲染进程] ${msg}${stackText}`)
    return { ok: true }
  })

  // 获取应用与运行时版本信息
  ipcMain.handle('app:getInfo', () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform
  }))

  // 应用内检查更新（E1）：查询 GitHub Releases 最新版本并与当前版本比对
  ipcMain.handle('app:checkUpdate', () => checkForUpdate())

  // 打开日志目录（B-04）：反馈问题时用户可直接定位 %APPDATA%\modelvault\logs。
  // 目录为应用自有 userData 子目录，不接受渲染进程传入路径，无越界面。
  // shell.openPath 成功返回空串，失败返回错误消息字符串
  ipcMain.handle('app:openLogs', () => {
    const failure = shell.openPath(getLogDir())
    if (failure) {
      logger.warn(`打开日志目录失败: ${failure}`)
      return { error: '打开日志目录失败' }
    }
    return { ok: true }
  })

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
