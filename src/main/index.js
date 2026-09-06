import { app, BrowserWindow, Menu, dialog, shell } from 'electron'
import { createMainWindow, getMainWindow } from './windows/mainWindow'
import { registerWindowShortcuts } from './menu'
import { registerIpcHandlers } from './ipc'
import { registerImageScheme, registerImageProtocolHandler } from './protocol'
import { loadSettings, saveStoreNow } from './services/store'
import logger from './logger'

// 自定义协议必须在 app ready 之前注册
registerImageScheme()

/**
 * 全局错误处理：捕获主进程未处理异常，写入日志，避免应用静默崩溃。
 */
process.on('uncaughtException', (error) => {
  logger.error(`未捕获的异常: ${error.stack || error.message}`)
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

    const win = createMainWindow()
    registerWindowShortcuts(win)

    // 阻止在应用内打开新窗口，外部链接交给系统默认浏览器
    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })

    logger.info(`应用启动完成 (Electron ${process.versions.electron} / Node ${process.versions.node})`)
  }).catch((error) => {
    logger.error(`应用初始化失败: ${error.stack || error.message}`)
    dialog.showErrorBox('模匣 启动失败', String(error?.message || error))
    app.quit()
  })
}

// Windows 平台惯例：所有窗口关闭后退出应用
app.on('window-all-closed', () => {
  // 退出前确保持久化数据完整落盘
  saveStoreNow().finally(() => {
    logger.info('所有窗口已关闭，应用退出')
    app.quit()
  })
})

// macOS 平台：点击 Dock 图标时重新创建窗口（兼容性保留）
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow()
  }
})
