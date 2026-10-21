import { BrowserWindow, app, shell } from 'electron'
import logger, { getLogDir } from './logger'
import { registerModelIpcHandlers } from './ipc/models/index.js'
import { wrapHandler } from './ipc/handler'
import { themeColors } from './theme'
import { checkForUpdate } from './services/updater'
import {
  cancelUpdateDownload,
  downloadUpdatePackage,
  installUpdatePackage
} from './services/update-download'

/**
 * 注册所有主进程 IPC 处理器。
 * 渲染进程通过 preload 暴露的 window.api 调用这些处理器。
 * 全部通道经 wrapHandler 统一注册（O1 fail-closed）：payload 按 ipc/schema.js
 * 注册表前置校验，未登记 schema 的通道直接拒绝并写告警日志。
 */
export function registerIpcHandlers() {
  registerModelIpcHandlers()

  // 渲染进程异常上报（Vue errorHandler / unhandledrejection），写入主进程日志。
  // schema 宽松门禁（字段可选），handler 内保留类型归一化与长度截断兜底
  wrapHandler('app:reportError', (event, { message, stack } = {}) => {
    const msg = typeof message === 'string' ? message.slice(0, 2000) : '未知渲染进程错误'
    const stackText = typeof stack === 'string' ? `\n${stack.slice(0, 4000)}` : ''
    logger.error(`[渲染进程] ${msg}${stackText}`)
    return { ok: true }
  })

  // 获取应用与运行时版本信息
  wrapHandler('app:getInfo', () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform
  }))

  // 应用内检查更新（E1）：查询 GitHub Releases 最新版本并与当前版本比对
  wrapHandler('app:checkUpdate', () => checkForUpdate())

  // 应用内更新下载/安装（F-6）：URL 由检查更新链路保存在主进程模块态，
  // 渲染层不传任何参数；下载进度经 app:updateProgress 事件推送来源窗口
  wrapHandler('app:downloadUpdate', (event) =>
    downloadUpdatePackage((p) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win && !win.isDestroyed()) {
        win.webContents.send('app:updateProgress', p)
      }
    })
  )
  wrapHandler('app:cancelUpdateDownload', () => cancelUpdateDownload())
  wrapHandler('app:installUpdate', () => installUpdatePackage())

  // 打开日志目录（B-04）：反馈问题时用户可直接定位 %APPDATA%\modelvault\logs。
  // 目录为应用自有 userData 子目录，不接受渲染进程传入路径，无越界面。
  // shell.openPath 成功返回空串，失败返回错误消息字符串
  wrapHandler('app:openLogs', () => {
    const failure = shell.openPath(getLogDir())
    if (failure) {
      logger.warn(`打开日志目录失败: ${failure}`)
      return { error: '打开日志目录失败' }
    }
    return { ok: true }
  })

  // 主题切换时同步原生窗口颜色（标题栏叠加层 + 窗口背景）。
  // theme 类型/长度由 schema 前置校验；themeColors 对未知值回退默认主题
  wrapHandler('window:setTheme', (event, payload) => {
    const { theme } = payload
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
