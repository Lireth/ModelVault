import { BrowserWindow } from 'electron'
import path from 'node:path'
import logger from '../logger'
import { getSettings } from '../services/store'

/** 各主题对应的原生窗口颜色 */
const THEME_WINDOW_COLORS = {
  dark: { backgroundColor: '#101418', overlayColor: '#101418', symbolColor: '#e6eaee' },
  light: { backgroundColor: '#f5f7fa', overlayColor: '#f5f7fa', symbolColor: '#24292f' }
}

let mainWindow = null

/**
 * 创建应用主窗口，并根据运行环境加载渲染页面。
 * - 开发环境：加载 electron-vite 开发服务器（支持 HMR 热重载）
 * - 生产环境：加载打包后的本地文件
 */
export function createMainWindow() {
  // 窗口底色与标题栏叠加层颜色跟随已保存的主题设置
  const colors = THEME_WINDOW_COLORS[getSettings().theme] || THEME_WINDOW_COLORS.dark

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: '模匣',
    show: false,
    // 隐藏原生标题栏，启用原生窗口控件叠加层（WCO）：
    // 右上角显示原生最小化/最大化/关闭按钮，-webkit-app-region: drag
    // 的拖拽区域由操作系统处理，确保可拖动移动窗口
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: colors.overlayColor,
      symbolColor: colors.symbolColor,
      height: 40
    },
    backgroundColor: colors.backgroundColor,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // 安全配置：隔离上下文，禁用 Node 能力，启用渲染进程沙箱
      // （preload 仅使用 contextBridge/ipcRenderer，完全兼容沙箱模式）
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  // 避免窗口尺寸变化时出现白屏闪烁
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    logger.info(`开发模式：加载开发服务器 ${process.env['ELECTRON_RENDERER_URL']}`)
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 渲染进程异常退出时的错误处理
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logger.error(`渲染进程异常退出: ${details.reason} (exitCode=${details.exitCode})`)
  })

  // 渲染进程加载失败时的错误处理
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    logger.error(`页面加载失败: [${errorCode}] ${errorDescription}`)
  })

  return mainWindow
}

/**
 * 获取当前主窗口实例（可能为 null）。
 */
export function getMainWindow() {
  return mainWindow
}
