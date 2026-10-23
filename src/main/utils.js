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

/** 字节上限的人类可读文案（错误提示用） */
function formatByteLimit(bytes) {
  return bytes >= 1024 * 1024
    ? `${Math.floor(bytes / 1024 / 1024)}MB`
    : `${Math.floor(bytes / 1024)}KB`
}

/**
 * 读取响应体并强制字节上限（V-06 网络边界）：
 * 先看 Content-Length 提前拒绝，再流式累计实际字节——上游缺失/伪造
 * Content-Length 时仍会在超限处取消读取，避免整包进入主进程堆。
 * @param {Response} response fetch 响应
 * @param {number} maxBytes 允许的最大字节数
 * @param {string} [label] 错误文案中的资源名
 * @returns {Promise<Buffer>} 不超过上限的响应内容
 */
export async function readResponseBytesLimited(response, maxBytes, label = '响应') {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`${label}过大（上限 ${formatByteLimit(maxBytes)}）`)
  }
  if (!response.body) {
    const buf = Buffer.from(await response.arrayBuffer())
    if (buf.length > maxBytes) {
      throw new Error(`${label}过大（上限 ${formatByteLimit(maxBytes)}）`)
    }
    return buf
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error(`${label}过大（上限 ${formatByteLimit(maxBytes)}）`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* 读取已结束时释放锁可能抛错，忽略 */
    }
  }
  return Buffer.concat(chunks, total)
}

/**
 * 读取文本响应并强制字节上限（语义同 readResponseBytesLimited）。
 * @param {Response} response fetch 响应
 * @param {number} maxBytes 允许的最大字节数
 * @param {string} [label] 错误文案中的资源名
 * @returns {Promise<string>} UTF-8 文本
 */
export async function readResponseTextLimited(response, maxBytes, label = '响应') {
  return (await readResponseBytesLimited(response, maxBytes, label)).toString('utf8')
}

/**
 * 从启动参数解析 `--wait-for-pid=<pid>`（V-06 更新安装自等待）。
 * 新版本实例拉起时先等待旧实例退出并释放单实例锁，避免更新后闪退。
 * @param {string[]} argv 进程参数
 * @returns {number} 合法 pid；不存在或非法返回 0
 */
export function parseWaitForPid(argv) {
  if (!Array.isArray(argv)) return 0
  for (const arg of argv) {
    const m = /^--wait-for-pid=(\d{1,10})$/.exec(String(arg))
    if (m) {
      const pid = Number(m[1])
      return Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid ? pid : 0
    }
  }
  return 0
}

/** 进程是否仍存活（EPERM 视为存活：存在但无权限） */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/**
 * 等待指定进程退出（V-06 更新安装）。
 * @param {number} pid 目标进程 id
 * @param {{timeoutMs?: number, intervalMs?: number, isAlive?: (pid: number) => boolean}} [options]
 *   isAlive 仅供测试注入；默认使用 process.kill(pid, 0)
 * @returns {Promise<boolean>} 已退出返回 true；超时仍存活返回 false
 */
export async function waitForProcessExit(pid, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 200
  const alive = typeof options.isAlive === 'function' ? options.isAlive : isProcessAlive
  const deadline = Date.now() + Math.max(0, timeoutMs)
  for (;;) {
    if (!alive(pid)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, Math.max(10, intervalMs)))
  }
}
