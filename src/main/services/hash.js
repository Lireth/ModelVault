import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { abortError } from '../utils'

/**
 * 模型文件 SHA256 哈希服务（F9）：
 * - 流式分块计算（4MB 缓冲复用），GB 级模型不整读内存；
 * - 哈希与计算时的 mtime 一并交由调用方持久化（store-meta 的
 *   hash/hashMtime 字段自旧版已就绪），mtime 未变时重启免重算；
 * - 是 relink R3（哈希履历）与后续 Civitai 在线匹配（AUTOV2
 *   即 sha256 前 10 位）的共享基建。
 * 历史说明：完整去重面板曾在功能精简阶段移除（hash.js 一并删除），
 * 但存储 schema 与 relink R3 规则被刻意保留——本模块为轻量重建。
 */

/** 分块读取缓冲大小：4MB 在吞吐与内存间平衡 */
const CHUNK_SIZE = 4 * 1024 * 1024

/**
 * 流式计算文件 SHA256。
 * @param {string} absPath 文件绝对路径
 * @param {AbortSignal} [signal] 取消信号（批算过程中用户可中止）
 * @returns {Promise<string>} 小写 hex 摘要（64 字符）
 * @throws Error name 为 'AbortError' 表示被取消；stat/read 失败原样抛出
 */
export async function computeFileSha256(absPath, signal) {
  const stat = await fs.stat(absPath)
  const hash = createHash('sha256')
  if (stat.size === 0) return hash.digest('hex')
  const fh = await fs.open(absPath, 'r')
  try {
    const buf = Buffer.alloc(CHUNK_SIZE)
    let pos = 0
    while (pos < stat.size) {
      if (signal?.aborted) throw abortError()
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos)
      if (bytesRead === 0) break
      hash.update(buf.subarray(0, bytesRead))
      pos += bytesRead
    }
    return hash.digest('hex')
  } finally {
    await fh.close().catch(() => {})
  }
}

/**
 * 按哈希聚合重复模型组（纯函数，F9 去重依据）：
 * 组键 = sha256 + 文件字节数（防极端哈希碰撞），仅保留成员数 ≥2 的组。
 * @param {Array<{id: string, hash?: string, size: number}>} models
 *   装饰模型列表（仅已计算哈希的参与分组）
 * @returns {Map<string, string[]>} 组键 → 成员 id 列表（组内按 id 排序稳定）
 */
export function groupDuplicateModels(models) {
  const byKey = new Map()
  for (const m of models) {
    if (!m?.hash || typeof m.id !== 'string') continue
    const key = `${m.hash}:${m.size}`
    const group = byKey.get(key) || []
    group.push(m.id)
    byKey.set(key, group)
  }
  for (const [key, ids] of byKey) {
    if (ids.length < 2) byKey.delete(key)
    else ids.sort()
  }
  return byKey
}
