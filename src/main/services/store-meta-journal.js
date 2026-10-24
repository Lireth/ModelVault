import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
import { getJournalDir } from './store-paths'
import { isUnsafeModelKey, normalizeModelMeta } from './store-meta-normalize'
import { metaState } from './store-meta-state'

/**
 * 增量日志（O5，自 store-meta.js 拆出）：
 * 背景防抖保存只写「变化键」的增量批次（.modelvault/journal/delta-*.json），
 * 达到阈值/退出/备份/切库时由写盘链（store-meta-persist.js）合并为紧凑快照。
 * 本模块负责日志的回放与目录清理：
 * - 每个批次由 atomicWriteFile 原子写入（独立文件），避免 append 半行；
 * - 批次携带单调递增 seq，快照记录已合并代际，加载时跳过旧批次；
 * - 损坏批次隔离（删除）后继续回放后续批次——一个坏文件不让之后
 *   所有增量永久无法加载。
 */

/** 删除增量日志目录（快照成功后/快照损坏重置时；best-effort） */
export async function removeJournalDir() {
  try {
    await fs.rm(getJournalDir(), { recursive: true, force: true })
  } catch (err) {
    logger.warn(`增量日志目录清理失败: ${err.message}`)
  }
}

/**
 * 回放增量日志（O5）：snapshotSeq 之前的批次已并入 store.json，跳过；
 * 之后批次按 seq 升序应用 set/del。日志文件由 atomicWriteFile 原子写入，
 * 损坏文件之后的批次不再应用（缺失前序 delta 时继续应用会造成状态错乱）。
 * @param {number} snapshotSeq 快照已合并到的日志代际
 */
export async function loadJournal(snapshotSeq) {
  let files
  try {
    files = await fs.readdir(getJournalDir())
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`增量日志读取失败: ${err.message}`)
    return
  }
  const batches = files
    .filter((name) => /^delta-\d+\.json$/.test(name))
    .sort()
  for (const name of batches) {
    const file = path.join(getJournalDir(), name)
    let parsed
    try {
      parsed = JSON.parse(await fs.readFile(file, 'utf-8'))
    } catch (err) {
      // 原子写保证正常情况下不会出现；损坏批次隔离后继续回放后续批次，
      // 避免一个坏文件让之后所有增量永久无法加载
      logger.warn(`增量日志批次损坏，已隔离（${name}）: ${err.message}`)
      try {
        await fs.rm(file, { force: true })
      } catch {
        /* 隔离失败可忽略，下轮加载会再次尝试 */
      }
      continue
    }
    if (!parsed || !Number.isFinite(parsed.seq) || !Array.isArray(parsed.entries)) {
      logger.warn(`增量日志批次格式异常，已隔离（${name}）`)
      try {
        await fs.rm(file, { force: true })
      } catch {
        /* 隔离失败可忽略 */
      }
      continue
    }
    if (parsed.seq <= snapshotSeq) continue // 快照已包含
    for (const entry of parsed.entries) {
      if (!entry || typeof entry.key !== 'string' || isUnsafeModelKey(entry.key)) continue
      if (entry.op === 'set') {
        const normalized = normalizeModelMeta(entry.meta)
        if (normalized) metaState.data.models[entry.key] = normalized
      } else if (entry.op === 'del') {
        delete metaState.data.models[entry.key]
      }
    }
    metaState.journalSeq = Math.max(metaState.journalSeq, parsed.seq)
    metaState.journalEntryCount += parsed.entries.length
  }
}
