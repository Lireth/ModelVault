/**
 * 模型文件 SHA256 计算入口（线程池委托）：
 * 识别链路的哈希计算统一经此进入 hash-worker-pool，主进程不承载 CPU 工作。
 */

import { computeFileHashOffThread } from '../hash-worker-pool'

/**
 * 流式计算文件 SHA256（hex 小写）——P1 改造后为线程池委托入口：
 * 模型文件普遍 1-10GB，读盘与哈希 CPU 工作整体运行在 worker_threads
 * （hash-worker-pool，串行队列），主进程事件循环在数 GB 哈希期间保持空闲。
 * 语义与原主进程实现一致：分块读取、进度按块回调、AbortSignal 取消抛
 * AbortError。
 * @param {string} filePath 文件绝对路径
 * @param {AbortSignal} [signal] 取消信号（可选）
 * @param {(hashedBytes: number, totalBytes: number) => void} [onProgress]
 *   哈希进度回调（可选，每块读取后触发；预热链路据此推送进度标识）
 * @param {{priority?: boolean}} [options] priority=true 为前台任务（OPT-08）
 * @returns {Promise<string>} 64 位十六进制哈希
 */
export async function computeFileHash(
  filePath,
  signal,
  onProgress,
  options = {},
) {
  return computeFileHashOffThread(filePath, signal, onProgress, options)
}
