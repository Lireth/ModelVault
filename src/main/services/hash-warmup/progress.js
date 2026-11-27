import { warmup } from './state'

/**
 * 预热进度节流推送域（O8 自 hash-warmup.js 拆出）：
 * 监听器注册与 emitProgress 快照组装；remaining 读共享队列长度。
 */

/** 进度事件节流间隔（ms）：哈希每块（8MB）回调一次，高频事件须限流 */
const PROGRESS_INTERVAL_MS = 300

/**
 * 预热进度快照（emitProgress 组装，经监听器推送渲染层）
 * @typedef {object} WarmupProgress
 * @property {boolean} active 是否有进行中的哈希任务
 * @property {string|null} id 模型 id（完成事件时非空）
 * @property {number} percent 进度百分比（0-100）
 * @property {number} hashedBytes 已计算字节数
 * @property {number} totalBytes 本轮总字节数
 * @property {number} done 本轮已完成模型数
 * @property {number} remaining 队列剩余任务数
 * @property {string} hash 刚完成计算的模型哈希（非完成事件为 ''）
 */

/**
 * 注册预热进度监听（与 setStoreSaveErrorListener 同一副作用注册模式）：
 * 监听器收到的快照形状见 WarmupProgress。
 * hash 仅在单个模型的计算完成事件（active=false 且 id 非空）携带有效值，
 * 渲染层据此把新算得的哈希回填到对应模型对象（FEAT-1 重复检测渐进可用，
 * 无需等待下次扫描）。
 * @param {(progress: WarmupProgress) => void} [fn] 进度快照回调（传空清除）
 */
export function setWarmupProgressListener(fn) {
  warmup.warmupProgressListener = typeof fn === 'function' ? fn : null
}

/**
 * 推送一次进度快照（拼入实时队列计数；节流仅作用于高频的哈希块回调，
 * 状态跃迁经 force 立即送达）。
 * @param {{active: boolean, id: string|null, percent: number, hashedBytes: number,
 *   totalBytes: number, hash?: string}} snap 当前计算的温度快照
 * @param {boolean} [force] 跳过节流立即推送
 */
export function emitProgress(snap, force = false) {
  if (!warmup.warmupProgressListener) return
  const now = Date.now()
  // 节流仅在普通 tick 之间生效：状态跃迁（force）不占用节流窗口，
  // 避免开始事件把随后的首个进度 tick 吞掉
  if (!force) {
    if (now - warmup.lastEmitAt < PROGRESS_INTERVAL_MS) return
    warmup.lastEmitAt = now
  }
  try {
    warmup.warmupProgressListener({
      active: snap.active,
      id: snap.id,
      percent: snap.percent,
      hashedBytes: snap.hashedBytes,
      totalBytes: snap.totalBytes,
      done: warmup.doneCount,
      remaining: warmup.queue.length,
      hash: snap.hash || '',
    })
  } catch {
    // 进度推送失败不影响预热本身
  }
}
