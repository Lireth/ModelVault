import fs from 'node:fs/promises'
import logger from '../../logger'
import { getModelMeta } from '../store'
import { setHashPoolConcurrency } from '../hash-worker-pool'
import { resolveAdaptiveHashConcurrency } from '../disk-profile'
import {
  AUTO_WARMUP_CONCURRENCY,
  MAX_WARMUP_CONCURRENCY,
  MIN_WARMUP_CONCURRENCY,
} from '../../../shared/app-enums'
import { errorName } from '../../../shared/error-text'
import { warmup, HASH_FAIL_RETRY_BASE_MS } from './state'
import { isHashFailSuppressed, recordHashFailure } from './failures'
import {
  normalizeRequestItems,
  rememberInfo,
  hasValidCachedHash,
  ensureQuickFingerprint,
  enqueueCollisionPeers,
} from './size-index'
import { emitProgress } from './progress'
import { computeAndCacheHash } from './compute'

/** @typedef {import('./state').WarmupTask} WarmupTask */

/**
 * 队列与 drain 调度域（O8 自 hash-warmup.js 拆出）：
 * 入队/去重/插队、策略收口、并发档位、延迟调度与多 lane 消费、
 * 扫描暂停/恢复与测试辅助（idle 等待、状态复位）。
 */

/** 普通入队后的延迟启动间隔（ms）：避开扫描刚结束/缩略图生成的 I/O 高峰 */
const WARMUP_DELAY_MS = 3000

/**
 * 哈希预热策略（O1）：
 * - candidates：仅对「存在同尺寸文件」的模型计算 SHA256——内容相同的文件
 *   必然大小相同，大小唯一的模型不可能存在重复副本，无需读盘哈希；
 * - full：为全部缺失哈希的模型计算（旧行为，供设置显式选择）；
 * - off：后台不预热，仅保留详情页/识别链路的按需计算。
 * 服务层缺省 full 保持既有调用语义；应用入口始终显式传入设置值。
 */
/**
 * 预热策略档位（candidates 候选预筛 / full 全量 / off 关闭）。
 * @typedef {'candidates'|'full'|'off'} WarmupMode
 */
const VALID_MODES = new Set(['candidates', 'full', 'off'])
const DEFAULT_MODE = 'full'

/**
 * 后台预热并行消费数（OPT-3/OP-B）：
 * - AUTO_WARMUP_CONCURRENCY（0）= 自动档（新装默认，设置项显式选择）：drain
 *   启动时按队首任务所在盘的随机读延迟探测磁盘介质解析实际并发（SSD/NVMe
 *   → 4、SATA SSD → 2、HDD/探测失败 → 1），每盘符缓存；解析结果同步线程池，
 *   批量预热与识别链路共用同一执行池；
 * - 1 = 串行（服务层缺省，机械硬盘/移动硬盘的手动保守档）；
 * - 2-4 = 手动档，立即同步线程池并行度。
 * 经 setHashWarmupConcurrency 调整（requestHashWarmup 的 opts.concurrency 与
 * settings:update 链路）。并发数在 drain 启动时解析：批量进行中调整自下一轮
 * 批量生效。
 */
let warmupConcurrency = 1

/**
 * 调整哈希预热并行消费数（OPT-3/OP-B）：
 * - 0（自动档）：仅记录档位标记，不同步线程池——实际并发在 drain 启动时
 *   按目标盘探测解析后同步（不同库可能位于不同介质）；
 * - 1-4（手动档）：立即同步线程池并行度（识别链路即时生效）。
 * 非法值按串行处理（服务层既有语义保持）。
 * @param {number} n 并行任务数（0 = 自动档；非法值按 1 处理）
 */
export function setHashWarmupConcurrency(n) {
  const value = Number(n)
  if (value === AUTO_WARMUP_CONCURRENCY) {
    warmupConcurrency = AUTO_WARMUP_CONCURRENCY
    return
  }
  warmupConcurrency =
    Number.isFinite(value) && value >= MIN_WARMUP_CONCURRENCY
      ? Math.min(MAX_WARMUP_CONCURRENCY, Math.floor(value))
      : MIN_WARMUP_CONCURRENCY
  setHashPoolConcurrency(warmupConcurrency)
}

