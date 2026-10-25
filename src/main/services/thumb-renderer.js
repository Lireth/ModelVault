import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import logger from '../logger'

/**
 * 缩略图渲染服务（P2 主进程非阻塞改造）：
 *
 * 此前 generateThumb 经 nativeImage.createFromBuffer/resize/toJPEG 在主进程
 * 线程同步解码、缩放、编码——64MB 上限的源图单张解码可达数百毫秒，扫描后
 * 后台补齐缩略图期间主进程事件循环被持续挤占，所有 IPC 处理随之停摆。
 *
 * Electron 的 nativeImage 仅主进程可用、worker_threads 中不可获取，而本项目
 * 打包设计（零 node_modules、单一 portable exe）不宜引入 sharp 等原生依赖。
 * 故采用隐藏 BrowserWindow：解码/缩放/JPEG 编码经 Chromium（createImageBitmap
 * + OffscreenCanvas）在独立渲染进程中执行，结果以 ArrayBuffer 经 IPC 传回。
 * Chromium 原生编解码覆盖项目支持的全部封面格式（jpg/png/webp/gif/bmp）。
 *
 * 安全说明（OPT-01）：窗口仅加载 about:blank，页面本身不执行任何脚本；
 * 渲染逻辑收敛在独立 preload（src/preload/thumb-preload.js）中。窗口开启
 * sandbox/contextIsolation 并关闭 nodeIntegration——即使图片解码环节触发
 * 渲染进程漏洞，也无法获得 Node/文件系统能力。窗口空闲且无在途任务时
 * 自动销毁，回收隐藏渲染进程的常驻内存。
 */

/** 单任务渲染超时（ms）：渲染进程挂死/GPU 异常时兜底失败回退原图 */
const RENDER_TIMEOUT_MS = 20000

/** 空闲回收（ms）：无在途任务后保留窗口的时间，超时即销毁并等待下次惰性重建 */
const IDLE_DESTROY_MS = 60000

/** 隐藏窗口单例（惰性创建；异常退出/超时/空闲回收后销毁，下次任务重建） */
let win = null

/** 窗口就绪 promise（loadURL 完成，preload 已由 Electron 在页面加载前执行） */
let readyPromise = null

/** 任务派发序号 */
let nextTaskId = 0

/** 在途任务表：id -> { resolve, reject, timer } */
const pending = new Map()

/** 空闲回收定时器（无在途任务时启动） */
let idleTimer = null

/** 空闲回收时长（测试可注入小值） */
let idleTimeoutMs = IDLE_DESTROY_MS

/**
 * 缩略图 preload 绝对路径：主进程产物位于 out/main/index.js，
 * preload 与其同级位于 out/preload/thumb-preload.js。开发与打包目录结构一致。
 * @returns {string} preload 绝对路径
 */
function getThumbPreloadPath() {
  return path.join(app.getAppPath(), 'out', 'preload', 'thumb-preload.js')
}

/**
 * 判断给定 webContents 是否属于缩略图隐藏窗口（IPC 来源白名单用）。
 * 隐藏窗口的 preload 只需 on/send 两条缩略图通道；任何 invoke 调用都应
 * 在主进程入口被拒绝，避免图片解码环节被利用后进一步触达业务 IPC。
 * @param {import('electron').WebContents | null | undefined} contents
 * @returns {boolean}
 */
export function isThumbRendererContents(contents) {
  return Boolean(
    win && !win.isDestroyed() && contents && win.webContents === contents,
  )
}

/** 取消空闲回收（有新任务派发/窗口销毁时调用） */
function clearIdleTimer() {
  if (!idleTimer) return
  clearTimeout(idleTimer)
  idleTimer = null
}

