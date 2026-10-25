import fs from 'node:fs/promises'
import logger from '../logger'
import { getModelMeta, setModelMeta } from './store'
import { computeFileHash } from './civitai'
import { isRetryableHashPoolError } from './hash-worker-pool'

/**
 * 模型哈希后台预热服务（Civitai 识别加速）：
 *
 * Civitai by-hash 反查要求完整的文件 SHA256，大文件（1-10GB）首次计算
 * 耗时数十秒。本服务在应用启动/扫描完成后于后台预计算缺失的哈希并
 * 写入元数据缓存（hash/hashMtime，与识别链路共用同一缓存约定），用户点击
 * 识别时命中缓存即可秒回。
 *
 * O1 体积预筛：重复检测只可能发生在大小相同的文件之间（内容相同必然
 * 大小相同）。默认 candidates 策略先按体积分组，仅对同尺寸成员数 ≥2 的
 * 模型读盘计算，避免首次扫描后把整个模型库顺序读一遍；详情页/识别的
 * 按需任务（priority）不受策略限制。全库预热与关闭策略由设置显式选择。
 *
 * 设计要点：
 * - 单文件串行处理：避免多路大文件读取争抢磁盘 I/O（与后台缩略图共用磁盘）；
 * - 去重：队列内 queued 集合 + 计算中 inflight 映射双重拦截；
 * - 共享计算：computeAndCacheHash 是预热与识别链路的唯一哈希计算入口，
 *   识别到达时若同一模型（同 mtime）正在预热，直接复用同一 Promise，
 *   绝不重复读盘计算；
 * - 写盘前重读最新元数据：哈希计算期间用户可能已并发保存其他字段
 *   （与 ipc/models/civitai.js ensureHash 的既有约定一致）；
 * - 版本竞态防护：计算完成后复查文件 mtime，期间被覆盖/删除则丢弃结果
 *   并抛错——「哈希 ↔ 文件版本」的对应关系绝不被污染（识别链路据此反查
 *   模型版本，宁可重算也绝不绑定旧哈希）；
 * - 扫描让路：全量/局部扫描期间暂停取队（正在计算的单个文件不中断），
 *   扫描结束后自动恢复，避免预热拖慢扫描；
 * - 容错：文件已删除/移动（stat 失败）静默跳过，不中断队列；
 * - 临时故障重试（OPT-05）：线程池崩溃/连续不可用/临时文件占用统一在
 *   computeAndCacheHash 内重试（最多 2 次，退避 300ms），永久错误不重试。
 */

/** 普通入队后的延迟启动间隔（ms）：避开扫描刚结束/缩略图生成的 I/O 高峰 */
const WARMUP_DELAY_MS = 3000

/** 进度事件节流间隔（ms）：哈希每块（8MB）回调一次，高频事件须限流 */
const PROGRESS_INTERVAL_MS = 300

/**
 * 线程池临时故障重试（OPT-05）：worker 崩溃/临时文件占用时最多重试 2 次；
 * 退避等待与线程池重启延迟（250ms 起）错开，避免立即撞上未就绪的新 worker。
 */
const TRANSIENT_RETRY_MAX = 2
const TRANSIENT_RETRY_DELAY_MS = 300

/** 重试退避时长（测试可注入 0 避免真实等待） */
let transientRetryDelayMs = TRANSIENT_RETRY_DELAY_MS

/**
 * 注入临时故障重试退避时长（仅供单元测试使用；生产代码严禁调用）
 * @param {number} ms 毫秒数
 */
export function setHashRetryDelayForTests(ms) {
  transientRetryDelayMs = Number.isFinite(ms) && ms >= 0 ? ms : TRANSIENT_RETRY_DELAY_MS
}

/**
 * 哈希预热策略（O1）：
 * - candidates：仅对「存在同尺寸文件」的模型计算 SHA256——内容相同的文件
 *   必然大小相同，大小唯一的模型不可能存在重复副本，无需读盘哈希；
 * - full：为全部缺失哈希的模型计算（旧行为，供设置显式选择）；
 * - off：后台不预热，仅保留详情页/识别链路的按需计算。
 * 服务层缺省 full 保持既有调用语义；应用入口始终显式传入设置值。
 */
const VALID_MODES = new Set(['candidates', 'full', 'off'])
const DEFAULT_MODE = 'full'

/**
 * 已知模型体积/修改时间（id -> {size, mtimeMs}）：
 * 候选预筛的数据源。full 请求（全量扫描/启动加载）整体替换；
 * 局部扫描请求按 id 合并，允许保留历史体积用于跨子树的同尺寸碰撞判断。
 */
