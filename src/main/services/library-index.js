import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
import { samePathIgnoreCase } from '../utils'
import { atomicWriteFile } from './atomic-write'
import { serializeJsonOffThread } from './json-serializer'
import { getIndexFilePath } from './store-paths'
import { isRelDirInScope } from '../../shared/scan-dirs'

/**
 * 每库本地扫描索引（F1）：
 *
 * `.modelvault/index.json` 保存上一次全量扫描的装饰结果，用于：
 * - 切换模型库时秒开列表（无需等待整库扫描）；
 * - 启动时先展示上次索引，再后台校验；
 * - 磁盘/网络慢时避免每次切库都卡在全屏扫描。
 *
 * 索引只是展示缓存，绝不是删除/去重/修复的事实来源：
 * - 每次读取都会校验 root/version/记录结构，失效即返回 null；
 * - 任何写失败都只记日志，不影响扫描主流程；
 * - 不纳入备份（可再生产物），恢复/换机后由扫描重建。
 *
 * OPT-03 大库写盘降载：
 * - 内容未变化时按 SHA256 指纹跳过重复写盘（扫描耗时/时间戳不参与指纹）；
 * - 大库模型数组交给 JSON 序列化 worker，避免主进程长时间 JSON.stringify；
 * - 局部扫描索引更新先合并入队，短窗口内多次变更只读改写一次索引。
 */

export const INDEX_VERSION = 1
/** 索引文件大小上限（防损坏/恶意文件一次性占满主进程内存） */
const MAX_INDEX_BYTES = 64 * 1024 * 1024
/** 模型条数上限（超出拒绝写入，避免异常数据无限膨胀） */
const MAX_INDEX_MODELS = 200000
/** 超过该模型数时把 JSON.stringify 移入 worker（大库主线程降载） */
const INDEX_WORKER_THRESHOLD = 2000
/** 局部索引更新合并窗口（ms）：窗口内多次局部扫描只读改写一次 */
const INDEX_UPDATE_DEBOUNCE_MS = 800
/** 合并最长等待（ms）：持续变更时也保证索引在有限时间内追上 */
const INDEX_UPDATE_MAX_WAIT_MS = 3000

/** 每库最近一次成功写入的内容指纹与文件大小（键为根目录小写） */
const lastWrittenHash = new Map()
const lastWrittenSize = new Map()
/** 每库待合并的局部索引更新 */
const pendingIndexUpdates = new Map()
/** 合并窗口（测试可注入小值） */
let indexUpdateDebounceMs = INDEX_UPDATE_DEBOUNCE_MS
/** worker 阈值（测试可注入 0 强制走 worker） */
let indexWorkerThreshold = INDEX_WORKER_THRESHOLD

/** 索引读改写串行链（O8）：全量覆盖与增量合并不得交错丢失更新 */
let indexChain = Promise.resolve()

/**
 * 将索引写任务排入全局串行链（失败不阻断后续任务）。
 * @template T
 * @param {() => Promise<T>} task 索引读改写任务
 * @returns {Promise<T>} 任务结果
 */
function serializeIndexTask(task) {
  const run = indexChain.then(task, task)
  indexChain = run.then(
    () => {},
    () => {},
  )
  return run
}

/**
 * 立即触发所有待合并的局部索引更新（退出/切库收尾用）。
 * 调用 updateLibraryIndex 会在同步阶段排入串行链，随后由 flush 等待链尾。
 * @returns {void}
 */
function flushQueuedIndexUpdates() {
  for (const [key, entry] of [...pendingIndexUpdates]) {
    pendingIndexUpdates.delete(key)
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    void updateLibraryIndex(entry.root, payloadFromEntry(entry))
  }
}

/**
 * 等待索引写链上已排队的全部任务（含合并窗口内尚未触发的更新）落定。
 * 链尾 promise 永不拒绝：单个任务的失败已被各写入口捕获并记日志。
 * @returns {Promise<void>}
 */
export function flushIndexWrites() {
  flushQueuedIndexUpdates()
  return indexChain
}

