/**
 * 进程生命周期原语：
 * 更新安装自等待（--wait-for-pid）与进程存活探测。
 */

import { errorCode } from '../../shared/error-text'

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
    return errorCode(err) === 'EPERM'
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
