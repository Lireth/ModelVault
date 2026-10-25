import { BrowserWindow, app, screen } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
import { getSettings, atomicWriteFile } from '../services/store'
import { destroyThumbRenderer } from '../services/thumb-renderer'
import { themeColors } from '../theme'

/** 默认窗口尺寸 */
const DEFAULT_WIDTH = 1200
const DEFAULT_HEIGHT = 800

/** 窗口状态持久化文件（保存在 %APPDATA%\modelvault\） */
const WINDOW_STATE_FILE = 'window-state.json'

/**
 * 窗口状态文件体积上限：文件位于 userData（半信任面，可能被外部工具改写
 * 或写坏），异常膨胀的文件直接回退默认值，不进入 JSON.parse
 */
const MAX_STATE_FILE_BYTES = 64 * 1024
/** 窗口尺寸合理范围（px）：下限排除零/负值与过小窗口，上限排除 1e12 类畸形值 */
const MIN_DIMENSION = 200
const MAX_DIMENSION = 20000
/** 窗口坐标绝对值上限（px）：多显示器拼接下合理坐标远小于此量级 */
const MAX_COORDINATE = 100000

let mainWindow = null

/** close 时发起的窗口状态保存 promise（退出路径等待其完成，防止原子写被中断） */
let pendingStateSave = null

/**
 * 窗口几何数值是否在合理范围内：仅 Number.isFinite 不足以拦截负数尺寸与
 * 1e12 类极端值——它们会原样进入 BrowserWindow 构造，导致启动窗口行为
 * 不可预期（如不可见/占满虚拟桌面）。
 * @returns {boolean}
 */
function isPlausibleGeometry(x, y, width, height) {
  return (
    width >= MIN_DIMENSION &&
    width <= MAX_DIMENSION &&
    height >= MIN_DIMENSION &&
    height <= MAX_DIMENSION &&
    Math.abs(x) <= MAX_COORDINATE &&
    Math.abs(y) <= MAX_COORDINATE
  )
}

/**
 * 加载上次保存的窗口状态（尺寸/位置/是否最大化）。
 * 数据无效或位置落在所有显示器之外（如外接显示器被拔掉）时返回 null，回退默认值。
 */
export async function loadWindowState() {
  try {
    const file = path.join(app.getPath('userData'), WINDOW_STATE_FILE)
    const { size } = await fs.stat(file)
    if (size > MAX_STATE_FILE_BYTES) {
      logger.warn(`窗口状态文件异常膨胀（${size} 字节），回退默认窗口状态`)
      return null
    }
    const raw = JSON.parse(await fs.readFile(file, 'utf-8'))
    const { x, y, width, height } = raw || {}
    if (![x, y, width, height].every((n) => Number.isFinite(n))) return null
    if (!isPlausibleGeometry(x, y, width, height)) {
      logger.warn(
        `窗口状态几何数值超出合理范围，回退默认窗口状态: ${JSON.stringify({ x, y, width, height })}`,
      )
      return null
    }
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea
      return (
        x + width > a.x &&
        y + height > a.y &&
        x < a.x + a.width &&
        y < a.y + a.height
      )
    })
    if (!visible) return null
    return { x, y, width, height, maximized: raw.maximized === true }
  } catch {
    return null
  }
}

/** 保存窗口状态（取最大化前的正常边界，避免记录铺满全屏的坐标；原子写入防损坏） */
async function saveWindowState(win) {
  try {
    const state = { ...win.getNormalBounds(), maximized: win.isMaximized() }
    const file = path.join(app.getPath('userData'), WINDOW_STATE_FILE)
    await atomicWriteFile(file, JSON.stringify(state, null, 2))
  } catch (err) {
    logger.warn(`窗口状态保存失败: ${err.message}`)
  }
}

/**
 * 创建应用主窗口，并根据运行环境加载渲染页面。
 * - 开发环境：加载 electron-vite 开发服务器（支持 HMR 热重载）
 * - 生产环境：加载打包后的本地文件
 */
export async function createMainWindow(windowStateOverride = undefined) {
  // 窗口底色与标题栏叠加层颜色跟随已保存的主题设置
  const colors = themeColors(getSettings().theme)
  // 启动链路并行化（OP-01）：窗口状态由调用方与 loadSettings 并行预读，
  // 此处仅在该参数缺省时自行读取（测试/独立调用路径保持原行为）
  const state =
    windowStateOverride === undefined
      ? await loadWindowState()
      : windowStateOverride

  /** @type {import('electron').BrowserWindowConstructorOptions} */
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
      height: 40,
    },
    backgroundColor: colors.backgroundColor,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // 安全配置：隔离上下文，禁用 Node 能力，启用渲染进程沙箱
      // （preload 仅使用 contextBridge/ipcRenderer，完全兼容沙箱模式）
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  }
  // 恢复上次的窗口位置（无有效记录时居中显示）
  if (state) {
    options.x = state.x
    options.y = state.y
  }
  // 开发模式下显式指定窗口/任务栏图标（打包后窗口自动使用 exe 内嵌图标，无需设置）
  if (!app.isPackaged) {
    options.icon = path.join(app.getAppPath(), 'build/icon.ico')
  }

  mainWindow = new BrowserWindow(options)
  if (state?.maximized) mainWindow.maximize()

  // 避免窗口尺寸变化时出现白屏闪烁。
  // 回调引用局部实例而非模块变量（A10）：模块变量可能在窗口销毁时已被置 null
  const win = mainWindow
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    logger.info(
      `开发模式：加载开发服务器 ${process.env['ELECTRON_RENDERER_URL']}`,
    )
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  // 关闭时保存窗口状态（尺寸/位置/是否最大化），下次启动恢复。
  // 保存 promise 记录到模块变量，退出路径经 flushWindowStateSave 等待落盘（B12）
  mainWindow.on('close', () => {
    pendingStateSave = saveWindowState(mainWindow)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    // 同步销毁缩略图渲染窗口（B13）：隐藏窗口同样计入 window-all-closed
    // 判定，若残留会导致「主窗口已关、进程不退」的挂起；窗口关闭后也不
    // 再有缩略图后台任务的有效接收方
    destroyThumbRenderer()
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
    logger.error(
      `渲染进程异常退出: ${details.reason} (exitCode=${details.exitCode})`,
    )
  })

  // 渲染进程加载失败时的错误处理
  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription) => {
      logger.error(`页面加载失败: [${errorCode}] ${errorDescription}`)
    },
  )

  return mainWindow
}

/**
 * 获取当前主窗口实例（可能为 null）。
 */
export function getMainWindow() {
  return mainWindow
}

/**
 * 等待待完成的窗口状态保存落盘（B12）。
 * window-all-closed 的退出路径调用：app.quit() 会中断进行中的异步原子写，
 * 导致 window-state.json 未写或残留临时文件。
 */
export async function flushWindowStateSave() {
  if (pendingStateSave) {
    await pendingStateSave.catch(() => {})
    pendingStateSave = null
  }
}