/** 从模型 id 推导库内相对目录（POSIX；旧索引缺 relDir 时兜底） */
function relDirFromId(root, id) {
  const rel = path.relative(root, id)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return ''
  const dir = path.dirname(rel)
  return dir === '.' ? '' : dir.split(path.sep).join('/')
}

/** 记录结构的最低可信校验（保留装饰层额外字段） */
function isUsableModel(record) {
  return (
    record &&
    typeof record === 'object' &&
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    typeof record.name === 'string' &&
    typeof record.type === 'string'
  )
}

/**
 * 读取某模型库的本地索引。
 * @param {string} root 模型库根目录
 * @returns {Promise<{models: object[], savedAt: number, durationMs: number}|null>}
 *   缺失/损坏/版本或根目录不匹配时返回 null（调用方回退全量扫描）
 */
export async function readLibraryIndex(root) {
  if (!root || typeof root !== 'string') return null
  const file = getIndexFilePath(root)
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > MAX_INDEX_BYTES) {
      logger.warn(`本地索引过大或不是文件，已忽略: ${file}`)
      return null
    }
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8'))
    if (
      !parsed ||
      parsed.version !== INDEX_VERSION ||
      !samePathIgnoreCase(parsed.root, root)
    ) {
      logger.info(`本地索引版本/根目录不匹配，已忽略: ${file}`)
      return null
    }
    if (!Array.isArray(parsed.models)) return null
    const models = parsed.models
      .filter(isUsableModel)
      .slice(0, MAX_INDEX_MODELS)
    return {
      models,
      savedAt: Number.isFinite(parsed.savedAt) ? parsed.savedAt : 0,
      durationMs: Number.isFinite(parsed.durationMs) ? parsed.durationMs : 0,
    }
  } catch (err) {
    if (err.code !== 'ENOENT')
      logger.warn(`本地索引读取失败（忽略）: ${err.message}`)
    return null
  }
}

/**
 * 写入某模型库的本地索引（全量扫描完成后调用）。
 * @param {string} root 模型库根目录
 * @param {{models: object[], durationMs?: number}} payload 装饰后的模型列表与扫描耗时
 * @returns {Promise<boolean>} 是否写入成功（失败不影响扫描结果）
 */
export async function writeLibraryIndex(root, payload) {
  const models = payload?.models
  if (!root || typeof root !== 'string' || !Array.isArray(models)) return false
  if (models.length > MAX_INDEX_MODELS) {
    logger.warn(`本地索引模型数超限（${models.length}），跳过写入`)
    return false
  }
  // 全量扫描结果是完整快照，优先于此前排队的局部更新；清掉同根待合并项，
  // 避免旧局部 affectedDirs 在完整索引写入后又删除新记录
  clearQueuedIndexUpdates(root)
  const durationMs = Number.isFinite(payload.durationMs)
    ? payload.durationMs
    : 0
  return serializeIndexTask(() => writeIndexBody(root, models, durationMs))
}

/**
 * 清理某根目录待合并的局部索引更新（全量扫描覆盖时调用）。
 * @param {string} root 模型库根目录
 */
function clearQueuedIndexUpdates(root) {
  if (!root) return
  const key = String(root).toLowerCase()
  const entry = pendingIndexUpdates.get(key)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  pendingIndexUpdates.delete(key)
}

/**
 * 序列化模型数组并计算内容指纹（OPT-03）：
 * - 大库交给 JSON worker，避免主线程长时间 stringify；
 * - 指纹只覆盖 version/root/模型数组，不含 savedAt/durationMs，使“内容未变”
 *   能稳定跳过写盘。
 * @param {string} root 模型库根目录
 * @param {object[]} models 装饰后的模型数组
 * @returns {Promise<{text: string, bytes: number, hash: string}>}
 */
async function serializeIndexModels(root, models) {
  const hashPrefix = `${INDEX_VERSION}\u0000${String(root).toLowerCase()}\u0000`
  if (models.length >= indexWorkerThreshold) {
    return serializeJsonOffThread(models, { hash: true, hashPrefix })
  }
  const text = JSON.stringify(models)
  return {
    text,
    bytes: Buffer.byteLength(text, 'utf-8'),
    hash: createHash('sha256').update(hashPrefix).update(text).digest('hex'),
  }
}

