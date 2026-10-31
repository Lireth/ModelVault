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

/**
 * seq 合法上界（B-04 不可信输入收口）：正常会话每个防抖保存批次 +1，
 * 10 亿代际在任何库规模下都不可达。磁盘文件可能被外部编辑/损坏出超大
 * 但有限的 seq——若照单全收，加载基线被抬高后，之后所有正常增量都会被
 * 「快照已包含」跳过并随快照固化，增量静默丢失。越界一律按损坏批次隔离。
 */
const MAX_JOURNAL_SEQ = 1_000_000_000

/** 增量批次文件名（delta-<seq>.json，写盘侧 12 位零填充，读取兼容任意位数） */
const DELTA_BATCH_NAME_RE = /^delta-(\d+)\.json$/

/**
 * 文件名是否为增量日志批次（单一来源：回放过滤与跨库迁移的残留检测共用，
 * 文件名格式变更只需改这里）。
 * @param {string} name 目录条目名
 * @returns {boolean}
 */
export function isDeltaBatchName(name) {
  return DELTA_BATCH_NAME_RE.test(name)
}

/**
 * 规范化快照携带的日志代际（store.json 的 journalSeq 字段，不可信输入）：
 * 非整数 / 负数 / 超出 MAX_JOURNAL_SEQ 一律回退 0。回退后加载链路会从
 * 头回放全部增量批次（set/del 按序重放收敛到同一终态），代际自愈为实际
 * 最大批次 seq，无需人工干预。
 * @param {unknown} value store.json 中的 journalSeq 原始值
 * @returns {number} 合法代际（越界/非法为 0）
 */
export function normalizeSnapshotSeq(value) {
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_JOURNAL_SEQ
  ) {
    return value
  }
  logger.warn(
    `快照日志代际异常（${String(value)}），按 0 回退并从头回放增量自愈`,
  )
  return 0
}

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
 * 损坏批次隔离（删除）后继续回放后续批次——一个坏文件不让之后所有增量
 * 永久无法加载；被隔离批次的变更随之丢失（幽灵键由健康检查治理）。
 * 批次内容 seq 必须与文件名 seq 一致且在合法区间内（B-04：不一致/越界按
 * 损坏批次隔离——内容与代际错位的批次无法安全判定新旧）。
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
  // 按文件名 seq 数值升序回放（写盘侧零填充，字符串序与数值序一致；
  // 对未填充/被外部改名的文件数值序仍正确）
  const batches = []
  for (const name of files) {
    const seqMatch = DELTA_BATCH_NAME_RE.exec(name)
    if (seqMatch) batches.push({ name, seq: Number(seqMatch[1]) })
  }
  batches.sort((a, b) => a.seq - b.seq)
  for (const { name, seq: fileSeq } of batches) {
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
    if (
      !parsed ||
      !Number.isInteger(parsed.seq) ||
      !Array.isArray(parsed.entries) ||
      // 内容 seq 与文件名 seq 必须一致且在合法区间（防代际漂移）
      parsed.seq !== fileSeq ||
      parsed.seq < 1 ||
      parsed.seq > MAX_JOURNAL_SEQ
    ) {
      logger.warn(
        `增量日志批次格式异常（seq 越界或与文件名不一致），已隔离（${name}）`,
      )
      try {
        await fs.rm(file, { force: true })
      } catch {
        /* 隔离失败可忽略 */
      }
      continue
    }
    if (parsed.seq <= snapshotSeq) continue // 快照已包含
    for (const entry of parsed.entries) {
      if (
        !entry ||
        typeof entry.key !== 'string' ||
        isUnsafeModelKey(entry.key)
      )
        continue
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
