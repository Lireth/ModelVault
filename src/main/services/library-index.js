import fs from 'node:fs/promises'
import logger from '../logger'
import { atomicWriteFile } from './atomic-write'
import { getIndexFilePath } from './store-paths'

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
