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
 * - 多槽位并行（OPT-3）：并发数经 setHashPoolConcurrency 配置（1-4，默认 1）。
 *   默认串行：与 hash-warmup「单文件串行处理，避免多路大文件读取争抢磁盘
 *   I/O」的既有约定一致；SSD/NVMe 用户可调高并发加快全库预热。每个槽位
 *   持有独立 worker 与在途任务，槽位间互不共享 abort 标志；
 * - 内联源码（eval: true）：worker 代码以字符串内置，规避 electron-vite
 *   主进程 bundle 的额外 entry 配置与 vitest ESM 环境下的 worker 文件路径
 *   解析问题，dev/打包/测试三环境行为完全一致；
 * - 取消：AbortSignal 触发时主进程立即 reject 并向所在槽位的 worker 发
 *   abort 消息，worker 在下一读块边界检查后中止（在途读块最多 8MB 的收尾
 *   开销）；排队中的任务直接出队结算；
 * - 优先级（OPT-08）：前台任务优先出队；前台到达且所有槽位都被后台任务
 *   占用时，抢占其中一个后台槽位（块边界中止），其余后台任务继续执行——
 *   多槽位下不再需要「整池让路」；
 * - 崩溃自愈（OPT-05）：worker 崩溃时当前任务以可重试的 WorkerCrashError
 *   拒绝，队列中尚未开始的任务保留，退避重建后继续消费；连续崩溃超过阈值
 *   时以 WorkerUnavailableError 拒绝剩余队列，避免无限重建；
 * - 缩容（OPT-3）：并发调小时，空闲的超额槽位立即关闭，在途槽位完成当前
 *   任务后不再接受新任务（惰性回收，不中断计算）。
 */

/** worker 读块大小（8MB）：大文件吞吐与内存占用的平衡点（原 civitai.js HASH_CHUNK_SIZE） */
const WORKER_CHUNK_SIZE = 8 * 1024 * 1024

/** 崩溃后重启基础延迟（ms）：首次 250ms，按连续崩溃次数指数退避 */
const RESTART_BASE_DELAY_MS = 250
/** 崩溃后重启最大延迟（ms） */
const RESTART_MAX_DELAY_MS = 4000
/** 连续崩溃上限：达到后拒绝剩余队列，避免 worker 启动失败时无限重建 */
const MAX_CRASH_STREAK = 3

/** 并发数合法区间（OPT-3）：1 = 串行（默认），4 = 上限 */
const MIN_POOL_CONCURRENCY = 1
const MAX_POOL_CONCURRENCY = 4

/**
 * worker 内联源码（CJS，eval 模式）：
 * 消息协议——
 * 入：{ type: 'hash', id, filePath } 派发任务；{ type: 'abort', id } 请求取消当前任务
 * 出：{ type: 'progress', id, hashedBytes, totalBytes }（每读块一次）；
 *     { type: 'done', id, hash } 成功；
 *     { type: 'done', id, error, name, code } 失败（含取消；code 供上层识别
 *     可重试的临时文件错误）。
 * 单 worker 内任务严格串行（并发由多槽位实现）：worker 内 aborted 标志只
 * 作用于当前任务（任务开始时复位，abort 消息不会泄漏到后续任务）。
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
const RETRYABLE_FILE_CODES = new Set([
  'EBUSY',
  'EAGAIN',
  'EMFILE',
  'ENFILE',
  'EOF',
  'EPIPE',
])

/**
 * 是否属于可重试的线程池/临时文件错误（OPT-05）：
 * 仅覆盖 worker 崩溃、连续不可用与明确的临时文件错误；ENOENT/EACCES/
 * 文件损坏等永久错误不重试，避免无效读盘循环。
 * @param {any} err 错误对象
 * @returns {boolean}
 */
export function isRetryableHashPoolError(err) {
  if (!err) return false
  if (err.name === 'WorkerCrashError' || err.name === 'WorkerUnavailableError')
    return true
  return typeof err.code === 'string' && RETRYABLE_FILE_CODES.has(err.code)
}

/**
 * 池内任务（computeFileHashOffThread 构造，消息路由/取消/结算共用）：
 * @typedef {object} HashPoolTask
 * @property {number} id 派发序号（单调递增，worker 消息按 id 回路由）
 * @property {string} filePath 文件绝对路径
 * @property {AbortSignal=} signal 取消信号
 * @property {((hashedBytes: number, totalBytes: number) => void)=} onProgress 进度回调
 * @property {boolean} priority 是否前台任务
 * @property {boolean} preempting 是否已被标记抢占（等待 worker 回传 AbortError）
 * @property {(() => void)|null} abortListener abort 事件监听（结算时移除）
 * @property {HashPoolSlot|null} slot 执行槽位（pump 派发时置位；排队中为 null）
 * @property {boolean} settled 是否已结算
 * @property {(hash: string) => void} resolve
 * @property {(err: Error) => void} reject
 */