/**
 * 解析本次 drain 的实际并发（OP-B 自动档）：
 * 手动档直接返回设置值；自动档按队首任务所在盘探测（磁盘探测缓存按盘符
 * 命中，重复触发零成本），解析结果同步线程池——批量预热与识别链路（按需
 * 哈希）共用同一执行池，介质判定对两条链路一致生效。队列为空或文件体积
 * 未知时保守串行。
 * @returns {Promise<number>} 本次 drain 的 lane 数
 */
async function resolveEffectiveLanes() {
  if (warmupConcurrency !== AUTO_WARMUP_CONCURRENCY) return warmupConcurrency
  const head = warmup.queue[0]
  if (!head) return MIN_WARMUP_CONCURRENCY
  const resolved = await resolveAdaptiveHashConcurrency(
    head.id,
    warmup.knownInfo.get(head.id)?.size ?? null,
  )
  setHashPoolConcurrency(resolved)
  return resolved
}

/**
 * 策略值收口：未知值回退 full（保持既有调用方语义）
 * @param {any} mode 请求携带的策略值（未知值回退 DEFAULT_MODE）
 * @returns {WarmupMode}
 */
function normalizeMode(mode) {
  return VALID_MODES.has(mode) ? mode : DEFAULT_MODE
}

/**
 * 丢弃队列中尚未开始的普通后台任务（保留详情页/识别的 force 任务）。
 * 全量快照请求代表「当前库 + 当前策略」的最新事实：旧排队项可能来自
 * 已删除模型或旧策略（如用户切换到关闭/仅候选），必须作废后重新规划；
 * 已在计算的单个文件不中断（与扫描暂停语义一致）。
 */
function dropQueuedBackground() {
  for (let i = warmup.queue.length - 1; i >= 0; i--) {
    // 循环边界保证 i < queue.length，索引必命中（类型 cast，运行时零改动）
    if (/** @type {WarmupTask} */ (warmup.queue[i]).force) continue
    warmup.queued.delete(/** @type {WarmupTask} */ (warmup.queue[i]).id)
    warmup.queue.splice(i, 1)
  }
}

/**
 * 入队（force=true 时插队，供详情页/识别按需任务使用）
 * @param {string} id 模型绝对路径
 * @param {boolean} force 是否按需优先任务（插队）
 * @param {WarmupMode} mode 入队时的策略快照
 * @returns {boolean} 是否新增/升级了队列任务
 */
export function pushQueue(id, force, mode) {
  if (warmup.queued.has(id)) {
    // priority 请求对已在队任务升级为 force 并移至队首：批量预热先入队的
    // 后台位不得让详情页预取排在整条队列之后；返回 true 让调用方立即调度
    if (!force) return false
    const index = warmup.queue.findIndex((task) => task.id === id)
    if (index === -1) return false
    warmup.queue.splice(index, 1)
    warmup.queue.unshift({ id, force: true, mode: 'full' })
    return true
  }
  if (warmup.inflight.has(id)) return false
  warmup.queued.add(id)
  if (force) warmup.queue.unshift({ id, force: true, mode: 'full' })
  else warmup.queue.push({ id, force: false, mode })
  return true
}

/**
 * 请求预热一批模型的哈希（去重入队，由 drain 后台串行消费）。
 *
 * O1：默认策略由应用入口显式传入。candidates 模式下先按体积分组，仅对
 * 同尺寸成员数 ≥2 的模型计算 SHA256；full 模式保持旧行为；off 模式不入队
 * （priority 按需任务始终生效）。体积未知的条目先入队，由 drain 在 stat
 * 后按真实体积决定是否计算/是否补入同尺寸同伴。
 *
 * @param {Array<string|{id:string, size?:number, mtimeMs?:number}>} items 模型列表
 * @param {{priority?: boolean, delayMs?: number, mode?: 'candidates'|'full'|'off',
 *   full?: boolean, concurrency?: number}} [opts]
 *   priority: 插队到队首并立即启动（详情页打开当前模型），不受策略限制；
 *   mode: 预热策略（缺省 full，保持服务层既有语义）；
 *   full: 本次请求是否代表完整库快照（全量扫描/启动加载 → 重置体积索引）；
 *   delayMs: 普通入队的延迟启动间隔（默认 3s）；
 *   concurrency: 哈希预热并行消费数（OPT-3，调用方自设置读取传入；
 *   缺省保持当前值——应用入口始终显式传出的既有约定）
 */
