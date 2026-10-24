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
 * - 崩溃自愈（OPT-05）：worker 崩溃时当前任务以可重试的 WorkerCrashError
 *   拒绝，队列中尚未开始的任务保留，worker 退避重建后继续消费；连续崩溃
 *   超过阈值时以 WorkerUnavailableError 拒绝剩余队列，避免无限重建。
 */

/** worker 读块大小（8MB）：大文件吞吐与内存占用的平衡点（原 civitai.js HASH_CHUNK_SIZE） */
const WORKER_CHUNK_SIZE = 8 * 1024 * 1024

/** 崩溃后重启基础延迟（ms）：首次 250ms，按连续崩溃次数指数退避 */
const RESTART_BASE_DELAY_MS = 250
/** 崩溃后重启最大延迟（ms） */
const RESTART_MAX_DELAY_MS = 4000
/** 连续崩溃上限：达到后拒绝剩余队列，避免 worker 启动失败时无限重建 */
const MAX_CRASH_STREAK = 3

/**
 * worker 内联源码（CJS，eval 模式）：
 * 消息协议——
 * 入：{ type: 'hash', id, filePath } 派发任务；{ type: 'abort', id } 请求取消当前任务
 * 出：{ type: 'progress', id, hashedBytes, totalBytes }（每读块一次）；
 *     { type: 'done', id, hash } 成功；
 *     { type: 'done', id, error, name, code } 失败（含取消；code 供上层识别
 *     可重试的临时文件错误）。
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
    parentPort.postMessage({
      type: 'done',
      id,
      error: err.message,
      name: err.name,
      code: err.code
    })
  })
})
`

/** 构造取消异常（与调用方既有 AbortError 识别约定一致） */
function abortError() {
  const err = new Error('已取消')
  err.name = 'AbortError'
  return err
}

/**
 * 线程池崩溃异常：当前任务可安全重试（哈希从文件头重新计算，无中间状态）。
 * @param {string} message 错误文案
 * @returns {Error}
 */
function workerCrashError(message) {
  const err = new Error(message)
  err.name = 'WorkerCrashError'
  return err
}

/**
 * 线程池连续崩溃后不可用异常：调用方应停止重试并反馈失败。
 * @param {string} message 错误文案
 * @returns {Error}
 */
function workerUnavailableError(message) {
  const err = new Error(message)
  err.name = 'WorkerUnavailableError'
  return err
}