/** 安排空闲回收：仅当窗口存在且没有在途任务时启动；重复调用幂等 */
function scheduleIdleDestroy() {
  if (idleTimer || pending.size > 0 || !win) return
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (pending.size > 0) return
    logger.info(`缩略图渲染窗口空闲 ${idleTimeoutMs}ms，已回收`)
    destroyWindow()
  }, idleTimeoutMs)
  idleTimer.unref?.()
}

/** 渲染任务超时上限（测试钩子：注入小值避免真实等待） */
let renderTimeoutMs = RENDER_TIMEOUT_MS

/**
 * 注入渲染超时上限（仅供单元测试使用；生产代码严禁调用）
 * @param {number} ms 超时毫秒数
 */
export function setThumbRenderTimeoutForTests(ms) {
  renderTimeoutMs = Number.isFinite(ms) && ms > 0 ? ms : RENDER_TIMEOUT_MS
}

/**
 * 注入空闲回收时长（仅供单元测试使用；生产代码严禁调用）
 * @param {number} ms 空闲毫秒数
 */
export function setThumbRendererIdleTimeoutForTests(ms) {
  idleTimeoutMs = Number.isFinite(ms) && ms > 0 ? ms : IDLE_DESTROY_MS
}

/** 拒绝全部在途任务并清空任务表 */
function failAll(err) {
  for (const task of pending.values()) {
    clearTimeout(task.timer)
    task.reject(err)
  }
  pending.clear()
}

/**
 * 销毁隐藏窗口（主窗口关闭/异常清理/空闲回收路径调用）。
 * 空闲定时器一并取消，避免对已销毁窗口重复调度。
 */
function destroyWindow() {
  clearIdleTimer()
  const w = win
  win = null
  readyPromise = null
  if (w && !w.isDestroyed()) w.destroy()
}

/**
 * 结算一条在途任务：清理超时计时器、移出 pending，按结果 resolve/reject；
 * 无剩余任务时安排空闲回收（OPT-01）。
 * @param {number} id 任务 id
 * @param {{value?: any, error?: Error}} outcome 成功值或失败错误（二选一）
 */
function settleTask(id, outcome) {
  const task = pending.get(id)
  if (!task) return
  pending.delete(id)
  clearTimeout(task.timer)
  if (outcome.error) task.reject(outcome.error)
  else task.resolve(outcome.value)
  scheduleIdleDestroy()
}

/**
 * 惰性创建隐藏渲染窗口：
 * - show:false + skipTaskbar：完全不可见，不进任务栏；
 * - sandbox/contextIsolation 开启、nodeIntegration 关闭（OPT-01）：页面与
 *   preload 均无 Node 能力，仅 preload 保留受限的 ipcRenderer；
 * - backgroundThrottling:false：隐藏窗口内 Promise/canvas 不被节流；
 * - loadURL 失败：readyPromise reject，本次任务报错回退原图。
 */
function ensureWindowReady() {
  clearIdleTimer()
  if (win && !win.isDestroyed() && readyPromise) return readyPromise
  destroyWindow()
  const w = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    webPreferences: {
      // 渲染逻辑收敛在专用 preload；页面为 about:blank，不执行任何页面脚本
      preload: getThumbPreloadPath(),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  })
  win = w

  // 渲染进程崩溃（GPU 异常等）：拒绝在途任务并销毁窗口，下次重建
  w.webContents.on('render-process-gone', () => {
    logger.warn('缩略图渲染进程异常退出，在途任务回退原图')
    destroyWindow()
    failAll(new Error('缩略图渲染进程异常退出'))
  })

  // preload 回传结果（ipcRenderer.send -> ipc-message 通道）
  w.webContents.on('ipc-message', (_event, channel, payload) => {
    if (channel !== 'thumb:done' || !payload || typeof payload.id !== 'number')
      return
    if (payload.error) {
      settleTask(payload.id, { error: new Error(payload.error) })
    } else if (payload.small) {
      settleTask(payload.id, { value: { small: true } })
    } else if (payload.jpeg) {
      settleTask(payload.id, { value: { jpeg: Buffer.from(payload.jpeg) } })
    } else {
      settleTask(payload.id, { error: new Error('缩略图渲染响应无效') })
    }
  })

  readyPromise = (async () => {
    await w.loadURL('about:blank')
    if (w.isDestroyed()) throw new Error('缩略图渲染窗口已销毁')
  })()
  // 初始化失败（loadURL 异常）：记日志并销毁窗口，使下次调用走全新创建
  // 而非复用已失败的 readyPromise（否则后续任务永久失败）；挂起在途任务
  // 由各自 await 的 readyPromise 按错误回退原图
  const current = readyPromise
  readyPromise.catch((err) => {
    logger.warn(`缩略图渲染窗口初始化失败: ${err.message}`)
    if (readyPromise === current) destroyWindow()
  })
  return readyPromise
}