export function requestHashWarmup(items, opts = {}) {
  const priority = opts.priority === true
  const mode = priority ? 'full' : normalizeMode(opts.mode)
  if (opts.concurrency !== undefined) {
    setHashWarmupConcurrency(opts.concurrency)
  }
  const list = normalizeRequestItems(items)
  // 全量快照：作废旧策略/旧库的排队项，并整体替换体积索引，
  // 清除已删除/已移出模型的陈旧记录（在途计算与 force 任务保留）
  if (opts.full === true) {
    dropQueuedBackground()
    warmup.knownInfo.clear()
    warmup.sizeIndex.clear()
  }
  for (const item of list) rememberInfo(item.id, item.size, item.mtimeMs)

  let added = false
  const touchedSizes = new Set()
  for (const item of list) {
    if (priority) {
      if (pushQueue(item.id, true, 'full')) added = true
      continue
    }
    if (mode === 'off') continue
    if (mode === 'full') {
      // P1-2：缓存有效（哈希存在且 mtime 与本次快照一致）的条目免入队——
      // 此前全量模式下已缓存条目也逐个入队，由 drain 串行 stat 复核后跳过，
      // 缓存哈希的大库启动/扫描后是分钟级的纯 stat 开销。扫描/openLibrary/
      // loadStore 路径传入的 mtime 即最新事实（扫描为实时 stat、索引为上次
      // 扫描快照）；mtime 未知的裸 id 保守入队（hasValidCachedHash 为 false），
      // 行为与旧实现一致。识别链路 ensureHash 以实时 stat 复核缓存，跳过方
      // 不引入陈旧哈希风险。
      // OPT-6：同版本近期失败的条目同样免入队（负缓存，静默期内不重读盘）
      if (
        !hasValidCachedHash(item.id) &&
        !isHashFailSuppressed(item.id, item.mtimeMs) &&
        pushQueue(item.id, false, 'full')
      )
        added = true
      continue
    }
    // candidates：体积已知则先记录分组，待全部条目登记后统一判定；
    // 体积未知则入队，由 drain 在 stat 后按真实体积决定
    const info = warmup.knownInfo.get(item.id)
    if (Number.isFinite(info?.size)) touchedSizes.add(info.size)
    else if (pushQueue(item.id, false, 'candidates')) added = true
  }
  if (mode === 'candidates') {
    for (const size of touchedSizes) {
      if (enqueueCollisionPeers(size)) added = true
    }
  }

  if (!added) {
    // 全量快照可能刚丢弃了旧排队项（如切换到关闭策略）：广播一次以清除
    // 渲染层残留的「排队中」计数，避免界面显示已不存在的任务
    if (opts.full === true) {
      emitProgress(
        { active: false, id: '', percent: 0, hashedBytes: 0, totalBytes: 0 },
        true,
      )
    }
    return
  }
  // 队列计数变化立即广播（渲染层可显示排队数）
  emitProgress(
    { active: false, id: '', percent: 0, hashedBytes: 0, totalBytes: 0 },
    true,
  )
  scheduleDrain(priority ? 0 : (opts.delayMs ?? WARMUP_DELAY_MS))
}

/** 扫描开始：暂停 drain 取队（正在计算的单个文件不中断，处理完当前即停） */
export function pauseHashWarmup() {
  warmup.paused = true
}

/**
 * 扫描结束：恢复取队；队列非空且无既定计划时重新调度。
 * @param {number} [delayMs] 恢复调度的延迟间隔（生产默认 3s，测试可传 0）
 */
