import { BrowserWindow, app, screen } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
import { getSettings } from '../services/store'
import { themeColors } from '../theme'

/** 默认窗口尺寸 */
const DEFAULT_WIDTH = 1200
const DEFAULT_HEIGHT = 800

/** 窗口状态持久化文件（保存在 %APPDATA%\modelvault\） */
const WINDOW_STATE_FILE = 'window-state.json'

let mainWindow = null

/**
 * 加载上次保存的窗口状态（尺寸/位置/是否最大化）。
 * 数据无效或位置落在所有显示器之外（如外接显示器被拔掉）时返回 null，回退默认值。
 */
async function loadWindowState() {
  try {
    const file = path.join(app.getPath('userData'), WINDOW_STATE_FILE)
    const raw = JSON.parse(await fs.readFile(file, 'utf-8'))
    const { x, y, width, height } = raw || {}
    if (![x, y, width, height].every((n) => Number.isFinite(n))) return null
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return x + width > a.x && y + height > a.y && x < a.x + a.width && y < a.y + a.height
    })
    if (!visible) return null
    return { x, y, width, height, maximized: raw.maximized === true }
  } catch {
    return null
  }
}

/** 保存窗口状态（取最大化前的正常边界，避免记录铺满全屏的坐标） */
async function saveWindowState(win) {
  try {
    const state = { ...win.getNormalBounds(), maximized: win.isMaximized() }
    const file = path.join(app.getPath('userData'), WINDOW_STATE_FILE)
    await fs.writeFile(file, JSON.stringify(state, null, 2), 'utf-8')
  } catch (err) {
    logger.warn(`窗口状态保存失败: ${err.message}`)
  }
}

/**
 * 创建应用主窗口，并根据运行环境加载渲染页面。
 * - 开发环境：加载 electron-vite 开发服务器（支持 HMR 热重载）
 * - 生产环境：加载打包后的本地文件
 */
export async function createMainWindow() {
  // 窗口底色与标题栏叠加层颜色跟随已保存的主题设置
  const colors = themeColors(getSettings().theme)
  const state = await loadWindowState()

  const options = {
    width: state?.width ?? DEFAULT_WIDTH,
    height: state?.height ?? DEFAULT_HEIGHT,
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
  }
  // 恢复上次的窗口位置（无有效记录时居中显示）
  if (state) {
    options.x = state.x
    options.y = state.y
  }

  mainWindow = new BrowserWindow(options)
  if (state?.maximized) mainWindow.maximize()

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

  // 关闭时保存窗口状态（尺寸/位置/是否最大化），下次启动恢复
  mainWindow.on('close', () => {
    saveWindowState(mainWindow)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 拦截页面自身的导航尝试（如 location.href 跳转）：
  // 渲染页应始终停留在本地页面，任何导航请求一律阻止（防御纵深，
  // 不影响主进程的 loadURL/loadFile 初始化加载）
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
    logger.warn('已阻止渲染页面的导航请求')
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
