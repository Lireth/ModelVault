/**
 * 全局维护锁（V-02）：
 * 扫描、局部扫描、切库、备份恢复都会改写「当前根目录」及其关联存储，
 * 彼此并发会造成跨库写入、缩略图误删与恢复结果被覆盖。本模块提供
 * 进程内单一互斥锁，任意时刻只允许一个维护操作运行。
 *
 * 设计约束：
 * - 获取必须是同步的（调用方在首个 await 之前完成 check-and-set），
 *   否则事件循环间隙仍可被并发请求穿透；
 * - 锁不自动排队：拿到锁的操作通常持续数秒到数分钟，排队会让用户
 *   请求悬挂且无法给出明确反馈，调用方以「正在…，请稍候」快速失败；
 * - 释放带令牌校验：过期操作不得释放后来者的锁。
 */

/** 维护类型 → 用户可读文案 */
const KIND_LABELS = {
  scan: '扫描中',
  'partial-scan': '扫描中',
  switch: '切换模型库',
  load: '加载模型库',
  restore: '恢复备份'
}

/** 当前持锁操作（null 表示空闲） */
let active = null
/** 令牌自增序号：保证同一毫秒内的前后两次获取也可区分 */
let nextTokenId = 0

/**
 * 同步尝试获取维护锁。
 * @param {'scan'|'partial-scan'|'switch'|'load'|'restore'} kind 维护类型
 * @param {string|null} [root] 操作绑定的模型根目录（诊断与审计用）
 * @returns {{id: number, kind: string, root: string|null, startedAt: number}|null}
 *   成功返回令牌；已有操作持锁时返回 null
 */
export function tryAcquireMaintenance(kind, root = null) {
  if (active) return null
  active = {
    id: ++nextTokenId,
    kind,
    root: root || null,
    startedAt: Date.now()
  }
  return { ...active }
}

/**
 * 释放维护锁（仅令牌对应的持有者有效）。
 * @param {{id: number}|null} token tryAcquireMaintenance 返回的令牌
 */
export function releaseMaintenance(token) {
  if (!token || !active) return
  if (active.id === token.id) active = null
}

/** 当前维护状态快照（无持锁返回 null；用于诊断与忙提示） */
export function getMaintenanceState() {
  return active ? { ...active } : null
}

/** 当前持锁操作的忙提示文案（空闲时为空串） */
export function maintenanceBusyMessage() {
  if (!active) return ''
  return `正在${KIND_LABELS[active.kind] || '执行维护操作'}，请稍候`
}

/**
 * 在维护锁内执行操作（拿不到锁时抛出 code=EBUSY 的错误）。
 * @template T
 * @param {'scan'|'partial-scan'|'switch'|'load'|'restore'} kind 维护类型
 * @param {string|null} root 操作绑定的模型根目录
 * @param {(token: {id: number, kind: string, root: string|null, startedAt: number}) => Promise<T>} fn 操作体
 * @returns {Promise<T>}
 */
export async function runMaintenance(kind, root, fn) {
  const token = tryAcquireMaintenance(kind, root)
  if (!token) {
    const err = new Error(maintenanceBusyMessage())
    err.code = 'EBUSY'
    throw err
  }
  try {
    return await fn(token)
  } finally {
    releaseMaintenance(token)
  }
}