export function resumeHashWarmup(delayMs = WARMUP_DELAY_MS) {
  warmup.paused = false
  if (warmup.queue.length > 0 && !warmup.drainTimer && !warmup.draining)
    scheduleDrain(delayMs)
}

/**
 * 调度一次 drain（全局唯一；重复调度时保留更早的计划，优先任务可提前）
 * @param {number} delayMs 延迟（ms）
 */
function scheduleDrain(delayMs) {
  const runAt = Date.now() + delayMs
  if (warmup.drainTimer && runAt >= warmup.drainScheduledAt) return
  if (warmup.drainTimer) clearTimeout(warmup.drainTimer)
  warmup.drainScheduledAt = runAt
  warmup.drainTimer = setTimeout(() => {
    warmup.drainTimer = null
    drain()
  }, delayMs)
}

/**
 * 串行消费队列（OPT-3 前的既有语义保留为单 lane）：逐个 stat 复查 →
 * 候选策略判定 → 跳过有效缓存 → 计算并回写。
 * @returns {Promise<void>} 队列清空或扫描期暂停时返回
 */
async function drainLane() {
  while (warmup.queue.length > 0 && !warmup.paused) {
    // while 长度判定保证 shift 必命中（类型 cast，运行时零改动）
    const task = /** @type {WarmupTask} */ (warmup.queue.shift())
    const id = task.id
    warmup.queued.delete(id)
    // 出队即计消费（缓存命中/文件缺失/候选跳过的条目同样计入，保持计数连贯）；
    // consumedIds 防止「候选碰撞后补入队」把同一模型重复计数
    if (!warmup.consumedIds.has(id)) {
      warmup.consumedIds.add(id)
      warmup.doneCount += 1
    }
    if (warmup.inflight.has(id)) continue
    let stat
    try {
      stat = await fs.stat(id)
      if (!stat.isFile()) continue
    } catch {
      continue // 文件已被删除/移动：静默跳过
    }
    // 以真实体积更新索引：扫描结果里的 size 可能已过期，stat 是候选判定的唯一依据
    rememberInfo(id, stat.size, stat.mtimeMs)
    if (!task.force) {
      if (task.mode === 'off') continue
      if (task.mode === 'candidates') {
        const group = warmup.sizeIndex.get(stat.size)
        if (!group || group.size < 2) continue // 体积唯一：不可能有重复副本
        // OP-C 两阶段查重：阶段一以快指纹筛选同尺寸组——指纹互异的文件
        // 头/尾字节必然不同，内容不可能相同，直接跳过全量 SHA256（同尺寸
        // 全互异的常见场景把组内查重 IO 从「组员体积之和」降到 2MB × 组员数）；
        // 仅指纹相同的候选组进入阶段二（全量 SHA256 确认，中段不同的
        // 超集误报在此被正确排除）。自身指纹不可得（IO 失败）时保守回退
        // 全量判定（旧行为）。
        const myFp = await ensureQuickFingerprint(id)
        if (myFp) {
          let collisionCount = 1
          for (const peerId of group) {
            if (peerId === id) continue
            if ((await ensureQuickFingerprint(peerId)) !== myFp) continue
            collisionCount += 1
            // 指纹相同的同伴补入队（各自 drain 轮次经同一筛选后确认全量哈希；
            // pushQueue 自带 queued/inflight 去重），已有有效全量哈希的同伴跳过
            if (!hasValidCachedHash(peerId)) {
              pushQueue(peerId, false, 'candidates')
            }
          }
          if (collisionCount < 2) continue
        }
      }
    }
    const meta = getModelMeta(id)
    if (meta?.hash && meta.hashMtime === stat.mtimeMs) continue // 缓存有效，免计算
    // OPT-6 负缓存：同版本近期失败且静默期未到——跳过本轮读盘重试，
    // 消除「损坏/被占用的 10GB 文件每轮扫描完整读盘失败一遍」的持续成本。
    // force（详情页/识别 priority）任务不受限：用户显式等待结果
    if (!task.force && isHashFailSuppressed(id, stat.mtimeMs)) continue
    try {
      // 详情页/识别 priority 任务走线程池前台通道；后台批量保持普通优先级
      await computeAndCacheHash(id, stat.mtimeMs, { priority: task.force })
      logger.info(`后台哈希预热完成: ${id}`)
    } catch (err) {
      if (errorName(err) === 'PreemptedError') {
        // 前台任务让路：后台任务被线程池在块边界中止，重新入队等待前台完成，
        // 不视为失败，避免用户打开详情后批量预热静默丢模型。
        logger.info(`后台哈希任务让路，已重新入队: ${id}`)
        // 该任务出队时已计入 done/consumed；让路后重新排队，回退计数，
        // 待重算完成时再次计入，避免进度出现“done + remaining > 总数”。
        if (warmup.consumedIds.delete(id))
          warmup.doneCount = Math.max(0, warmup.doneCount - 1)
        if (!warmup.queued.has(id)) {
          warmup.queued.add(id)
          warmup.queue.push({ id, force: false, mode: task.mode })
        }
        continue
      }
      if (errorName(err) === 'AbortError') {
        // OPT-13：任务被同 id 新 mtime 请求取代（文件已被改写）——静默跳过，
        // 新版本由下一次扫描/按需请求照常入队，不计入失败负缓存
        logger.info(`后台哈希任务被新版本请求取代，已跳过: ${id}`)
        continue
      }
      // OPT-6：记入负缓存（mtime 键控 + 指数退避），静默期内批量预热跳过
      recordHashFailure(id, stat.mtimeMs, err)
    }
  }
}