/** 可重试的临时文件错误码（文件被占用/句柄耗尽等，稍后重试可能成功） */
const RETRYABLE_FILE_CODES = new Set(['EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'EOF', 'EPIPE'])

/**
 * 是否属于可重试的线程池/临时文件错误（OPT-05）：
 * 仅覆盖 worker 崩溃、连续不可用与明确的临时文件错误；ENOENT/EACCES/
 * 文件损坏等永久错误不重试，避免无效读盘循环。
 * @param {any} err 错误对象
 * @returns {boolean}
 */
export function isRetryableHashPoolError(err) {
  if (!err) return false
  if (err.name === 'WorkerCrashError' || err.name === 'WorkerUnavailableError') return true
  return typeof err.code === 'string' && RETRYABLE_FILE_CODES.has(err.code)
}

/** 单例 worker（惰性创建；异常退出后置 null，下次任务重建） */
let worker = null

/** 派发序号：任务 id 单调递增，worker 消息按 id 回路由 */
let nextTaskId = 0

/** 崩溃重启定时器与连续崩溃计数（OPT-05） */
let restartTimer = null
let crashStreak = 0

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
 * - error / exit：worker 崩溃——当前任务以 WorkerCrashError 拒绝，队列保留
 *   并退避重建后继续消费（OPT-05）。
 */
function ensureWorker() {
  if (worker) return worker
  const w = new Worker(WORKER_SOURCE, { eval: true })
  // unref：哈希预热是后台任务，不得阻止应用退出（退出编排不感知本线程）
  w.unref()
  w.on('message', (msg) => {
    // 代际防护：崩溃重建后旧 worker 的迟到消息必须丢弃
    if (worker !== w) return
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
      // worker 正常回传任一结果即视为健康，清零连续崩溃计数
      crashStreak = 0
      // 后台任务被前台抢占：worker 在块边界中止后回传 AbortError。
      // 这里不自动重排（由哈希预热层按任务语义重新入队），只把错误类型
      // 改为 PreemptedError，避免上层把让路误报为“计算失败”。
      const preempted = task.preempting && msg.name === 'AbortError'
      settleCurrent()
      if (preempted) {
        task.reject(preemptedError())
      } else if (msg.error !== undefined) {
        const err = /** @type {Error & {code?: string}} */ (new Error(msg.error))
        if (msg.name) err.name = msg.name
        if (msg.code) err.code = msg.code
        task.reject(err)
      } else {
        task.resolve(msg.hash)
      }
      pump()
    }
  })
  w.on('error', (err) => {
    if (worker !== w) return
    handleWorkerFailure(w, err)
  })
  w.on('exit', (code) => {
    // reset 路径先置空 worker 再 terminate，此处代际校验会忽略；
    // 其余退出均按崩溃处理（含 code=0 的非预期退出）
    if (worker !== w) return
    handleWorkerFailure(w, new Error(`哈希工作线程已退出（code=${code}）`))
  })
  worker = w
  return w
}

/** 取消待执行的重启定时器 */
function clearRestartTimer() {
  if (!restartTimer) return
  clearTimeout(restartTimer)
  restartTimer = null
}

/**
 * 拒绝队列中尚未开始的任务（连续崩溃达到上限/线程池重置）。
 * @param {Error} err 拒绝原因
 */
function rejectQueued(err) {
  for (const queue of [foregroundQueue, backgroundQueue]) {
    while (queue.length > 0) {
      const task = queue.shift()
      if (task.settled) continue
      task.settled = true
      if (task.abortListener) task.signal?.removeEventListener('abort', task.abortListener)
      task.reject(err)
    }
  }
}

/**
 * 记录一次崩溃并安排退避重启：
 * - 队列为空：本轮崩溃预算归零，不主动重建（等待下一次调用惰性创建）；
 * - 连续崩溃未达上限：按 250ms→4s 指数退避后继续消费队列；
 * - 达到上限：拒绝剩余队列，避免 worker 持续启动失败时无限重建。
 */
function recordCrash() {
  crashStreak += 1
  if (foregroundQueue.length === 0 && backgroundQueue.length === 0) {
    crashStreak = 0
    return
  }
  if (crashStreak >= MAX_CRASH_STREAK) {
    rejectQueued(workerUnavailableError('哈希工作线程连续崩溃，已停止重建'))
    crashStreak = 0
    return
  }
  const delay = Math.min(
    RESTART_BASE_DELAY_MS * 2 ** Math.max(0, crashStreak - 1),
    RESTART_MAX_DELAY_MS
  )
  if (restartTimer) return
  restartTimer = setTimeout(() => {
    restartTimer = null
    pump()
  }, delay)
  restartTimer.unref?.()
}

/**
 * worker 崩溃处理：置空实例、终止残留、拒绝当前任务并进入重启流程。
 * @param {Worker} w 崩溃的 worker 实例
 * @param {Error} cause 崩溃原因
 */
function handleWorkerFailure(w, cause) {
  if (worker !== w) return
  worker = null
  try {
    w.terminate().catch(() => {})
  } catch {
    /* 进程已退出 */
  }
  const task = currentTask
  if (task) {
    settleCurrent()
    task.reject(workerCrashError(`哈希工作线程异常: ${cause.message}`))
  }
  recordCrash()
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
  // 新任务到达时无需继续等待退避：立即尝试重建并派发
  clearRestartTimer()
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
  if (currentTask || restartTimer) return
  const task = nextTask()
  if (!task) return
  currentTask = task
  let w
  try {
    w = ensureWorker()
  } catch (err) {
    const failure = workerCrashError(`哈希工作线程创建失败: ${err.message}`)
    settleCurrent()
    task.reject(failure)
    recordCrash()
    return
  }
  try {
    w.postMessage({ type: 'hash', id: task.id, filePath: task.filePath })
  } catch (err) {
    // postMessage 失败通常意味着 worker 已终止：按崩溃路径重建
    handleWorkerFailure(w, err)
  }
}

/** 线程池重置：清除重启计划并拒绝当前与队列中全部任务 */
function failAll(err) {
  clearRestartTimer()
  crashStreak = 0
  if (currentTask) {
    const task = currentTask
    settleCurrent()
    task.reject(err)
  }
  rejectQueued(err)
  if (worker) {
    const w = worker
    // 先置空再终止：terminate 触发的 exit 事件经代际校验忽略，
    // 避免旧实例的退出误伤随后重建的新 worker
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
  const w = worker
  failAll(new Error('哈希线程池已重置'))
  nextTaskId = 0
  if (w) await w.terminate().catch(() => {})
  logger.info('哈希线程池已重置（测试）')
}

/**
 * 强制终止当前 worker，模拟崩溃（仅供单元测试使用；生产代码严禁调用）。
 * 不清理当前任务/队列，使退出事件走真实崩溃恢复路径。
 * @returns {boolean} 是否存在可终止的 worker
 */
export function crashHashWorkerForTests() {
  if (!worker) return false
  worker.terminate().catch(() => {})
  return true
}