/**
 * 槽位（OPT-3）：每个槽位持有独立 worker 实例与至多一个在途任务。
 * slots 数组长度只增不减（缩容按 poolConcurrency 忽略尾部槽位并惰性回收），
 * 避免在途任务的槽位引用失效。
 * @typedef {{worker: Worker|null, currentTask: HashPoolTask|null}} HashPoolSlot
 */

/** 槽位数组（惰性创建 worker；缩容后尾部空闲槽位被回收） */
const slots = []

/** 当前允许的并行任务数（1 = 串行；setHashPoolConcurrency 调整） */
let poolConcurrency = MIN_POOL_CONCURRENCY

/** 派发序号：任务 id 单调递增，worker 消息按 id 回路由 */
let nextTaskId = 0

/** 崩溃重启定时器与连续崩溃计数（OPT-05；池级全局共享） */
let restartTimer = null
let crashStreak = 0

/**
 * 双通道任务队列：
 * - foreground：详情页/识别/预热 priority 任务，优先出队；
 * - background：批量预热等后台任务，让路于前台。
 * 优先级只影响取队顺序；并行度由槽位数决定。
 */
const foregroundQueue = []
const backgroundQueue = []

/** 构造“后台任务已让路”错误（仅线程池内部使用） */
function preemptedError() {
  const err = new Error('后台哈希任务已让路')
  err.name = 'PreemptedError'
  return err
}

/**
 * 惰性创建槽位 worker 并绑定消息路由：
 * - progress：按 id 匹配任务并转发 onProgress 回调；
 * - done：按 id 结算任务（成功/失败），空闲后立即泵出下一任务；
 * - error / exit：worker 崩溃——当前任务以 WorkerCrashError 拒绝，队列保留
 *   并退避重建后继续消费（OPT-05）。
 * @param {HashPoolSlot} slot 目标槽位
 */
function ensureSlotWorker(slot) {
  if (slot.worker) return slot.worker
  const w = new Worker(WORKER_SOURCE, { eval: true })
  // unref：哈希预热是后台任务，不得阻止应用退出（退出编排不感知本线程）
  w.unref()
  w.on('message', (msg) => {
    // 代际防护：崩溃重建后旧 worker 的迟到消息必须丢弃
    if (slot.worker !== w) return
    if (!msg || typeof msg.id !== 'number') return
    const task = slot.currentTask
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
      settleSlot(slot)
      if (preempted) {
        task.reject(preemptedError())
      } else if (msg.error !== undefined) {
        const err = /** @type {Error & {code?: string}} */ (
          new Error(msg.error)
        )
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
    if (slot.worker !== w) return
    handleSlotFailure(slot, w, err)
  })
  w.on('exit', (code) => {
    // reset 路径先置空 worker 再 terminate，此处代际校验会忽略；
    // 其余退出均按崩溃处理（含 code=0 的非预期退出）
    if (slot.worker !== w) return
    handleSlotFailure(slot, w, new Error(`哈希工作线程已退出（code=${code}）`))
  })
  slot.worker = w
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
      if (task.abortListener)
        task.signal?.removeEventListener('abort', task.abortListener)
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
    RESTART_MAX_DELAY_MS,
  )
  if (restartTimer) return
  restartTimer = setTimeout(() => {
    restartTimer = null
    pump()
  }, delay)
  restartTimer.unref?.()
}

/**
 * 槽位 worker 崩溃处理：置空实例、终止残留、拒绝当前任务并进入重启流程。
 * @param {HashPoolSlot} slot 崩溃的槽位
 * @param {Worker} w 崩溃的 worker 实例
 * @param {Error} cause 崩溃原因
 */
function handleSlotFailure(slot, w, cause) {
  if (slot.worker !== w) return
  slot.worker = null
  try {
    w.terminate().catch(() => {})
  } catch {
    /* 进程已退出 */
  }
  const task = slot.currentTask
  if (task) {
    settleSlot(slot)
    task.reject(workerCrashError(`哈希工作线程异常: ${cause.message}`))
  }
  recordCrash()
}

