/**
 * 调度原语（O7）：unref 定时器与指数退避间隔。
 * 后台定时器（防抖落盘/重试重探/周期检查/空闲回收/任务超时）全项目
 * 统一「不阻止进程退出」约定，此前三十余处各自手写
 * `setTimeout(...); timer.unref?.()`；指数退避在写盘重试、worker 重启、
 * 哈希负缓存、rename 竞争退避四处同型，仅基准/倍率/封顶参数不同。
 * 本模块只收敛定时器机制与延迟计算，各域的业务守卫（抑制窗口、
 * 同根判定、失败计数上限等）保留在调用方，语义不变。
 */

/**
 * setTimeout + unref：返回句柄照常可 clearTimeout，但不保活事件循环。
 * @param {() => void} fn 回调
 * @param {number} ms 延迟毫秒
 * @returns {ReturnType<typeof setTimeout>} 定时器句柄
 */
export function unrefTimeout(fn, ms) {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return timer
}

/**
 * 指数退避间隔：baseMs × factor^(attempt-1)，封顶 maxMs。
 * @param {number} baseMs 基准间隔（attempt=1 时的退避时长）
 * @param {number} attempt 尝试序号（自 1 起；小于 1 按 1 处理）
 * @param {number} [maxMs] 封顶间隔（默认不设上限）
 * @param {number} [factor] 递增倍率（默认 2）
 * @returns {number} 退避毫秒数
 */
export function backoffMs(
  baseMs,
  attempt,
  maxMs = Number.POSITIVE_INFINITY,
  factor = 2,
) {
  return Math.min(baseMs * factor ** Math.max(0, attempt - 1), maxMs)
}
