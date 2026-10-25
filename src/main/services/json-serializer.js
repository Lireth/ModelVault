import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import logger from '../logger'

/**
 * JSON 序列化线程（OPT-03）：
 *
 * 大库索引与元数据全量快照的 JSON.stringify 会在大对象上产生数十 MB 字符串，
 * 在主进程期间事件循环被持续占用（窗口卡顿、IPC 延迟）。本模块把序列化与
 * SHA256 计算移入独立 worker；worker 只做纯 CPU 工作，不接触磁盘。
 *
 * 解析对称通道（B1 读路径降载）：万级模型库的 index/store JSON 可达数十 MB，
 * 主线程 JSON.parse 同样会阻塞事件循环数百毫秒到数秒（启动加载、秒切库、
 * 局部扫描后的索引读改写、备份恢复全部途经）。parseJsonOffThread 按文本
 * 长度阈值分流：小文本留在主线程（省一次结构化克隆），大文本交给同一
 * worker 解析后结构化克隆回传。
 *
 * - 单例 worker 串行处理任务；任务带 id 路由与超时保护；
 * - worker 崩溃/超时/启动失败时，调用方自动回退到主线程 JSON.stringify/parse，
 *   保证索引/元数据落盘与加载语义不因线程问题而失败（解析错误照常抛出，
 *   调用方的损坏检测分支不受影响）；
 * - worker unref：常驻线程不阻止应用退出。
 */

/** 单任务序列化/解析超时（ms）：超时后终止 worker 并回退主线程 */
const SERIALIZE_TIMEOUT_MS = 30000
const PARSE_TIMEOUT_MS = 30000

/** 走 worker 解析的文本长度阈值：小于该值主线程解析更快（克隆开销大于收益） */
const PARSE_WORKER_THRESHOLD = 4 * 1024 * 1024
/** 阈值（测试可注入 0 强制走 worker） */
let parseWorkerThreshold = PARSE_WORKER_THRESHOLD

/** worker 源码：纯计算，无文件/Electron 能力 */
const WORKER_SOURCE = `
const { parentPort } = require('worker_threads')
const { createHash } = require('crypto')

parentPort.on('message', (msg) => {
  try {
    if (msg.op === 'parse') {
      parentPort.postMessage({ id: msg.id, op: 'parse', value: JSON.parse(msg.text) })
      return
    }
    const text = JSON.stringify(msg.value)
    const result = {
      id: msg.id,
      text,
      bytes: Buffer.byteLength(text, 'utf-8')
    }
    if (msg.hash) {
      result.hash = createHash('sha256')
        .update(msg.hashPrefix || '')
        .update(text)
        .digest('hex')
    }
    parentPort.postMessage(result)
  } catch (err) {
    parentPort.postMessage({ id: msg.id, error: err.message || String(err) })
  }
})
`

/** 单例 worker 与任务表 */
let worker = null
let nextTaskId = 0
const pending = new Map()

/** 主线程回退路径：文本 + 可选哈希 */
function serializeOnMainThread(value, hashPrefix, needHash) {
  const text = JSON.stringify(value)
  return {
    text,
    bytes: Buffer.byteLength(text, 'utf-8'),
    hash: needHash
      ? createHash('sha256')
          .update(hashPrefix || '')
          .update(text)
          .digest('hex')
      : '',
  }
}

/** 终止 worker 并拒绝全部在途任务（调用方会回退主线程） */
function failWorker(w, cause) {
  if (worker !== w) return
  worker = null
  try {
    w.terminate().catch(() => {})
  } catch {
    /* 已退出 */
  }
  const err = cause instanceof Error ? cause : new Error(String(cause))
  for (const [id, task] of [...pending]) {
    pending.delete(id)
    clearTimeout(task.timer)
    task.reject(err)
  }
}

