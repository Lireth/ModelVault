/**
 * 主进程跨模块共享的小型工具（C4 去重）：
 * 此前的 abortError 在 scanner.js / decorate.js 各有一份逐字实现，
 * 「Map 超限按插入顺序淘汰最旧」的 LRU 逻辑在 decorate.js / hash.js
 * 两处同构，统一收敛到本模块维护。
 */

import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * 判断路径是否位于基准目录之内，并返回相对路径（O-1 归属判定单一实现）。
 *
 * 此前「路径是否在根内」在 scanner.js（子树校验）、store-paths.js（相对键
 * 换算）、protocol.js（图片协议放行）、files.js（导入目标校验）、watcher.js
 * 与 library-overview.js（快照/统计越界防御）各自实现，大小写策略不一致
 * ——其中 files.js 的注释声明「Windows 大小写不敏感」而实现并非如此。
 * 收敛为单一实现后，安全边界与关联存储边界使用同一套判定。
 *
 * 约定：
 * - 返回 '' 表示 absPath 即 baseDir 本身（含路径内的调用方按自身语义处理）；
 * - 返回 null 表示越界（.. 逃逸、绝对路径、或兜底前缀匹配未命中）；
 * - 返回值保持 path.sep 分隔与实际大小写（兜底分支取自 absPath 原文，
 *   不因比较而小写化，避免污染元数据键）；
 * - 仅做字符串层面判定，不解析符号链接：需要防 junction 逃逸的调用方须先
 *   自行 fs.realpath（见 protocol.js）。
 *
 * @param {string} absPath 目标绝对路径
 * @param {string} baseDir 基准目录绝对路径
 * @returns {string|null} 相对路径；越界返回 null
 */
export function relativeWithin(absPath, baseDir) {
  if (
    typeof absPath !== 'string' ||
    typeof baseDir !== 'string' ||
    !absPath ||
    !baseDir
  ) {
    return null
  }
  const rel = path.relative(baseDir, absPath)
  if (rel === '') return ''
  // '..' 与其后的分隔符分开判断：名为 '..foo' 的合法目录不应被误判为越界
  const outside =
    rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
  if (!outside) return rel
  // 兜底：Windows 下按小写前缀再判一次（path.win32.relative 本身已按大小写
  // 不敏感比较，此处覆盖相对基准解析与传入形态不一致的残余场景）。
  // 切片偏移取自原始 baseDir 长度——大小写转换在个别非 ASCII 字符上会改变
  // 长度，不可用转换后的长度计算偏移。
  if (process.platform !== 'win32') return null
  const base = baseDir.endsWith(path.sep) ? baseDir.slice(0, -1) : baseDir
  if (
    !base ||
    !absPath.toLowerCase().startsWith(`${base.toLowerCase()}${path.sep}`)
  ) {
    return null
  }
  return absPath.slice(base.length + 1)
}

/**
 * 解析路径的真实路径（O6）：不存在/不可访问时返回空串。
 * @param {string} target 绝对路径
 * @returns {Promise<string>} realpath 或 ''
 */
export async function resolveRealPath(target) {
  if (typeof target !== 'string' || !target) return ''
  try {
    return await fs.realpath(target)
  } catch {
    return ''
  }
}

/**
 * 破坏性操作的 realpath 归属判定（O6）：
 * - 目标存在：解析符号链接/junction 后必须仍在 realRoot 内；
 * - 目标不存在：回退到最近存在祖先的真实路径，防止父目录是指向库外的
 *   junction 时后续 mkdir/rename 把文件写到库外。
 * @param {string} target 目标绝对路径
 * @param {string} realRoot 已 realpath 的库根目录
 * @returns {Promise<boolean>} 真实路径位于库内时为 true
 */
