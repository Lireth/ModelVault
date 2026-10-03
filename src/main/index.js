import { app, Menu, dialog, shell } from 'electron'
import { createMainWindow, getMainWindow } from './windows/mainWindow'
import { registerWindowShortcuts } from './menu'
import { registerIpcHandlers } from './ipc'
import { registerImageScheme, registerImageProtocolHandler } from './protocol'
import { loadSettings } from './services/store'
import { quitAfterFlush } from './quit'
import { handleUncaughtException } from './fatal-error'
import logger from './logger'

// 自定义协议必须在 app ready 之前注册
registerImageScheme()

// Windows 任务栏分组/跳转列表标识（与 electron-builder.yml 的 appId 一致）
app.setAppUserModelId('com.modelvault.app')

/**
 * 全局错误处理分级策略（A3）：
 * - uncaughtException：异常后进程状态（防抖落盘链/目录监控/扫描任务）已不可信，
 *   带病续跑有元数据丢失风险——记录日志 -> 尽力落盘 -> 提示用户 -> 重启；
 *   处理函数自身异常时兜底直接重启，保证流程必然完成
 * - unhandledRejection：维持仅记录（多数为可恢复的异步业务错误，
 *   渲染进程异常另有 app:reportError 通道上报）
 */
process.on('uncaughtException', (error) => {
  handleUncaughtException(error).catch((err) => {
    logger.error(`致命错误处理失败: ${err.stack || err.message}`)
    app.relaunch()
    app.exit(1)
  })
})

process.on('unhandledRejection', (reason) => {
  logger.error(`未处理的 Promise 拒绝: ${reason instanceof Error ? reason.stack : String(reason)}`)
})

/**
 * 单实例锁：确保 Windows 下同一时刻只运行一个应用实例。
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  logger.warn('检测到已有实例在运行，当前实例即将退出')
  app.quit()
} else {
  // 第二实例启动时，聚焦已有窗口
  app.on('second-instance', () => {
    const win = getMainWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    // 移除原生菜单栏（不设置则 Electron 会启用默认英文菜单）
    Menu.setApplicationMenu(null)
    // 仅注册窗口级快捷键
    registerImageProtocolHandler()
    registerIpcHandlers()

    // 先加载应用设置，确保窗口主题（背景色/标题栏颜色）与已保存设置一致
    await loadSettings()

    const win = await createMainWindow()
    registerWindowShortcuts(win)

    // 阻止在应用内打开新窗口：http(s) 外链交给系统默认浏览器；
    // 其余协议（file:/smb:/自定义协议等）一律拒绝并记日志，防止渲染进程
    // 被注入后构造任意协议 URL 唤起系统处理程序
    win.webContents.setWindowOpenHandler(({ url }) => {
      let protocol = ''
      try {
        protocol = new URL(url).protocol
      } catch {
        /* 非法 URL 按拒绝处理 */
      }
      if (protocol === 'http:' || protocol === 'https:') {
        shell.openExternal(url)
      } else {
        logger.warn(`已拦截非 http(s) 协议的外链打开请求: ${url}`)
      }
      return { action: 'deny' }
    })

    logger.info(`应用启动完成 (Electron ${process.versions.electron} / Node ${process.versions.node})`)
  }).catch((error) => {
    logger.error(`应用初始化失败: ${error.stack || error.message}`)
    dialog.showErrorBox('模匣 启动失败', String(error?.message || error))
    app.quit()
  })
}

// Windows 平台惯例：所有窗口关闭后退出应用（退出编排见 quit.js：
// 停监控 -> 等两路落盘 -> quit，落盘超时强制退出，A4）
app.on('window-all-closed', () => {
  quitAfterFlush()
})
