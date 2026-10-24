import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
import { atomicWriteFile } from './atomic-write'
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
 */

export const INDEX_VERSION = 1
/** 索引文件大小上限（防损坏/恶意文件一次性占满主进程内存） */
const MAX_INDEX_BYTES = 64 * 1024 * 1024
/** 模型条数上限（超出拒绝写入，避免异常数据无限膨胀） */
const MAX_INDEX_MODELS = 200000

/** 根目录比较：Windows 大小写不敏感 */
function sameRoot(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase()
}

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
    () => {}
  )
  return run
}

/**
 * 等待索引写链上已排队的全部任务落定（退出路径收尾用）。
 * 链尾 promise 永不拒绝：单个任务的失败已被各写入口捕获并记日志。
 * @returns {Promise<void>}
 */
export function flushIndexWrites() {
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
    if (!parsed || parsed.version !== INDEX_VERSION || !sameRoot(parsed.root, root)) {
      logger.info(`本地索引版本/根目录不匹配，已忽略: ${file}`)
      return null
    }
    if (!Array.isArray(parsed.models)) return null
    const models = parsed.models.filter(isUsableModel).slice(0, MAX_INDEX_MODELS)
    return {
      models,
      savedAt: Number.isFinite(parsed.savedAt) ? parsed.savedAt : 0,
      durationMs: Number.isFinite(parsed.durationMs) ? parsed.durationMs : 0
    }
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`本地索引读取失败（忽略）: ${err.message}`)
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
  const body = {
    version: INDEX_VERSION,
    root,
    savedAt: Date.now(),
    durationMs: Number.isFinite(payload.durationMs) ? payload.durationMs : 0,
    models
  }
  return serializeIndexTask(() => writeIndexBody(root, body))
}

/** 索引体统一写入（大小上限 + 原子写；失败只记日志） */
async function writeIndexBody(root, body) {
  try {
    const text = JSON.stringify(body)
    if (Buffer.byteLength(text, 'utf-8') > MAX_INDEX_BYTES) {
      logger.warn('本地索引超过大小上限，跳过写入（不影响扫描）')
      return false
    }
    await atomicWriteFile(getIndexFilePath(root), text)
    return true
  } catch (err) {
    logger.warn(`本地索引写入失败（不影响扫描）: ${err.message}`)
    return false
  }
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
          .filter(Boolean)
      )
      const upserts = /** @type {any[]} */ (
        (Array.isArray(payload.upsertModels) ? payload.upsertModels : []).filter(isUsableModel)
      )
      const upsertIds = new Set(upserts.map((m) => String(m.id).toLowerCase()))
      const affectedDirs = Array.isArray(payload.affectedDirs) ? payload.affectedDirs : null
      const existingModels = /** @type {any[]} */ (existing.models)
      const kept = existingModels.filter((m) => {
        const idLower = String(m.id).toLowerCase()
        if (removeSet.has(idLower) || upsertIds.has(idLower)) return false
        if (!affectedDirs) return true
        const relDir = typeof m.relDir === 'string' ? m.relDir : relDirFromId(root, m.id)
        return !isRelDirInScope(relDir, affectedDirs)
      })
      const models = kept.concat(upserts)
      if (models.length > MAX_INDEX_MODELS) {
        logger.warn(`本地索引增量更新超限（${models.length}），跳过写入`)
        return false
      }
      return await writeIndexBody(root, {
        version: INDEX_VERSION,
        root,
        savedAt: Date.now(),
        durationMs: existing.durationMs,
        models
      })
    } catch (err) {
      logger.warn(`本地索引增量更新失败（忽略）: ${err.message}`)
      return false
    }
  })
}