export async function isPathRealWithin(target, realRoot) {
  if (typeof target !== 'string' || !target || !realRoot) return false
  const direct = await resolveRealPath(target)
  if (direct) return relativeWithin(direct, realRoot) !== null
  let dir = path.dirname(target)
  for (;;) {
    const real = await resolveRealPath(dir)
    if (real) return relativeWithin(real, realRoot) !== null
    const parent = path.dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}

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
 * 应用外链出口为设置页的 GitHub 下载页与详情页的 Civitai 模型页
 * （civitai.red 为识别站点，civitai.com 兼容历史数据中的旧链接），
 * 新增外链场景时在此显式登记具体域名——禁止通配、禁止子域放行
 * （用户信息段伪装 github.com@evil.com 与外形相似域名
 * github.com.evil.com 均会因真实主机不匹配而被拒绝）。
 */
const ALLOWED_EXTERNAL_HOSTS = new Set([
  'github.com',
  'civitai.com',
  'civitai.red',
])

/**
 * 校验外部 URL 是否允许经 shell.openExternal 拉起（B3）：
 * 必须是 https 协议且主机名（含端口）命中白名单。
 * 主进程两个拉起入口共用本收口：setWindowOpenHandler（渲染进程
 * 可控的 window.open）与 updater 的下载页地址（上游 API 响应）。
 * @param {unknown} url 待校验 URL
 * @returns {boolean} 允许拉起返回 true
 */
export function isAllowedExternalUrl(url) {
  // 非字符串（渲染层可控入参/上游异常响应）一律拒绝，与解析失败同一语义
  if (typeof url !== 'string') return false
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'https:' && ALLOWED_EXTERNAL_HOSTS.has(parsed.host)
    )
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
export async function readResponseBytesLimited(
  response,
  maxBytes,
  label = '响应',
) {
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
export async function readResponseTextLimited(
  response,
  maxBytes,
  label = '响应',
) {
  return (await readResponseBytesLimited(response, maxBytes, label)).toString(
    'utf8',
  )
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
      return Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid
        ? pid
        : 0
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
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? options.timeoutMs
    : 15000
  const intervalMs = Number.isFinite(options.intervalMs)
    ? options.intervalMs
    : 200
  const alive =
    typeof options.isAlive === 'function' ? options.isAlive : isProcessAlive
  const deadline = Date.now() + Math.max(0, timeoutMs)
  for (;;) {
    if (!alive(pid)) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(10, intervalMs)),
    )
  }
}

/**
 * 损坏数据文件的保底备份（时间戳命名 + 滚动保留）：
 * 单一 `${file}.bak` 在连续损坏时会被 fs.rename 静默覆盖，上一次的损坏
 * 现场即丢失。改为 `${file}.bak-${Date.now()}` 命名（时间戳位数恒定，
 * 字典序即时间序；同毫秒内连续损坏时递增避免覆盖），并按字典序清理
 * 超出 keep 份数的旧备份。rename 失败原样抛出，由调用方兜底记录；
 * 旧备份清理为尽力而为，任何失败不阻断调用方的重置流程。
 * @param {string} file 损坏文件的绝对路径（须存在）
 * @param {number} [keep=3] 滚动保留份数
 * @returns {Promise<string>} 备份文件绝对路径
 */
export async function preserveCorruptedFile(file, keep = 3) {
  const base = path.basename(file)
  let stamp = Date.now()
  let backup = `${file}.bak-${stamp}`
  while (
    await fs.access(backup).then(
      () => true,
      () => false,
    )
  ) {
    stamp += 1
    backup = `${file}.bak-${stamp}`
  }
  await fs.rename(file, backup)
  try {
    const dir = path.dirname(file)
    const names = (await fs.readdir(dir))
      .filter((name) => name.startsWith(`${base}.bak-`))
      .sort()
    for (const old of names.slice(0, Math.max(0, names.length - keep))) {
      await fs.rm(path.join(dir, old), { force: true }).catch(() => {})
    }
  } catch {
    /* 清理失败仅留下多余的旧备份，不影响正确性 */
  }
  return backup
}
