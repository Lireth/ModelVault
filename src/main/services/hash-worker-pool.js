import { Worker } from 'node:worker_threads'
import logger from '../logger'

/**
 * 模型文件 SHA256 计算的后台线程池（P1 主进程非阻塞改造）：
 *
 * 此前 computeFileHash 虽以异步 fs 分块读盘，但 hash.update() 是同步 CPU
 * 工作，运行在主进程事件循环上——1-10GB 模型文件的哈希预热/识别期间，
 * 主进程被持续占用，IPC 响应出现毫秒级抖动。本模块把「读盘 + 哈希」整体
 * 移入 worker_threads：主进程只负责派发任务、转发进度与接收结果，事件循环
 * 在数 GB 哈希期间保持空闲。
 *
 * 设计要点：
 * - 单 worker + 内部 FIFO 队列（并发 1）：与 hash-warmup「单文件串行处理，
 *   避免多路大文件读取争抢磁盘 I/O」的既有约定一致，本模块是串行语义的
 *   唯一执行点——调用方（预热/识别链路）无需关心排队；
 * - 内联源码（eval: true）：worker 代码以字符串内置，规避 electron-vite
 *   主进程 bundle 的额外 entry 配置与 vitest ESM 环境下的 worker 文件路径
 *   解析问题，dev/打包/测试三环境行为完全一致；
 * - 取消：AbortSignal 触发时主进程立即 reject 并向 worker 发 abort 消息，
 *   worker 在下一读块边界检查后中止（在途读块最多 8MB 的收尾开销）；
 * - 崩溃自愈：worker 异常退出时拒绝当前任务与队列中全部任务（明确报错，
 *   不静默吞掉），下次调用时惰性重建 worker。
 */

/** worker 读块大小（8MB）：大文件吞吐与内存占用的平衡点（原 civitai.js HASH_CHUNK_SIZE） */
const WORKER_CHUNK_SIZE = 8 * 1024 * 1024

/**
 * worker 内联源码（CJS，eval 模式）：
 * 消息协议——
 * 入：{ type: 'hash', id, filePath } 派发任务；{ type: 'abort', id } 请求取消当前任务
 * 出：{ type: 'progress', id, hashedBytes, totalBytes }（每读块一次）；
 *     { type: 'done', id, hash } 成功；{ type: 'done', id, error, name } 失败（含取消）。
 * 任务严格串行：主进程侧并发为 1，worker 内 aborted 标志只作用于当前任务
 * （任务开始时复位，abort 消息不会泄漏到后续任务）。
 */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const CHUNK = ${WORKER_CHUNK_SIZE}
