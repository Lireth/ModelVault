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
 * - 单例 worker 串行处理任务；任务带 id 路由与超时保护；
 * - worker 崩溃/超时/启动失败时，调用方自动回退到主线程 JSON.stringify，
 *   保证索引/元数据落盘语义不因线程问题而失败；
 * - worker unref：常驻线程不阻止应用退出。
 */

/** 单任务序列化超时（ms）：超时后终止 worker 并回退主线程 */
const SERIALIZE_TIMEOUT_MS = 30000

/** worker 源码：纯计算，无文件/Electron 能力 */
const WORKER_SOURCE = `
const { parentPort } = require('worker_threads')
const { createHash } = require('crypto')

parentPort.on('message', (msg) => {
  try {
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

/** 重置线程状态（仅供单元测试使用；生产代码严禁调用） */
export async function resetJsonSerializerForTests() {
  const w = worker
  if (w) failWorker(w, new Error('JSON 序列化线程已重置'))
  nextTaskId = 0
  if (w) await w.terminate().catch(() => {})
}