/**
 * 索引体统一写入（大小上限 + 内容指纹去重 + 原子写；失败只记日志）。
 * 文件格式保持 {version, root, savedAt, durationMs, models}；为复用模型数组
 * 序列化结果，前后缀在外部拼接，避免二次 stringify。
 * @param {string} root 模型库根目录
 * @param {object[]} models 模型数组
 * @param {number} durationMs 扫描耗时
 * @returns {Promise<boolean>} 是否写入/确认已是最新
 */
async function writeIndexBody(root, models, durationMs) {
  try {
    const serialized = await serializeIndexModels(root, models)
    if (serialized.bytes > MAX_INDEX_BYTES - 512) {
      logger.warn('本地索引超过大小上限，跳过写入（不影响扫描）')
      return false
    }
    const key = String(root).toLowerCase()
    if (lastWrittenHash.get(key) === serialized.hash) {
      // 指纹一致：内容已是最新；仅当索引文件仍存在且大小未变时跳过，
      // 文件被外部删除/截断则重写（同尺寸内容篡改仍由读取侧校验兜底）
      try {
        const stat = await fs.stat(getIndexFilePath(root))
        if (stat.isFile() && stat.size === lastWrittenSize.get(key)) return true
      } catch {
        /* 文件不存在：继续写 */
      }
    }
    const savedAt = Date.now()
    const prefix =
      `{"version":${INDEX_VERSION},"root":${JSON.stringify(root)},` +
      `"savedAt":${savedAt},"durationMs":${durationMs},"models":`
    const bytes = Buffer.byteLength(prefix, 'utf-8') + serialized.bytes + 1
    if (bytes > MAX_INDEX_BYTES) {
      logger.warn('本地索引超过大小上限，跳过写入（不影响扫描）')
      return false
    }
    const text = `${prefix}${serialized.text}}`
    await atomicWriteFile(getIndexFilePath(root), text)
    lastWrittenHash.set(key, serialized.hash)
    lastWrittenSize.set(key, bytes)
    return true
  } catch (err) {
    logger.warn(`本地索引写入失败（不影响扫描）: ${err.message}`)
    return false
  }
}

/**
 * 局部索引写入合并入队（OPT-03）：短窗口内多个局部扫描/变更只读改写一次
 * index.json，降低大库频繁局部扫描的整索引读放大与写放大。
 * 语义与 updateLibraryIndex 一致（最后一次 upsert 覆盖同 id，remove 优先）。
 * @param {string} root 模型库根目录
 * @param {{upsertModels?: object[], removeIds?: string[],
 *   affectedDirs?: string[]|null}} payload 局部变更
 * @returns {boolean} 是否成功入队
 */
export function queueLibraryIndexUpdate(root, payload = {}) {
  if (!root || typeof root !== 'string') return false
  const key = String(root).toLowerCase()
  let entry = pendingIndexUpdates.get(key)
  if (!entry) {
    entry = {
      root,
      upserts: new Map(),
      removeIds: new Set(),
      affectedDirs: null,
      timer: null,
      firstQueuedAt: Date.now(),
    }
    pendingIndexUpdates.set(key, entry)
  }
  const removeSet = new Set(
    (Array.isArray(payload.removeIds) ? payload.removeIds : [])
      .map((id) => String(id).toLowerCase())
      .filter(Boolean),
  )
  for (const model of Array.isArray(payload.upsertModels)
    ? payload.upsertModels
    : []) {
    if (!isUsableModel(model)) continue
    const idLower = String(/** @type {{id: string}} */ (model).id).toLowerCase()
    entry.upserts.set(idLower, model)
    entry.removeIds.delete(idLower)
  }
  for (const idLower of removeSet) {
    entry.removeIds.add(idLower)
    entry.upserts.delete(idLower)
  }
  if (Array.isArray(payload.affectedDirs)) {
    entry.affectedDirs = entry.affectedDirs || new Set()
    for (const dir of payload.affectedDirs) {
      if (typeof dir === 'string') entry.affectedDirs.add(dir)
    }
  }
  if (entry.timer) clearTimeout(entry.timer)
  const elapsed = Date.now() - entry.firstQueuedAt
  const delay = Math.max(
    0,
    Math.min(indexUpdateDebounceMs, INDEX_UPDATE_MAX_WAIT_MS - elapsed),
  )
  entry.timer = setTimeout(() => {
    entry.timer = null
    pendingIndexUpdates.delete(key)
    void updateLibraryIndex(root, payloadFromEntry(entry))
  }, delay)
  entry.timer.unref?.()
  return true
}