let aborted = false
parentPort.on('message', (msg) => {
  if (msg && msg.type === 'abort') aborted = true
  if (!msg || msg.type !== 'hash') return
  aborted = false
  const { id, filePath } = msg
  ;(async () => {
    const handle = await fs.open(filePath, 'r')
    try {
      const hash = createHash('sha256')
      const buffer = Buffer.alloc(CHUNK)
      const totalBytes = (await handle.stat()).size
      let position = 0
      for (;;) {
        if (aborted) {
          const err = new Error('已取消')
          err.name = 'AbortError'
          throw err
        }
        const { bytesRead } = await handle.read(buffer, 0, CHUNK, position)
        if (bytesRead === 0) break
        hash.update(buffer.subarray(0, bytesRead))
        position += bytesRead
        parentPort.postMessage({ type: 'progress', id, hashedBytes: position, totalBytes })
      }
      parentPort.postMessage({ type: 'done', id, hash: hash.digest('hex') })
    } finally {
      await handle.close()
    }
  })().catch((err) => {
    parentPort.postMessage({ type: 'done', id, error: err.message, name: err.name })
  })
})
`

/** 构造取消异常（与调用方既有 AbortError 识别约定一致） */
function abortError() {
  const err = new Error('已取消')
  err.name = 'AbortError'
  return err
}

/** 单例 worker（惰性创建；异常退出后置 null，下次任务重建） */
let worker = null

/** 派发序号：任务 id 单调递增，worker 消息按 id 回路由 */
let nextTaskId = 0

/**
 * 双通道任务队列（worker 并发 1：同一时刻至多一个在途任务）：
 * - foreground：详情页/识别/预热 priority 任务，优先出队；
 * - background：批量预热等后台任务，让路于前台。
 * 两个队列仍严格串行执行，优先级只影响取队顺序。
 */
const foregroundQueue = []
const backgroundQueue = []

/** 当前在途任务（null 表示空闲） */
let currentTask = null

/** 构造“后台任务已让路”错误（仅线程池内部使用） */
function preemptedError() {
  const err = new Error('后台哈希任务已让路')
  err.name = 'PreemptedError'
  return err
}

/**
 * 惰性创建 worker 并绑定消息路由：
 * - progress：按 id 匹配任务并转发 onProgress 回调；
 * - done：按 id 结算任务（成功/失败），空闲后立即泵出下一任务；
 * - error / exit：worker 崩溃——拒绝当前与队列中全部任务，置空待重建。
 */
function ensureWorker() {
  if (worker) return worker
  const w = new Worker(WORKER_SOURCE, { eval: true })
  // unref：哈希预热是后台任务，不得阻止应用退出（退出编排不感知本线程）
  w.unref()
  w.on('message', (msg) => {
    if (!msg || typeof msg.id !== 'number') return
    const task = currentTask
    if (!task || task.id !== msg.id) return
    if (msg.type === 'progress') {
      if (typeof task.onProgress === 'function') {
        task.onProgress(msg.hashedBytes, msg.totalBytes)
      }
      return
    }
    if (msg.type === 'done') {
      // 后台任务被前台抢占：worker 在块边界中止后回传 AbortError。
      // 这里不自动重排（由哈希预热层按任务语义重新入队），只把错误类型
      // 改为 PreemptedError，避免上层把让路误报为“计算失败”。
      const preempted = task.preempting && msg.name === 'AbortError'
      settleCurrent()
      if (preempted) {
        task.reject(preemptedError())
      } else if (msg.error !== undefined) {
        const err = new Error(msg.error)
        if (msg.name) err.name = msg.name
        task.reject(err)
      } else {
        task.resolve(msg.hash)
      }
      pump()
    }
  })
  w.on('error', (err) => failAll(new Error(`哈希工作线程异常: ${err.message}`)))
  w.on('exit', (code) => {
    // 0 为正常终止（仅测试 reset 路径），非 0 视为崩溃
    if (code !== 0) failAll(new Error(`哈希工作线程已退出（code=${code}）`))
  })
  worker = w
  return w
}

/** 结束当前在途任务的占位（仅状态清理，结算本身由消息路由完成） */
function settleCurrent() {
  if (currentTask?.abortListener) {
    currentTask.signal?.removeEventListener('abort', currentTask.abortListener)
  }
  currentTask = null
}

/** 从队列取下一个未取消任务（前台优先，后台兜底） */
function nextTask() {
  for (const queue of [foregroundQueue, backgroundQueue]) {
    while (queue.length > 0) {
      const task = queue.shift()
      if (!task.settled) return task
    }
  }
  return null
}

/**
 * 入队并按需抢占：前台任务入队时，若当前正在执行后台任务，
 * 通知 worker 在下一读块边界中止；等 worker 回传 done 后再启动前台任务，
 * 避免新旧任务并发读写同一个 worker 的共享 abort 标志。
 */
function enqueueTask(task) {
  if (task.priority) {
    foregroundQueue.push(task)
    if (currentTask && !currentTask.priority && !currentTask.preempting && worker) {
      currentTask.preempting = true
      worker.postMessage({ type: 'abort', id: currentTask.id })
    }
  } else {
    backgroundQueue.push(task)
  }
  pump()
}

/** 从两个队列中移除指定任务（取消排队任务用） */
function dequeueTask(task) {
  for (const queue of [foregroundQueue, backgroundQueue]) {
    const idx = queue.indexOf(task)
    if (idx >= 0) {
      queue.splice(idx, 1)
      return true
    }
  }
  return false
}

/**
 * 从队列泵出下一任务（串行）：前台优先；队列中已取消的任务直接跳过。
 */
function pump() {
  if (currentTask) return
  const task = nextTask()
  if (!task) return
  currentTask = task
  ensureWorker().postMessage({ type: 'hash', id: task.id, filePath: task.filePath })
}

/** worker 崩溃：拒绝当前与队列中全部任务，重建延迟到下次调用 */
function failAll(err) {
  if (currentTask) {
    const task = currentTask
    settleCurrent()
    task.reject(err)
  }
  for (const queue of [foregroundQueue, backgroundQueue]) {
    while (queue.length > 0) {
      const task = queue.shift()
      if (!task.settled) {
        task.settled = true
        if (task.abortListener) task.signal?.removeEventListener('abort', task.abortListener)
        task.reject(err)
      }
    }
  }
  if (worker) {
    const w = worker
    // 必须先置空再终止：terminate 触发的 exit 事件经 failAll 幂等清理
    // （队列已空、current 已空），而下次 ensureWorker 会重建新实例——
    // 若仍指向已终止实例，postMessage 将被静默丢弃导致任务永久挂起
    worker = null
    w.terminate().catch(() => {})
  }
}

/**
 * 在后台线程流式计算文件 SHA256（hex 小写）。
 * 与原主进程实现语义一致：分块读取（8MB）、进度按块回调、AbortSignal 取消
 * 抛 AbortError；差别仅在于读盘与哈希 CPU 工作整体不在主进程线程执行。
 * @param {string} filePath 文件绝对路径
 * @param {AbortSignal} [signal] 取消信号（可选）
 * @param {(hashedBytes: number, totalBytes: number) => void} [onProgress]
 *   哈希进度回调（可选，每块读取后触发）
 * @param {{priority?: boolean}} [options] priority=true 为前台任务：
 *   优先于排队中的后台任务，并可在块边界抢占在途后台任务（OPT-08）
 * @returns {Promise<string>} 64 位十六进制哈希
 */
export function computeFileHashOffThread(filePath, signal, onProgress, options = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const task = {
      id: nextTaskId++,
      filePath,
      signal,
      onProgress,
      priority: options.priority === true,
      preempting: false,
      abortListener: null,
      settled: false,
      resolve: (hash) => {
        task.settled = true
        resolve(hash)
      },
      reject: (err) => {
        task.settled = true
        reject(err)
      }
    }
    task.abortListener = () => {
      if (task.settled) return
      if (currentTask === task) {
        // 在途任务：通知 worker 在下一块边界中止，主进程立即返回；
        // 泵出队列中的下一任务，避免取消后串行链停摆
        worker?.postMessage({ type: 'abort', id: task.id })
        settleCurrent()
        task.reject(abortError())
        pump()
      } else if (dequeueTask(task)) {
        // 尚在队列：直接出队结算
        task.settled = true
        task.reject(abortError())
      }
    }
    signal?.addEventListener('abort', task.abortListener, { once: true })
    enqueueTask(task)
  })
}

/* ---------------- 仅供单元测试使用 ---------------- */

/** 终止 worker 并清空全部内部状态（测试隔离用；生产代码严禁调用） */
export async function resetHashPoolForTests() {
  failAll(new Error('哈希线程池已重置'))
  const w = worker
  worker = null
  nextTaskId = 0
  if (w) await w.terminate().catch(() => {})
  logger.info('哈希线程池已重置（测试）')
}