const knownInfo = new Map()
/** 体积 -> 模型 id 集合（同尺寸反查，用于发现重复候选） */
const sizeIndex = new Map()

/** 进度事件推送监听（由 IPC 层经 setWarmupProgressListener 注册并广播渲染进程） */
let progressListener = null

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
  progressListener = typeof fn === 'function' ? fn : null
}

/** 本轮队列已消费的模型数（队列清空后归零，新一轮批量从 0 计数） */
let doneCount = 0

/** 上次节流推送时间（ms 时间戳） */
let lastEmitAt = 0

/**
 * 推送一次进度快照（拼入实时队列计数；节流仅作用于高频的哈希块回调，
 * 状态跃迁经 force 立即送达）。
 * @param {{active: boolean, id: string|null, percent: number, hashedBytes: number,
 *   totalBytes: number, hash?: string}} snap 当前计算的温度快照
 * @param {boolean} [force] 跳过节流立即推送
 */
function emitProgress(snap, force = false) {
  if (!progressListener) return
  const now = Date.now()
  // 节流仅在普通 tick 之间生效：状态跃迁（force）不占用节流窗口，
  // 避免开始事件把随后的首个进度 tick 吞掉
  if (!force) {
    if (now - lastEmitAt < PROGRESS_INTERVAL_MS) return
    lastEmitAt = now
  }
  try {
    progressListener({
      active: snap.active,
      id: snap.id,
      percent: snap.percent,
      hashedBytes: snap.hashedBytes,
      totalBytes: snap.totalBytes,
      done: doneCount,
      remaining: queue.length,
      hash: snap.hash || ''
    })
  } catch {
    // 进度推送失败不影响预热本身
  }
}

/**
 * 待预热队列（FIFO；优先任务 unshift 插队）：
 * 元素为 { id, force, mode }——force 标记详情页/识别的按需任务（不受策略限制），
 * mode 记录入队时的策略快照，避免设置切换后对已排队任务产生歧义。
 */
const queue = []
/** 队列去重集合（与 queue 同步维护） */
const queued = new Set()
/** 进行中的哈希任务：id -> { mtimeMs, promise }（供识别链路共享复用） */
const inflight = new Map()
/**
 * 本轮已消费的模型 id（用于 done 计数去重）：
 * 候选预筛在体积首次暴露碰撞时可能把先前跳过的模型重新入队，
 * 同一模型不应被重复计数（否则进度显示会超过实际模型数）。
 */
const consumedIds = new Set()
/** 延迟启动定时器（全局唯一，重复调度时保留更早的计划） */
let drainTimer = null
/** 定时器计划触发时间（ms 时间戳），用于比较保留更早计划 */
let drainScheduledAt = 0
/** drain 是否正在消费队列 */
let draining = false
/** 扫描期间置 true：drain 暂停取队（已在计算的单个文件不中断） */
let paused = false

/** 等待指定毫秒（重试退避） */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 带临时故障重试的哈希计算（OPT-05）：
 * 仅对 worker 崩溃/连续不可用/临时文件占用等可恢复错误重试，最多 2 次；
 * 每次重试前复位进度并等待线程池退避重启。永久错误（ENOENT/EACCES 等）
 * 直接抛出，不进行无效重试。
 * @param {string} id 模型绝对路径
 * @param {boolean} priority 是否前台优先任务
 * @param {{active: boolean, id: string, percent: number, hashedBytes: number,
 *   totalBytes: number, hash: string}} snap 进度快照
 * @returns {Promise<string>} SHA256
 */
async function computeHashWithRetry(id, priority, snap) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await computeFileHash(
        id,
        undefined,
        (hashedBytes, totalBytes) => {
          snap.hashedBytes = hashedBytes
          snap.totalBytes = totalBytes
          snap.percent =
            totalBytes > 0 ? Math.min(100, Math.round((hashedBytes / totalBytes) * 100)) : 0
          emitProgress(snap)
        },
        { priority }
      )
    } catch (err) {
      if (attempt >= TRANSIENT_RETRY_MAX || !isRetryableHashPoolError(err)) throw err
      logger.warn(
        `哈希计算临时失败，${transientRetryDelayMs}ms 后重试` +
          `（第 ${attempt + 1}/${TRANSIENT_RETRY_MAX} 次）: ${id} ${err.message}`
      )
      // 上一次尝试可能已推送过部分进度：重试前复位，避免界面停在旧百分比
      snap.percent = 0
      snap.hashedBytes = 0
      snap.totalBytes = 0
      emitProgress(snap, true)
      await delay(transientRetryDelayMs)
    }
  }
}

