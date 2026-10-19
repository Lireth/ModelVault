/**
 * 主进程跨模块共享的小型工具（C4 去重）：
 * 此前的 abortError 在 scanner.js / decorate.js 各有一份逐字实现，
 * 「Map 超限按插入顺序淘汰最旧」的 LRU 逻辑在 decorate.js / hash.js
 * 两处同构，统一收敛到本模块维护。
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
 * 允许 shell.openExternal 拉起的域名白名单（B3）：
 * 应用外链出口为设置页的 GitHub 下载页与详情页的 Civitai 模型页，
 * 新增外链场景时在此显式登记具体域名——禁止通配、禁止子域放行
 * （用户信息段伪装 github.com@evil.com 与外形相似域名
 * github.com.evil.com 均会因真实主机不匹配而被拒绝）。
 */
const ALLOWED_EXTERNAL_HOSTS = new Set(['github.com', 'civitai.com'])

/**
 * 校验外部 URL 是否允许经 shell.openExternal 拉起（B3）：
 * 必须是 https 协议且主机名（含端口）命中白名单。
 * 主进程两个拉起入口共用本收口：setWindowOpenHandler（渲染进程
 * 可控的 window.open）与 updater 的下载页地址（上游 API 响应）。
 * @param {unknown} url 待校验 URL
 * @returns {boolean} 允许拉起返回 true
 */
export function isAllowedExternalUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && ALLOWED_EXTERNAL_HOSTS.has(parsed.host)
  } catch {
    return false
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
 * @param {(task: T, index: number) => Promise<void>} worker 单任务处理器
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