/** 惰性创建 worker */
function ensureWorker() {
  if (worker) return worker
  const w = new Worker(WORKER_SOURCE, { eval: true })
  w.unref()
  w.on('message', (msg) => {
    if (worker !== w) return
    const task = pending.get(msg.id)
    if (!task) return
    pending.delete(msg.id)
    clearTimeout(task.timer)
    if (msg.error) task.reject(new Error(msg.error))
    else if (msg.op === 'parse') task.resolve(msg.value)
    else
      task.resolve({ text: msg.text, bytes: msg.bytes, hash: msg.hash || '' })
  })
  w.on('error', (err) => failWorker(w, err))
  w.on('exit', (code) => {
    if (worker !== w) return
    failWorker(w, new Error(`JSON 序列化线程已退出（code=${code}）`))
  })
  worker = w
  return w
}

/**
 * 在 worker 中序列化 JSON。
 * @param {any} value 待序列化值（必须可结构化克隆）
 * @param {{hash?: boolean, hashPrefix?: string, timeoutMs?: number}} [options]
 *   hash=true 时额外返回 SHA256；hashPrefix 参与哈希前缀
 * @returns {Promise<{text: string, bytes: number, hash: string}>}
 */
export async function serializeJsonOffThread(value, options = {}) {
  const needHash = options.hash === true
  const hashPrefix =
    typeof options.hashPrefix === 'string' ? options.hashPrefix : ''
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : SERIALIZE_TIMEOUT_MS
  try {
    const w = ensureWorker()
    const id = nextTaskId++
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        failWorker(w, new Error(`JSON 序列化超时（${timeoutMs}ms）`))
      }, timeoutMs)
      timer.unref?.()
      pending.set(id, { resolve, reject, timer })
      try {
        w.postMessage({ id, value, hash: needHash, hashPrefix })
      } catch (err) {
        pending.delete(id)
        clearTimeout(timer)
        reject(err)
      }
    })
  } catch (err) {
    logger.warn(`JSON 序列化线程不可用，回退主线程: ${err.message}`)
    return serializeOnMainThread(value, hashPrefix, needHash)
  }
}

/**
 * 在 worker 中解析大文本 JSON（B1 读路径降载）。
 * 文本长度低于阈值时直接在主线程解析（结构化克隆开销大于解析收益）；
 * 解析失败与主线程 JSON.parse 语义一致（抛出 Error，调用方的损坏检测
 * 分支不受影响）。
 * @param {string} text JSON 文本
 * @returns {Promise<any>} 解析结果
 */
export async function parseJsonOffThread(text) {
  if (typeof text !== 'string' || text.length < parseWorkerThreshold) {
    return JSON.parse(text)
  }
  try {
    const w = ensureWorker()
    const id = nextTaskId++
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        failWorker(w, new Error(`JSON 解析超时（${PARSE_TIMEOUT_MS}ms）`))
      }, PARSE_TIMEOUT_MS)
      timer.unref?.()
      pending.set(id, { resolve, reject, timer })
      try {
        w.postMessage({ id, op: 'parse', text })
      } catch (err) {
        pending.delete(id)
        clearTimeout(timer)
        reject(err)
      }
    })
  } catch (err) {
    logger.warn(`JSON 解析线程不可用，回退主线程: ${err.message}`)
    return JSON.parse(text)
  }
}

/** 注入解析阈值（仅供单元测试使用；生产代码严禁调用） */
export function setParseWorkerThresholdForTests(chars) {
  parseWorkerThreshold =
    Number.isFinite(chars) && chars >= 0 ? chars : PARSE_WORKER_THRESHOLD
}

/** 重置线程状态（仅供单元测试使用；生产代码严禁调用） */
export async function resetJsonSerializerForTests() {
  const w = worker
  if (w) failWorker(w, new Error('JSON 序列化线程已重置'))
  nextTaskId = 0
  parseWorkerThreshold = PARSE_WORKER_THRESHOLD
  if (w) await w.terminate().catch(() => {})
}
