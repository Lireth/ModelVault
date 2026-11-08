/**
 * 异步与并发原语：
 * 取消异常构造、有界并发调度、Map 容量约束与 promise 超时判定。
 */

/** 构造取消异常（与 AbortController 的 AbortError 同名，便于统一识别） */
export function abortError() {
  const err = new Error('扫描已取消')
  err.name = 'AbortError'
  return err
}

/**
 * Map 写入并执行容量限制：超出 max 时按插入顺序淘汰最旧条目。
 * @template K, V
 * @param {Map<K, V>} map 目标 Map
 * @param {K} key 键
 * @param {V} value 值
 * @param {number} max 容量上限
 */
export function boundedMapSet(map, key, value, max) {
  map.set(key, value)
  if (map.size > max) {
    map.delete(map.keys().next().value)
  }
}

/**
 * 固定并发任务池（O-6）：按序消费任务、同时在途数受限、全部处理后 resolve。
 * 与「批内并发、批间串行」的批处理模型相比：流式取任务（完成一个补位一个），
 * 无整批等待的尾延迟，且并发峰值恒定——适用于「单任务内存/IO 峰值高、
 * 需限制同时在场数量」的后台批处理（缩略图生成、批量哈希等）。
 * worker 内部须自行捕获业务错误（本函数只保证调度，不吞任务异常）。
 * @template T
 * @param {T[]} tasks 任务列表（按序消费）
 * @param {(task: T, index: number) => Promise<any>} worker 单任务处理器
 * @param {number} concurrency 最大并发数（超出任务数或 ≤0 时自动收敛）
 * @returns {Promise<void>} 全部任务处理完毕后 resolve（worker 抛错则 reject）
 */
export async function runWithConcurrency(tasks, worker, concurrency) {
  let next = 0
  async function runner() {
    while (next < tasks.length) {
      const index = next++
      await worker(tasks[index], index)
    }
  }
  const count = Math.max(0, Math.min(concurrency, tasks.length))
  await Promise.all(Array.from({ length: count }, () => runner()))
}

/**
 * 判定 promise 是否在 ms 内 settle（OPT-19 切库 flush 超时守卫）：
 * 挂起磁盘（死亡网络盘/半挂载 USB）上的 stat/fsync 可在内核层阻塞数十秒，
 * 「永不卡死」底线场景（切库/退出落盘）需要与超时赛跑。原 promise 无法
 * 取消也不取消——迟到的 settle 由调用方语义兜底（持久层的同根守卫拦截
 * 迟到写入，防止旧根数据落进新根目录）。
 * @template T
 * @param {Promise<T>} promise 待判定的 promise
 * @param {number} ms 超时毫秒数
 * @returns {Promise<boolean>} true=已在时限内 settle（含 reject）；false=超时
 */
export function isSettledWithin(promise, ms) {
  let timer = null
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
