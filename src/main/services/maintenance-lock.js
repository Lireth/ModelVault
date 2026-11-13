/**
 * 全局维护锁（V-02）：
 * 扫描、局部扫描、切库、备份恢复都会改写「当前根目录」及其关联存储，
 * 彼此并发会造成跨库写入、缩略图误删与恢复结果被覆盖。本模块提供
 * 进程内单一互斥锁，任意时刻只允许一个维护操作运行。
 *
 * 两层互斥语义（OPT-14）：
 * - 大维护操作（scan/switch/restore/import 等）彼此互斥，与文件操作互斥；
 * - 文件操作（file-op：删除/重命名/移动/整理等小粒度破坏性操作）彼此
 *   兼容、可并发持有——渲染层批量删除按 8 路并发调用同一 IPC 通道，
 *   严格互斥会让 7 路误报「忙」失败；它们与大维护操作互斥即可堵住
 *   「删除与恢复整目录交换、扫描 relink 并发交错」的一致性风险。
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
  restore: '恢复备份',
  health: '检查模型库',
  repair: '修复模型库',
  import: '导入模型',
  backup: '备份数据',
  'file-op': '执行文件操作',
}

/**
 * 维护锁令牌（tryAcquireMaintenance 返回值）
 * @typedef {object} MaintenanceToken
 * @property {number} id
 * @property {string} kind
 * @property {string|null} root
 * @property {number} startedAt
 */

/** 当前持锁的大维护操作（null 表示无） */
/** @type {MaintenanceToken|null} */
let active = null
/** 在途并发文件操作（id → 令牌快照；file-op 彼此兼容，与大维护操作互斥） */
const activeFileOps = new Map()
/** 令牌自增序号：保证同一毫秒内的前后两次获取也可区分 */
let nextTokenId = 0

/**
 * 同步尝试获取维护锁。
 * @param {'scan'|'partial-scan'|'switch'|'load'|'restore'|'health'|'repair'|'import'|'backup'|'file-op'} kind 维护类型
 * @param {string|null} [root] 操作绑定的模型根目录（诊断与审计用）
 * @returns {{id: number, kind: string, root: string|null, startedAt: number}|null}
 *   成功返回令牌；与大维护操作或 file-op 互斥冲突时返回 null
 */
export function tryAcquireMaintenance(kind, root = null) {
  if (kind === 'file-op') {
    // 文件操作彼此兼容（并发删除/改名互不冲突），仅被大维护操作排除
    if (active) return null
    const token = {
      id: ++nextTokenId,
      kind,
      root: root || null,
      startedAt: Date.now(),
    }
    activeFileOps.set(token.id, token)
    return { ...token }
  }
  if (active || activeFileOps.size > 0) return null
  active = {
    id: ++nextTokenId,
    kind,
    root: root || null,
    startedAt: Date.now(),
  }
  return { ...active }
}

/**
 * 释放维护锁（仅令牌对应的持有者有效）。
 * @param {{id: number}|null} token tryAcquireMaintenance 返回的令牌
 */
export function releaseMaintenance(token) {
  if (!token) return
  // 文件操作令牌按 id 出账；未命中再按大维护操作令牌校验释放
  if (activeFileOps.delete(token.id)) return
  if (active && active.id === token.id) active = null
}

/** 当前维护状态快照（无持锁返回 null；用于诊断与忙提示） */
export function getMaintenanceState() {
  if (active) return { ...active }
  if (activeFileOps.size > 0) {
    // 并发文件操作取任一在途令牌作代表快照，附并发数供诊断
    const first = activeFileOps.values().next().value
    return { ...first, count: activeFileOps.size }
  }
  return null
}

/** 当前持锁操作的忙提示文案（空闲时为空串） */
export function maintenanceBusyMessage() {
  if (active) {
    return `正在${KIND_LABELS[active.kind] || '执行维护操作'}，请稍候`
  }
  if (activeFileOps.size > 0) {
    return `正在${KIND_LABELS['file-op']}，请稍候`
  }
  return ''
}

/**
 * 在维护锁内执行操作（拿不到锁时抛出 code=EBUSY 的错误）。
 * @template T
 * @param {'scan'|'partial-scan'|'switch'|'load'|'restore'|'health'|'repair'|'import'|'backup'|'file-op'} kind 维护类型
 * @param {string|null} root 操作绑定的模型根目录
 * @param {(token: {id: number, kind: string, root: string|null, startedAt: number}) => Promise<T>} fn 操作体
 * @returns {Promise<T>}
 */
export async function runMaintenance(kind, root, fn) {
  const token = tryAcquireMaintenance(kind, root)
  if (!token) {
    const err = /** @type {Error & {code: string}} */ (
      new Error(maintenanceBusyMessage())
    )
    err.code = 'EBUSY'
    throw err
  }
  try {
    return await fn(token)
  } finally {
    releaseMaintenance(token)
  }
}