/**
 * 消费预热队列（OPT-3 并行改造 + OP-B 自适应）：按并发档位启动至多 N 条
 * 取队 lane 并行消费（1 = 串行，既有行为）。手动档直接用设置值；自动档
 * 在启动时按队首任务所在盘探测解析（disk-profile，每盘符缓存），批量预热
 * 与识别链路共用同一执行池。lane 共享同一队列 FIFO，同一模型只会被一条
 * lane 取走（队列内 id 唯一）；进入扫描期（paused）后各 lane 在当前任务
 * 完成后依次退出，已在计算的单个文件不中断。
 * 并发数在本次 drain 启动时解析，批量进行中调整自下一轮批量生效。
 */
async function drain() {
  if (warmup.draining) return
  warmup.draining = true
  try {
    const lanes = []
    const laneCount = await resolveEffectiveLanes()
    for (let i = 0; i < laneCount; i++) lanes.push(drainLane())
    await Promise.all(lanes)
    if (warmup.queue.length === 0 && warmup.doneCount > 0) {
      // 本轮批量清空：先广播最终计数，再归零供下一轮从 0 计数
      emitProgress(
        { active: false, id: '', percent: 0, hashedBytes: 0, totalBytes: 0 },
        true,
      )
      warmup.doneCount = 0
      warmup.consumedIds.clear()
    }
  } finally {
    warmup.draining = false
  }
}

/* ---------------- 仅供单元测试使用 ---------------- */

/** 等待队列清空且所有计算完成（测试辅助，轮询直至空闲） */
export async function whenWarmupIdle() {
  while (
    warmup.queue.length > 0 ||
    warmup.draining ||
    warmup.inflight.size > 0
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** 清空全部内部状态（测试隔离用；生产代码严禁调用） */
export function resetHashWarmupForTests() {
  warmup.queue.length = 0
  warmup.queued.clear()
  warmup.inflight.clear()
  warmup.knownInfo.clear()
  warmup.sizeIndex.clear()
  warmup.consumedIds.clear()
  warmup.hashFailures.clear()
  warmup.hashFailRetryBaseMs = HASH_FAIL_RETRY_BASE_MS
  warmup.paused = false
  warmup.draining = false
  warmup.doneCount = 0
  warmup.lastEmitAt = 0
  warmupConcurrency = 1
  // 线程池并行度一并复位：前序用例的自动档解析/手动调整不泄漏
  setHashPoolConcurrency(1)
  if (warmup.drainTimer) {
    clearTimeout(warmup.drainTimer)
    warmup.drainTimer = null
    warmup.drainScheduledAt = 0
  }
}
