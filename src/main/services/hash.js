import crypto from 'node:crypto'
import fs from 'node:fs'

/**
 * 文件哈希服务：
 * - 流式计算文件 SHA256（大文件友好，内存占用恒定），供重复检测
 *   批量哈希（E5）与哈希持久化复用；
 * - 计算结果经 mtime 比对持久化到模型元数据（hash/hashMtime），
 *   文件未变化时直接复用，重启后无需重算。
 */

/**
 * 流式计算文件 SHA256（大文件友好，内存占用恒定）。
 * @param {string} absPath 模型文件绝对路径
 * @param {{signal?: AbortSignal, onProgress?: (loaded: number) => void}} [options]
 *   signal 中止信号（abort 后读取流销毁并以 AbortError 拒绝）；
 *   onProgress 已处理字节数回调（节流由调用方负责）
 * @returns {Promise<string>} SHA256 hex（小写）
 */
export function sha256File(absPath, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(absPath, { highWaterMark: 8 * 1024 * 1024 })
    let loaded = 0
    stream.on('data', (chunk) => {
      hash.update(chunk)
      loaded += chunk.length
      if (onProgress) onProgress(loaded)
    })
    stream.on('error', reject)
    if (signal) {
      const onAbort = () => {
        stream.destroy(Object.assign(new Error('哈希计算已取消'), { name: 'AbortError' }))
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}