/**
 * 计算并缓存模型哈希（预热与识别链路共用的单一入口）：
 * 同一模型同 mtime 已在计算中时复用同一 Promise；完成后重读最新元数据
 * 回写 hash/hashMtime。线程池临时故障自动重试（OPT-05）。
 * 计算完成后复查文件 mtime：期间被同名覆盖/移动/删除时抛错且不写缓存
 * （此时哈希对应旧版本或混合内容，写入会让识别链路反查到错误的模型版本）。
 * @param {string} id 模型绝对路径
 * @param {number} mtimeMs 调用方 stat 到的文件 mtime（保证缓存与文件版本对应）
 * @param {{priority?: boolean}} [options] priority=true 为前台任务（详情页/识别），
 *   线程池会优先执行并让在途后台任务让路（OPT-08）
 * @returns {Promise<string>} 64 位十六进制 SHA256
 * @throws 计算期间文件版本变化（mtime 不一致/已删除）或底层哈希错误
 */
export function computeAndCacheHash(id, mtimeMs, options = {}) {
  const priority = options.priority === true
  const current = inflight.get(id)
  if (current && current.mtimeMs === mtimeMs) return current.promise
  const promise = (async () => {
    // 本次计算的进度快照（识别与预热链路共用，事件按 id 供渲染层匹配；
    // hash 完成后回填，随完成事件送达渲染层——FEAT-1 重复检测数据源）
    const snap = { active: true, id, percent: 0, hashedBytes: 0, totalBytes: 0, hash: '' }
    try {
      emitProgress(snap, true)
      const hash = await computeHashWithRetry(id, priority, snap)
      // 竞态防护：大文件哈希耗时数十秒，期间文件可能被同名覆盖（重新下载/
      // 同步工具写入）。此时哈希对应旧版本或新旧混合内容，若仍以计算前的
      // mtime 落盘，缓存会与 knownInfo 的旧 mtime 判定为有效（hasValidCachedHash），
      // 识别链路据被污染的哈希反查到错误的模型版本。完成后复查 mtime：
      // 不一致（或文件已消失/不再是普通文件）即丢弃结果，绝不写缓存
      let after
      try {
        after = await fs.stat(id)
      } catch {
        throw new Error('哈希计算期间文件被移动或删除，本次结果已丢弃')
      }
      if (!after.isFile() || after.mtimeMs !== mtimeMs) {
        throw new Error('哈希计算期间文件被修改，本次结果已丢弃，请重试')
      }
      snap.hash = hash
      // 写盘前重读最新元数据：哈希计算期间用户可能已并发保存其他字段
      const latest = getModelMeta(id) || {}
      setModelMeta(id, { ...latest, hash, hashMtime: mtimeMs })
      return hash
    } finally {
      // 完成即熄灭本快照（active=false），渲染层据此清除当前模型的进度标识
      snap.active = false
      emitProgress(snap, true)
    }
  })()
  const entry = { mtimeMs, promise }
  inflight.set(id, entry)
  // 完成后清理映射；拒绝场景下 finally 派生的 promise 由尾部 catch 消费
  // （预热为后台任务可能无调用方 await，防 unhandledRejection；识别链路
  // await 的是原始 promise，仍能拿到错误自行处理）
  promise
    .finally(() => {
      if (inflight.get(id) === entry) inflight.delete(id)
    })
    .catch(() => {})
  return promise
}

/** 规范化请求项：字符串或 {id, size, mtimeMs} 对象（扫描装饰结果可直接传入） */
function normalizeRequestItems(items) {
  const out = []
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item === 'string' && item) {
      out.push({ id: item, size: null, mtimeMs: null })
    } else if (item && typeof item === 'object' && typeof item.id === 'string' && item.id) {
      out.push({
        id: item.id,
        size: Number.isFinite(item.size) ? item.size : null,
        mtimeMs: Number.isFinite(item.mtimeMs) ? item.mtimeMs : null
      })
    }
  }
  return out
}

/** 策略值收口：未知值回退 full（保持既有调用方语义） */
function normalizeMode(mode) {
  return VALID_MODES.has(mode) ? mode : DEFAULT_MODE
}

/** 从体积反查索引中移除某 id（更新体积前调用） */
function removeFromSizeIndex(id) {
  const info = knownInfo.get(id)
  if (!info || !Number.isFinite(info.size)) return
  const set = sizeIndex.get(info.size)
  if (!set) return
  set.delete(id)
  if (set.size === 0) sizeIndex.delete(info.size)
}