/**
 * 在隐藏渲染进程中解码源图并生成 JPEG 缩略图。
 * @param {Buffer} buffer 源图完整字节（调用方已做大小上限预检）
 * @param {{thumbWidth: number, minSourceWidth: number, quality: number}} opts
 *   缩略图目标宽度 / 免缩放最小源宽 / JPEG 质量（0-1）
 * @returns {Promise<{small: true} | {jpeg: Buffer}>}
 *   small：源图宽度未超过 minSourceWidth，无需缩放（调用方回退原图）；
 *   jpeg：缩放编码后的 JPEG 字节
 */
export async function renderThumbJpeg(buffer, opts) {
  return dispatchThumbTask({ buf: buffer, ...opts })
}

/**
 * 按 mvimg:// 地址在隐藏渲染进程中读取并生成缩略图（OP-03 生产链路）。
 * 源图字节只存在于渲染进程，主进程不再整图读入与 IPC 复制，大封面的
 * 内存峰值与跨进程拷贝开销显著降低。
 * @param {string} url 源图 mvimg:// 地址（由调用方经 toImageUrl 构造）
 * @param {{thumbWidth: number, minSourceWidth: number, quality: number}} opts
 * @returns {Promise<{small: true} | {jpeg: Buffer}>}
 */
export async function renderThumbFromPath(url, opts) {
  if (typeof url !== 'string' || !url) {
    return Promise.reject(new Error('无效的源图地址'))
  }
  return dispatchThumbTask({ url, ...opts })
}

/**
 * 派发一次缩略图渲染任务并等待结果。
 * @param {object} payload 任务载荷（buf 或 url + 渲染参数）
 * @returns {Promise<{small: true} | {jpeg: Buffer}>}
 */
function dispatchThumbTask(payload) {
  clearIdleTimer()
  const ready = ensureWindowReady()
  const id = nextTaskId++
  return new Promise((resolve, reject) => {
    const task = { resolve, reject, timer: null }
    pending.set(id, task)
    task.timer = setTimeout(() => {
      // 超时：渲染进程已不可信（挂死/GPU 异常），拒绝全部在途任务并销毁窗口，
      // 下次任务经 ensureWindowReady 重建全新实例
      failAll(new Error(`缩略图渲染超时（${renderTimeoutMs}ms）`))
      destroyWindow()
    }, renderTimeoutMs)
    ready
      .then(() => {
        const w = win
        if (!w || w.isDestroyed()) throw new Error('缩略图渲染窗口不可用')
        w.webContents.send('thumb:render', { id, ...payload })
      })
      .catch((err) => {
        settleTask(id, { error: err })
      })
  })
}

/**
 * 销毁缩略图渲染窗口并拒绝全部在途任务：
 * 主窗口 closed 时必须调用——隐藏窗口同样计入 window-all-closed 判定，
 * 残留的隐藏窗口会导致「主窗口已关、进程不退」的挂起（B13）。
 */
export function destroyThumbRenderer() {
  failAll(new Error('缩略图渲染服务已销毁'))
  destroyWindow()
}
