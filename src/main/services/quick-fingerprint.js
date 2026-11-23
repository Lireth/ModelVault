import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'

/**
 * 文件快指纹（OP-C 两阶段查重的阶段一）：
 *
 * 重复检测的权威判据是全文件 SHA256，但同尺寸组的候选筛选只需要一个
 * 「内容不同则必然互异」的廉价指纹：读取文件头部与尾部各 1MB 计算 SHA256。
 * 指纹互异 ⇒ 头/尾字节不同 ⇒ 内容必然不同——筛选只做减法（排除非重复），
 * 指纹相同的候选组（含中段不同、首尾恰同的超集误报）交由阶段二全量 SHA256
 * 确认，语义上不产生误判。
 *
 * 成本量级：每文件固定 2MB 读盘 + ~1ms 哈希，与候选组规模线性、与单文件
 * 体积无关——对比全量 SHA256（1-10GB/文件），同尺寸组全互异的常见场景
 * （同架构不同权重的 LoRA）把查重 IO 从组员体积之和降到 2MB × 组员数。
 *
 * 指纹以 64 位十六进制 SHA256 表示，与全量哈希同形状但语义不同：
 * 调用方必须以独立字段（meta.quickHash）缓存，绝不与全量 hash 混用。
 */

/** 头部采样字节数 */
const QUICK_HEAD_BYTES = 1024 * 1024
/** 尾部采样字节数（小文件与头部重叠时合并为整读） */
const QUICK_TAIL_BYTES = 1024 * 1024

/**
 * 计算文件快指纹（头 1MB + 尾 1MB 的 SHA256，小文件整读）。
 * @param {string} filePath 文件绝对路径
 * @param {number} size 文件字节数（调用方 stat 结果；未知传 0，按整读兜底）
 * @returns {Promise<string>} 64 位十六进制指纹
 * @throws 读盘/打开失败（调用方决定缓存与重试语义）
 */
export async function computeQuickFingerprint(filePath, size) {
  const total = Number.isFinite(size) && size > 0 ? size : 0
  const fh = await fs.open(filePath, 'r')
  try {
    const st = total > 0 ? { size: total } : await fh.stat()
    const fileSize = st.size
    const hash = createHash('sha256')
    // 头尾区间：小文件（≤ 2MB）二者重叠，退化为一次整读
    const headLen = Math.min(QUICK_HEAD_BYTES, fileSize)
    const tailStart = Math.max(headLen, fileSize - QUICK_TAIL_BYTES)
    const tailLen = fileSize - tailStart
    const buffer = Buffer.alloc(Math.max(headLen, tailLen))
    if (headLen > 0) {
      const head = await fh.read(buffer, 0, headLen, 0)
      hash.update(head.buffer.subarray(0, head.bytesRead))
    }
    if (tailLen > 0) {
      const tail = await fh.read(buffer, 0, tailLen, tailStart)
      hash.update(tail.buffer.subarray(0, tail.bytesRead))
    }
    return hash.digest('hex')
  } finally {
    await fh.close()
  }
}
