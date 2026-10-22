import { BrowserWindow } from 'electron'
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
 * 安全说明：窗口为本应用自有的空页面（about:blank），不加载任何远程内容，
 * 仅执行内置的渲染脚本；nodeIntegration 仅用于该脚本内获取 ipcRenderer。
 */

/** 单任务渲染超时（ms）：渲染进程挂死/GPU 异常时兜底失败回退原图 */
const RENDER_TIMEOUT_MS = 20000

/** 隐藏窗口单例（惰性创建；异常退出/超时后销毁，下次任务重建） */
let win = null

/** 窗口就绪 promise（loadURL + 渲染脚本安装完成） */
let readyPromise = null

/** 任务派发序号 */
let nextTaskId = 0

/** 在途任务表：id -> { resolve, reject, timer } */
const pending = new Map()

/**
 * 渲染进程侧脚本（经 executeJavaScript 安装，幂等）：
 * 消息协议——
 * 入：{ id, buf, thumbWidth, minSourceWidth, quality }（webContents.send）
 * 出：{ id, small: true } 源图宽度不足免缩放；{ id, jpeg: Uint8Array } 成功；
 *     { id, error } 解码/编码失败（损坏文件、不支持格式等）。
 * 与原 nativeImage 实现的行为对齐：宽度 <= minSourceWidth 返回 small（调用方
 * 回退原图）；解码失败返回 error（调用方回退原图，等价原 isEmpty() 分支）。
 */
const RENDERER_SCRIPT = `
;(function () {
  if (window.__mvThumbRenderer) return
  window.__mvThumbRenderer = true
  const { ipcRenderer } = require('electron')
  ipcRenderer.on('thumb:render', async (_e, task) => {
    const { id, buf, thumbWidth, minSourceWidth, quality } = task
    let bitmap = null
    try {
      bitmap = await createImageBitmap(new Blob([buf]))
      if (bitmap.width <= minSourceWidth) {
        ipcRenderer.send('thumb:done', { id, small: true })
        return
      }
      const height = Math.max(1, Math.round((bitmap.height * thumbWidth) / bitmap.width))
      const canvas = new OffscreenCanvas(thumbWidth, height)
      canvas.getContext('2d').drawImage(bitmap, 0, 0, thumbWidth, height)
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality })
      ipcRenderer.send('thumb:done', { id, jpeg: new Uint8Array(await blob.arrayBuffer()) })
    } catch (err) {
      ipcRenderer.send('thumb:done', { id, error: (err && err.message) || String(err) })
    } finally {
      if (bitmap) bitmap.close()
    }
  })
})()
`

/** 渲染任务超时上限（测试钩子：注入小值避免真实等待） */
let renderTimeoutMs = RENDER_TIMEOUT_MS

/**
 * 注入渲染超时上限（仅供单元测试使用；生产代码严禁调用）
 * @param {number} ms 超时毫秒数
 */
export function setThumbRenderTimeoutForTests(ms) {
  renderTimeoutMs = Number.isFinite(ms) && ms > 0 ? ms : RENDER_TIMEOUT_MS
}

/** 拒绝全部在途任务并清空任务表 */
function failAll(err) {
  for (const task of pending.values()) {
    clearTimeout(task.timer)
    task.reject(err)
  }
  pending.clear()
}

/** 销毁隐藏窗口（主窗口关闭/异常清理路径调用） */
function destroyWindow() {
  const w = win
  win = null
  readyPromise = null
  if (w && !w.isDestroyed()) w.destroy()
}

/**
 * 惰性创建隐藏渲染窗口并安装渲染脚本：
 * - show:false + skipTaskbar：完全不可见，不进任务栏；
 * - backgroundThrottling:false：隐藏窗口内 Promise/canvas 不被节流；
 * - loadURL 失败/渲染脚本安装失败：readyPromise reject，本次任务报错回退。
 */
function ensureWindowReady() {
  if (win && !win.isDestroyed() && readyPromise) return readyPromise
  destroyWindow()
  const w = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    webPreferences: {
      // 渲染脚本经 executeJavaScript 安装，需要 nodeIntegration 获取 ipcRenderer；
      // 页面为本应用自有空页（about:blank），无远程内容，攻击面可控
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false
    }
  })
  win = w

  // 渲染进程崩溃（GPU 异常等）：拒绝在途任务并销毁窗口，下次重建
  w.webContents.on('render-process-gone', () => {
    logger.warn('缩略图渲染进程异常退出，在途任务回退原图')
    destroyWindow()
    failAll(new Error('缩略图渲染进程异常退出'))
  })

  // 渲染进程回传结果（ipcRenderer.send -> ipc-message 通道）
  w.webContents.on('ipc-message', (_event, channel, payload) => {
    if (channel !== 'thumb:done' || !payload || typeof payload.id !== 'number') return
    const task = pending.get(payload.id)
    if (!task) return
    pending.delete(payload.id)
    clearTimeout(task.timer)
    if (payload.error) {
      task.reject(new Error(payload.error))
    } else if (payload.small) {
      task.resolve({ small: true })
    } else if (payload.jpeg) {
      task.resolve({ jpeg: Buffer.from(payload.jpeg) })
    } else {
      task.reject(new Error('缩略图渲染响应无效'))
    }
  })

  readyPromise = (async () => {
    await w.loadURL('about:blank')
    if (w.isDestroyed()) throw new Error('缩略图渲染窗口已销毁')
    await w.webContents.executeJavaScript(RENDERER_SCRIPT)
  })()
  // 初始化失败（loadURL/executeJavaScript 异常）：记日志并销毁窗口，使下次
  // 调用走全新创建而非复用已失败的 readyPromise（否则后续任务永久失败）；
  // 挂起在途任务由各自 await 的 readyPromise 按错误回退原图
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
  const ready = ensureWindowReady()
  const id = nextTaskId++
  return new Promise((resolve, reject) => {
    const task = { resolve, reject, timer: null }
    pending.set(id, task)
    task.timer = setTimeout(() => {
      // 超时：拒绝本任务并销毁窗口——渲染进程已不可信（挂死/GPU 异常），
      // 下次任务经 ensureWindowReady 重建全新实例
      pending.delete(id)
      destroyWindow()
      reject(new Error(`缩略图渲染超时（${renderTimeoutMs}ms）`))
    }, renderTimeoutMs)
    ready
      .then(() => {
        const w = win
        if (!w || w.isDestroyed()) throw new Error('缩略图渲染窗口不可用')
        w.webContents.send('thumb:render', { id, buf: buffer, ...opts })
      })
      .catch((err) => {
        pending.delete(id)
        clearTimeout(task.timer)
        reject(err)
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