/** 将合并队列条目转换为 updateLibraryIndex 载荷 */
function payloadFromEntry(entry) {
  return {
    upsertModels: [...entry.upserts.values()],
    removeIds: [...entry.removeIds],
    affectedDirs: entry.affectedDirs ? [...entry.affectedDirs] : null,
  }
}

/** 强制 worker 序列化路径（仅供单元测试使用；0 表示所有写入走 worker） */
export function setIndexWorkerThresholdForTests(count) {
  indexWorkerThreshold =
    Number.isFinite(count) && count >= 0 ? count : INDEX_WORKER_THRESHOLD
}

/** 清理索引写入缓存/合并队列（仅供单元测试隔离使用） */
export function resetIndexWriteStateForTests() {
  lastWrittenHash.clear()
  lastWrittenSize.clear()
  for (const entry of pendingIndexUpdates.values()) {
    if (entry.timer) clearTimeout(entry.timer)
  }
  pendingIndexUpdates.clear()
  indexWorkerThreshold = INDEX_WORKER_THRESHOLD
  indexUpdateDebounceMs = INDEX_UPDATE_DEBOUNCE_MS
}

/** 当前待合并的根目录数量（仅供单元测试使用） */
export function getQueuedIndexUpdateCountForTests() {
  return pendingIndexUpdates.size
}

/**
 * 增量维护本地索引（O8）：局部扫描/删除后把变化即时并入 index.json，
 * 避免切库秒开时回放已删除模型或缺少新增模型。
 * 仅基于已存在的有效索引做读改写——索引缺失/损坏时不凭空创建
 * （局部数据不足以构成完整库快照，交由下一次全量扫描重建）。
 * @param {string} root 模型库根目录
 * @param {{upsertModels?: object[], removeIds?: string[],
 *   affectedDirs?: string[]|null}} payload
 *   upsertModels 新增/更新的装饰模型；removeIds 需移除的模型绝对路径；
 *   affectedDirs 本次扫描覆盖的相对子树（这些目录内未出现在 upsertModels
 *   的旧记录会被移除，语义与渲染层局部合并一致）
 * @returns {Promise<boolean>} 是否完成写入（索引缺失/失败返回 false）
 */
export async function updateLibraryIndex(root, payload = {}) {
  if (!root || typeof root !== 'string') return false
  return serializeIndexTask(async () => {
    try {
      const existing = await readLibraryIndex(root)
      if (!existing) return false
      const removeSet = new Set(
        (Array.isArray(payload.removeIds) ? payload.removeIds : [])
          .map((id) => String(id).toLowerCase())
          .filter(Boolean),
      )
      const upserts = /** @type {any[]} */ (
        (Array.isArray(payload.upsertModels)
          ? payload.upsertModels
          : []
        ).filter(isUsableModel)
      )
      const upsertIds = new Set(upserts.map((m) => String(m.id).toLowerCase()))
      const affectedDirs = Array.isArray(payload.affectedDirs)
        ? payload.affectedDirs
        : null
      const existingModels = /** @type {any[]} */ (existing.models)
      const kept = existingModels.filter((m) => {
        const idLower = String(m.id).toLowerCase()
        if (removeSet.has(idLower) || upsertIds.has(idLower)) return false
        if (!affectedDirs) return true
        const relDir =
          typeof m.relDir === 'string' ? m.relDir : relDirFromId(root, m.id)
        return !isRelDirInScope(relDir, affectedDirs)
      })
      const models = kept.concat(upserts)
      if (models.length > MAX_INDEX_MODELS) {
        logger.warn(`本地索引增量更新超限（${models.length}），跳过写入`)
        return false
      }
      return await writeIndexBody(root, models, existing.durationMs)
    } catch (err) {
      logger.warn(`本地索引增量更新失败（忽略）: ${err.message}`)
      return false
    }
  })
}