/**
 * 记录/更新模型的体积与 mtime（体积未知时保留旧值，避免降级为无信息）。
 * @param {string} id 模型绝对路径
 * @param {number|null} size 文件字节数
 * @param {number|null} mtimeMs 文件修改时间
 */
function rememberInfo(id, size, mtimeMs) {
  const prev = knownInfo.get(id)
  if (prev) removeFromSizeIndex(id)
  const next = {
    size: Number.isFinite(size)
      ? size
      : prev && Number.isFinite(prev.size)
        ? prev.size
        : null,
    mtimeMs: Number.isFinite(mtimeMs)
      ? mtimeMs
      : prev && Number.isFinite(prev.mtimeMs)
        ? prev.mtimeMs
        : null
  }
  knownInfo.set(id, next)
  if (Number.isFinite(next.size)) {
    let set = sizeIndex.get(next.size)
    if (!set) {
      set = new Set()
      sizeIndex.set(next.size, set)
    }
    set.add(id)
  }
}

/** 缓存是否确定有效（哈希存在且 mtime 与已知值一致；mtime 未知时保守返回 false） */
function hasValidCachedHash(id) {
  const info = knownInfo.get(id)
  const meta = getModelMeta(id)
  return Boolean(
    meta?.hash &&
      info &&
      Number.isFinite(info.mtimeMs) &&
      meta.hashMtime === info.mtimeMs
  )
}

/**
 * 丢弃队列中尚未开始的普通后台任务（保留详情页/识别的 force 任务）。
 * 全量快照请求代表「当前库 + 当前策略」的最新事实：旧排队项可能来自
 * 已删除模型或旧策略（如用户切换到关闭/仅候选），必须作废后重新规划；
 * 已在计算的单个文件不中断（与扫描暂停语义一致）。
 */
function dropQueuedBackground() {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i].force) continue
    queued.delete(queue[i].id)
    queue.splice(i, 1)
  }
}

/** 入队（force=true 时插队，供详情页/识别按需任务使用） */
function pushQueue(id, force, mode) {
  if (queued.has(id) || inflight.has(id)) return false
  queued.add(id)
  if (force) queue.unshift({ id, force: true, mode: 'full' })
  else queue.push({ id, force: false, mode })
  return true
}

/**
 * 某体积分组出现 ≥2 个文件时，把组内尚未计算/缓存无效的模型一并入队。
 * 候选预筛的关键闭环：先前因体积唯一而跳过的模型，在后续扫描/局部扫描
 * 发现同尺寸文件时必须被补算，否则重复检测会漏掉「先出现的那一份」。
 * @param {number} size 文件字节数
 * @param {string|undefined} excludeId 当前正在处理的 id（避免重复入队自身）
 * @returns {boolean} 是否有新任务入队
 */
function enqueueCollisionPeers(size, excludeId = undefined) {
  const ids = sizeIndex.get(size)
  if (!ids || ids.size < 2) return false
  let added = false
  for (const id of ids) {
    if (id === excludeId) continue
    if (queued.has(id) || inflight.has(id)) continue
    if (hasValidCachedHash(id)) continue
    if (pushQueue(id, false, 'candidates')) added = true
  }
  return added
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
 *   full?: boolean}} [opts]
 *   priority: 插队到队首并立即启动（详情页打开当前模型），不受策略限制；
 *   mode: 预热策略（缺省 full，保持服务层既有语义）；
 *   full: 本次请求是否代表完整库快照（全量扫描/启动加载 → 重置体积索引）；
 *   delayMs: 普通入队的延迟启动间隔（默认 3s）
 */
export function requestHashWarmup(items, opts = {}) {
  const priority = opts.priority === true
  const mode = priority ? 'full' : normalizeMode(opts.mode)
  const list = normalizeRequestItems(items)
  // 全量快照：作废旧策略/旧库的排队项，并整体替换体积索引，
  // 清除已删除/已移出模型的陈旧记录（在途计算与 force 任务保留）
  if (opts.full === true) {
    dropQueuedBackground()
    knownInfo.clear()
    sizeIndex.clear()
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
      // 不引入陈旧哈希风险
      if (!hasValidCachedHash(item.id) && pushQueue(item.id, false, 'full')) added = true
      continue
    }
    // candidates：体积已知则先记录分组，待全部条目登记后统一判定；
    // 体积未知则入队，由 drain 在 stat 后按真实体积决定
    const info = knownInfo.get(item.id)
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
      emitProgress({ active: false, id: '', percent: 0, hashedBytes: 0, totalBytes: 0 }, true)
    }
    return
  }
  // 队列计数变化立即广播（渲染层可显示排队数）
  emitProgress({ active: false, id: '', percent: 0, hashedBytes: 0, totalBytes: 0 }, true)
  scheduleDrain(priority ? 0 : opts.delayMs ?? WARMUP_DELAY_MS)
}