/** 结束槽位当前在途任务的占位（仅状态清理，结算本身由消息路由完成） */
function settleSlot(slot) {
  const task = slot.currentTask
  if (task?.abortListener) {
    task.signal?.removeEventListener('abort', task.abortListener)
  }
  slot.currentTask = null
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
 * 回收超出并发数的空闲槽位（OPT-3 缩容）：尾部槽位若空闲则终止并从数组
 * 移除；在途槽位保留（完成当前任务后 pump 不再向其派发，下次缩容回收）。
 */
function trimSlots() {
  for (let i = slots.length - 1; i >= poolConcurrency; i--) {
    const slot = slots[i]
    if (slot.currentTask) continue
    slots.splice(i, 1)
    if (slot.worker) {
      const w = slot.worker
      slot.worker = null
      // 先置空再终止：exit 事件经代际校验忽略，不会误入崩溃路径
      w.terminate().catch(() => {})
    }
  }
}

/**
 * 入队并按需抢占：前台任务入队时，若所有槽位都被后台任务占用，
 * 通知其中一个槽位的 worker 在下一读块边界中止；等其回传 done 后
 * pump 再启动前台任务，避免新旧任务并发读写同一个 worker 的共享
 * abort 标志。多槽位（OPT-3）下其余后台任务不受影响，继续并行执行。
 */
function enqueueTask(task) {
  // 新任务到达时无需继续等待退避：立即尝试重建并派发
  clearRestartTimer()
  if (task.priority) {
    foregroundQueue.push(task)
    // 仅当没有空闲槽位可立即接单时才抢占（无在途任务的槽位可惰性建 worker）
    const hasFreeSlot = slots
      .slice(0, poolConcurrency)
      .some((s) => !s.currentTask)
    if (!hasFreeSlot) {
      for (const slot of slots.slice(0, poolConcurrency)) {
        const current = slot.currentTask
        if (
          current &&
          !current.priority &&
          !current.preempting &&
          slot.worker
        ) {
          current.preempting = true
          slot.worker.postMessage({ type: 'abort', id: current.id })
          break
        }
      }
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
 * 从队列泵出任务（并行上限 = poolConcurrency）：前台优先；队列中已取消的
 * 任务直接跳过。槽位按需物化（懒创建），超出并发数的槽位（缩容残留）
 * 不再接受新任务。
 */
function pump() {
  if (restartTimer) return
  trimSlots()
  for (let i = 0; i < poolConcurrency; i++) {
    if (i >= slots.length) slots.push({ worker: null, currentTask: null })
    const slot = slots[i]
    if (slot.currentTask) continue
    const task = nextTask()
    if (!task) return
    task.slot = slot
    slot.currentTask = task
    let w
    try {
      w = ensureSlotWorker(slot)
    } catch (err) {
      const failure = workerCrashError(`哈希工作线程创建失败: ${err.message}`)
      settleSlot(slot)
      task.reject(failure)
      recordCrash()
      return
    }
    try {
      w.postMessage({ type: 'hash', id: task.id, filePath: task.filePath })
    } catch (err) {
      // postMessage 失败通常意味着 worker 已终止：按崩溃路径重建
      handleSlotFailure(slot, w, err)
      return
    }
  }
}

/** 线程池重置：清除重启计划并拒绝当前与队列中全部任务 */
function failAll(err) {
  clearRestartTimer()
  crashStreak = 0
  for (const slot of slots) {
    if (slot.currentTask) {
      const task = slot.currentTask
      settleSlot(slot)
      task.reject(err)
    }
    if (slot.worker) {
      const w = slot.worker
      // 先置空再终止：terminate 触发的 exit 事件经代际校验忽略，
      // 避免旧实例的退出误伤随后重建的新 worker
      slot.worker = null
      w.terminate().catch(() => {})
    }
  }
  rejectQueued(err)
}

/**
 * 调整线程池并行度（OPT-3）：1 = 串行（默认，机械硬盘友好），上限 4。
 * 扩容立即生效（pump 按需创建槽位）；缩容时在途任务不中断，空闲的超额
 * 槽位被回收，完成任务的尾部槽位不再接受新任务。
 * @param {number} n 并行任务数（非法值按 1 处理）
 */
export function setHashPoolConcurrency(n) {
  const value = Number(n)
  poolConcurrency =
    Number.isFinite(value) && value >= MIN_POOL_CONCURRENCY
      ? Math.min(MAX_POOL_CONCURRENCY, Math.floor(value))
      : MIN_POOL_CONCURRENCY
  // 扩容或缩容后立即重新派发/回收（缩容在途任务不受影响）
  pump()
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
 *   优先于排队中的后台任务，并可在全部槽位被后台占用时抢占其一（OPT-08）
 * @returns {Promise<string>} 64 位十六进制哈希
 */
export function computeFileHashOffThread(
  filePath,
  signal,
  onProgress,
  options = {},
) {
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
      slot: null,
      settled: false,
      resolve: (hash) => {
        task.settled = true
        resolve(hash)
      },
      reject: (err) => {
        task.settled = true
        reject(err)
      },
    }
    task.abortListener = () => {
      if (task.settled) return
      if (task.slot && task.slot.currentTask === task) {
        // 在途任务：通知所在槽位的 worker 在下一块边界中止，主进程立即返回；
        // 泵出队列中的下一任务，避免取消后并行链停摆
        task.slot.worker?.postMessage({ type: 'abort', id: task.id })
        settleSlot(task.slot)
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
  const toTerminate = slots
    .map((slot) => slot.worker)
    .filter((w) => w instanceof Worker)
  failAll(new Error('哈希线程池已重置'))
  slots.length = 0
  nextTaskId = 0
  poolConcurrency = MIN_POOL_CONCURRENCY
  await Promise.all(toTerminate.map((w) => w.terminate().catch(() => {})))
  logger.info('哈希线程池已重置（测试）')
}

/**
 * 强制终止在途 worker，模拟崩溃（仅供单元测试使用；生产代码严禁调用）。
 * 不清理当前任务/队列，使退出事件走真实崩溃恢复路径。
 * @returns {boolean} 是否存在可终止的 worker
 */
export function crashHashWorkerForTests() {
  for (const slot of slots) {
    if (slot.worker) {
      slot.worker.terminate().catch(() => {})
      return true
    }
  }
  return false
}
