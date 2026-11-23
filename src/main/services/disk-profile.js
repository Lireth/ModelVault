import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'

/**
 * 磁盘介质探测（OP-B 自适应哈希预热并发的基础设施）：
 *
 * 哈希预热默认串行（concurrency=1）源于「机械硬盘多路大文件读盘互相争抢」
 * 的保守假设，SSD/NVMe 用户因此付出数倍的预热等待。本模块以「随机读延迟」
 * 作为 seek-penalty 的代理判据区分磁盘介质，供 warmup 在自动档（设置值 0）
 * 下解析每块盘的实际并发能力：
 *
 * - 判据：对目标文件按分层偏移独立读 5 个 64KB 块（0%/25%/50%/75%/98%，
 *   各加少量抖动避免聚集命中预读缓存），取耗时中位数——
 *   < 2ms 判 NVMe/SSD（并发 4）；< 8ms 判 SATA SSD（并发 2）；否则判 HDD
 *   （并发 1，串行）。文件 < 16MB 时不探测（小文件哈希本身秒级，块间距离
 *   过近会命中预读缓存误判，且并发收益可忽略）——直接回退串行；
 * - 缓存：以盘符（path.parse(path).root）为键缓存一次结果，预热/识别链路
 *   重复触发不再重付探测成本；体积未知/过小的「无探测意义」路径不写缓存
 *   （首个任务恰好是小文件不应永久封顶该盘并发）；探测失败/超预算缓存
 *   串行——机械盘休眠唤醒场景避免每轮 drain 重付预算；误判 SSD 会让
 *   HDD 饱和争抢，误判 HDD 只损失速度；
 * - 超时：整体探测预算 5s（机械盘休眠唤醒的首次随机读可达秒级，恰好
 *   正确落入 HDD 判定；超过预算视为不可判定，保守串行）；
 * - 判定只影响后台预热与识别哈希的线程池并行度，不改变任何哈希语义。
 */

/** 单次探测块大小：足以触发真实物理读而不放大内存占用 */
const PROBE_CHUNK_BYTES = 64 * 1024
/** 可探测文件的最小体积：小于该值时块间距离过近（预读缓存命中误判）且
 * 哈希本身秒级完成，直接回退串行 */
const PROBE_MIN_FILE_BYTES = 16 * 1024 * 1024
/** 整体探测预算（ms）：超过视为不可判定，保守串行 */
const PROBE_TIMEOUT_MS = 5000

/** 随机读延迟中位数判定阈值（ms）：NVMe/SATA SSD/HDD 三档 */
const SSD_FAST_MEDIAN_MS = 2
const SSD_SLOW_MEDIAN_MS = 8

/** 各介质档位的预热并发（与设置手动档区间一致，上限 4） */
const CONCURRENCY_FAST_DISK = 4
const CONCURRENCY_SATA_SSD = 2
const CONCURRENCY_SERIAL = 1

/** 探测结果缓存（盘符小写 → 并发档位） */
const probeCache = new Map()

/** 探测预算（测试可注入小值验证超时回退路径） */
let probeTimeoutMs = PROBE_TIMEOUT_MS

/**
 * 注入探测预算（仅供单元测试使用；生产代码严禁调用）
 * @param {number} ms 毫秒数
 */
export function setDiskProbeTimeoutForTests(ms) {
  probeTimeoutMs = Number.isFinite(ms) && ms > 0 ? ms : PROBE_TIMEOUT_MS
}

/**
 * 随机读延迟中位数 → 预热并发档位（纯函数，单测锁定判据）。
 * @param {number} medianMs 中位数耗时（毫秒）
 * @returns {number} 4（NVMe/SSD）/ 2（SATA SSD）/ 1（HDD/非法输入）
 */
export function classifyRandomReadLatency(medianMs) {
  if (!Number.isFinite(medianMs) || medianMs < 0) return CONCURRENCY_SERIAL
  if (medianMs < SSD_FAST_MEDIAN_MS) return CONCURRENCY_FAST_DISK
  if (medianMs < SSD_SLOW_MEDIAN_MS) return CONCURRENCY_SATA_SSD
  return CONCURRENCY_SERIAL
}

/** 分层偏移比例（起止内收避免越界，中段均匀铺开防预读命中） */
const PROBE_OFFSET_RATIOS = [0.02, 0.25, 0.5, 0.75, 0.98]