/** 扫描开始：暂停 drain 取队（正在计算的单个文件不中断，处理完当前即停） */
export function pauseHashWarmup() {
  paused = true
}

/**
 * 扫描结束：恢复取队；队列非空且无既定计划时重新调度。
 * @param {number} [delayMs] 恢复调度的延迟间隔（生产默认 3s，测试可传 0）
 */
export function resumeHashWarmup(delayMs = WARMUP_DELAY_MS) {
  paused = false
  if (queue.length > 0 && !drainTimer && !draining) scheduleDrain(delayMs)
}

/** 调度一次 drain（全局唯一；重复调度时保留更早的计划，优先任务可提前） */
function scheduleDrain(delayMs) {
  const runAt = Date.now() + delayMs
  if (drainTimer && runAt >= drainScheduledAt) return
  if (drainTimer) clearTimeout(drainTimer)
  drainScheduledAt = runAt
  drainTimer = setTimeout(() => {
    drainTimer = null
    drain()
  }, delayMs)
}

/** 串行消费队列：逐个 stat 复查 → 候选策略判定 → 跳过有效缓存 → 计算并回写 */
async function drain() {
  if (draining) return
  draining = true
  try {
    while (queue.length > 0 && !paused) {
      const task = queue.shift()
      const id = task.id
      queued.delete(id)
      // 出队即计消费（缓存命中/文件缺失/候选跳过的条目同样计入，保持计数连贯）；
      // consumedIds 防止「候选碰撞后补入队」把同一模型重复计数
      if (!consumedIds.has(id)) {
        consumedIds.add(id)
        doneCount += 1
      }
      if (inflight.has(id)) continue
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
          const group = sizeIndex.get(stat.size)
          if (!group || group.size < 2) continue // 体积唯一：不可能有重复副本
          // 本次 stat 可能首次建立同尺寸分组：把组内其他尚未计算的模型补入队
          enqueueCollisionPeers(stat.size, id)
        }
      }
      const meta = getModelMeta(id)
      if (meta?.hash && meta.hashMtime === stat.mtimeMs) continue // 缓存有效，免计算
      try {
        // 详情页/识别 priority 任务走线程池前台通道；后台批量保持普通优先级
        await computeAndCacheHash(id, stat.mtimeMs, { priority: task.force })
        logger.info(`后台哈希预热完成: ${id}`)
      } catch (err) {
        if (err?.name === 'PreemptedError') {
          // 前台任务让路：后台任务被线程池在块边界中止，重新入队等待前台完成，
          // 不视为失败，避免用户打开详情后批量预热静默丢模型。
          logger.info(`后台哈希任务让路，已重新入队: ${id}`)
          // 该任务出队时已计入 done/consumed；让路后重新排队，回退计数，
          // 待重算完成时再次计入，避免进度出现“done + remaining > 总数”。
          if (consumedIds.delete(id)) doneCount = Math.max(0, doneCount - 1)
          if (!queued.has(id)) {
            queued.add(id)
            queue.push({ id, force: false, mode: task.mode })
          }
          continue
        }
        logger.warn(`后台哈希预热失败: ${id} ${err.message}`)
      }
    }
    if (queue.length === 0 && doneCount > 0) {
      // 本轮批量清空：先广播最终计数，再归零供下一轮从 0 计数
      emitProgress({ active: false, id: '', percent: 0, hashedBytes: 0, totalBytes: 0 }, true)
      doneCount = 0
      consumedIds.clear()
    }
  } finally {
    draining = false
  }
}

/* ---------------- 仅供单元测试使用 ---------------- */

/** 等待队列清空且所有计算完成（测试辅助，轮询直至空闲） */
export async function whenWarmupIdle() {
  while (queue.length > 0 || draining || inflight.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** 清空全部内部状态（测试隔离用；生产代码严禁调用） */
export function resetHashWarmupForTests() {
  queue.length = 0
  queued.clear()
  inflight.clear()
  knownInfo.clear()
  sizeIndex.clear()
  consumedIds.clear()
  paused = false
  draining = false
  doneCount = 0
  lastEmitAt = 0
  if (drainTimer) {
    clearTimeout(drainTimer)
    drainTimer = null
    drainScheduledAt = 0
  }
}