/**
 * 对单个文件测量随机读延迟（5 次独立读的中位数，ms）。
 * @param {string} filePath 目标文件（通常为即将哈希的模型文件）
 * @param {number} fileSize 文件字节数（调用方 stat 结果）
 * @returns {Promise<number|null>} 中位数毫秒；文件不可读/体积过小时返回 null
 */
async function measureRandomReadLatency(filePath, fileSize) {
  if (
    !Number.isFinite(fileSize) ||
    fileSize < PROBE_MIN_FILE_BYTES ||
    fileSize <= PROBE_CHUNK_BYTES
  ) {
    return null
  }
  const maxOffset = fileSize - PROBE_CHUNK_BYTES
  let handle
  try {
    handle = await fs.open(filePath, 'r')
  } catch {
    return null
  }
  const buffer = Buffer.alloc(PROBE_CHUNK_BYTES)
  const samples = []
  try {
    for (const ratio of PROBE_OFFSET_RATIOS) {
      // 分层偏移 + 小幅抖动：同盘并发探测重复触发时样本分布稳定且不聚集
      const jitter = Math.floor(
        Math.random() * Math.min(PROBE_CHUNK_BYTES, maxOffset),
      )
      const offset = Math.min(
        maxOffset,
        Math.max(0, Math.floor(ratio * maxOffset) + jitter),
      )
      const started = process.hrtime.bigint()
      const { bytesRead } = await handle.read(
        buffer,
        0,
        PROBE_CHUNK_BYTES,
        offset,
      )
      if (bytesRead <= 0) return null
      samples.push(Number(process.hrtime.bigint() - started) / 1e6)
    }
  } catch {
    return null
  } finally {
    await handle.close().catch(() => {})
  }
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)]
}

/**
 * 带整体预算的探测（超时返回 null）：机械盘休眠唤醒的首次随机读可达
 * 数秒——超时路径把这类盘保守判为串行（唤醒后的常规随机读仍会落在
 * 正确档位，缓存以首次判定为准；误判串行只损失预热速度，不损失正确性）。
 * @param {string} filePath 目标文件
 * @param {number} fileSize 文件字节数
 * @returns {Promise<number|null>}
 */
async function probeWithBudget(filePath, fileSize) {
  let timer
  try {
    return await Promise.race([
      measureRandomReadLatency(filePath, fileSize),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), probeTimeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 解析自动档的预热并发（按目标文件所在盘探测，每盘符缓存）。
 * 体积未知/文件过小：无探测意义，保守串行且**不写缓存**——同盘后续以
 * 大文件触发的探测仍可正确分类（首个任务恰好是小文件不应永久封顶并发）。
 * 探测失败/超预算：保守串行**并缓存**——机械盘休眠唤醒场景避免每轮 drain
 * 重付探测预算（真实介质多半本就是 HDD；误判串行只损失预热速度）。
 * @param {string} filePath 目标文件路径（提供盘符与探测样本）
 * @param {number|null} fileSize 文件字节数（未知传 null）
 * @returns {Promise<number>} 预热并发档位（1/2/4）
 */
export async function resolveAdaptiveHashConcurrency(filePath, fileSize) {
  const drive = path.parse(String(filePath || '')).root.toLowerCase()
  if (!drive) return CONCURRENCY_SERIAL
  const cached = probeCache.get(drive)
  if (cached !== undefined) return cached
  const size = Number(fileSize)
  if (!Number.isFinite(size) || size < PROBE_MIN_FILE_BYTES) {
    return CONCURRENCY_SERIAL
  }
  let resolved = CONCURRENCY_SERIAL
  const median = await probeWithBudget(filePath, size)
  if (median !== null) {
    resolved = classifyRandomReadLatency(median)
    logger.info(
      `磁盘介质探测: ${drive} 随机读中位 ${median.toFixed(2)}ms → 预热并发 ${resolved}`,
    )
  } else {
    logger.info(
      `磁盘介质探测失败/超预算（保守串行并缓存）: ${drive} → 预热并发 1`,
    )
  }
  probeCache.set(drive, resolved)
  return resolved
}

/** 清空探测缓存（测试隔离用；生产代码严禁调用） */
export function resetDiskProfileForTests() {
  probeCache.clear()
  probeTimeoutMs = PROBE_TIMEOUT_MS
}
