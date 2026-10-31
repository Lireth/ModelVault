import { app } from 'electron'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
import { isEmptyModelMeta, planMetaRelinks, splitRelKey } from './meta-relink'
import { isRelKeyInScope } from '../../shared/scan-dirs'
import {
  isUnsafeModelKey,
  normalizeModelMeta,
  normalizeStoreData,
} from './store-meta-normalize'
import {
  loadJournal,
  normalizeSnapshotSeq,
  removeJournalDir,
} from './store-meta-journal'
import { parseJsonOffThread } from './json-serializer'
import { preserveCorruptedFile } from '../utils'
import {
  clearOfflineRetry,
  flushStoreSave,
  saveStoreNow,
  scheduleSave,
} from './store-meta-persist'
import { markDirty, metaState } from './store-meta-state'
import {
  COVERS_DIR,
  DATA_DIR,
  LEGACY_STORE_FILE,
  getCoversDir,
  getCurrentRoot,
  getDataDir,
  getDataFilePath,
  setDataRoot,
  toRelKey,
} from './store-paths'

/**
 * 关联存储（C2 自 store.js 拆出；O1 二次拆分为五个模块）：
 * 模型的所有用户数据（封面、推荐参数、备注、收藏/评分/NSFW、哈希缓存等）
 * 按相对路径关联，统一存于模型根目录 .modelvault/store.json。
 * 写入采用防抖 + 原子替换；O5 起背景保存只写变化键增量日志
 * （.modelvault/journal/），达到阈值/退出/备份/切库时合并为紧凑快照；
 * store.json 损坏时备份后重置；首次对某根目录启用时自动从旧版全局存储迁移。
 *
 * 模块布局（本文件 = 核心数据操作 + 对外门面，含持久化函数的再导出）：
 * - store-meta-normalize.js  不可信输入规范化（原型污染防御/字段校验/封面自愈）
 * - store-meta-state.js      进程内共享可变状态（内存表/写盘链/离线重试标志）
 * - store-meta-journal.js    增量日志回放与目录清理
 * - store-meta-persist.js    防抖/增量日志/全量快照落盘链与离线挂起补写
 * 既有消费方的导入路径与公共 API 名称保持不变。
 */

/**
 * 加载当前根目录的关联存储数据（O5：store.json 快照 + 增量日志回放）。
 * store.json 不存在时创建空数据，并尝试从旧版全局存储迁移属于该目录的记录。
 */
export async function loadData() {
  // 根目录可用性缓存可能来自旧根/重载前的状态，加载时重置一次
  metaState.rootProbe = { root: null, at: 0 }
  metaState.dataReset = false
  metaState.dirtyKeys = new Set()
  metaState.journalSeq = 0
  metaState.journalEntryCount = 0
  metaState.hasSnapshot = false
  metaState.pendingSnapshot = false
  metaState.mutationVersion = 0
  if (!getCurrentRoot()) {
    metaState.data = { version: 1, models: {} }
    return metaState.data
  }
  const file = getDataFilePath()
  let snapshotSeq = 0
  try {
    const text = await fs.readFile(file, 'utf-8')
    // B1：大库 store.json 的解析移出主线程（阈值内仍在主线程，语义不变）
    const parsed = await parseJsonOffThread(text)
    // B-04：磁盘文件同样按不可信输入处理（可能由恶意备份写入或外部编辑）
    metaState.data = normalizeStoreData(parsed)
    metaState.hasSnapshot = true
    // journalSeq 属不可信输入（B-04）：越界/非整数回退 0 并从头回放增量自愈，
    // 防止外部编辑出的超大代际让后续正常增量被「快照已包含」静默跳过
    snapshotSeq = normalizeSnapshotSeq(parsed?.journalSeq)
    metaState.journalSeq = snapshotSeq
    logger.info(
      `关联存储加载完成：${Object.keys(metaState.data.models).length} 条记录（${file}）`,
    )
  } catch (err) {
    if (err.code === 'ENOENT') {
      metaState.data = { version: 1, models: {} }
      await loadJournal(0)
      await migrateLegacyData()
    } else {
      metaState.data = { version: 1, models: {} }
      metaState.dataReset = true
      // store.json 损坏（如写入中断电、磁盘错误）：先备份原文件再重置，保留手动恢复机会
      // （时间戳命名滚动保留，连续损坏不互相覆盖）。增量日志同时丢弃——在缺失快照
      // 基线时回放 delta 可能把半套数据重新拼起来
      try {
        const backup = await preserveCorruptedFile(file)
        logger.error(
          `关联存储文件损坏，原文件已备份为 ${path.basename(backup)} 后重置: ${err.message}`,
        )
      } catch (backupErr) {
        logger.error(
          `关联存储加载失败，已重置（备份失败: ${backupErr.message}）: ${err.message}`,
        )
      }
      await removeJournalDir()
    }
  }
  if (!metaState.dataReset && metaState.hasSnapshot)
    await loadJournal(snapshotSeq)
  return metaState.data
}

/** 元数据是否因损坏被重置（孤儿封面清理前应检查，避免误删） */
export function wasDataReset() {
  return metaState.dataReset
}

/**
 * 从磁盘重载当前根目录的元数据，并丢弃在途的防抖保存（备份恢复到当前根后调用）。
 * 备份恢复直接替换磁盘上的 store.json，若不重载：内存中的旧数据会在下一次
 * setModelMeta → saveStoreNow 时原子覆盖刚恢复的文件，恢复结果被静默回滚。
 * 挂起的防抖定时器必须一并丢弃——它携带的是恢复前的数据上下文，迟到的
 * 落盘同样会覆盖恢复结果。
 * @returns {Promise<object>} 重新加载后的内存数据
 */
export async function reloadCurrentRootData() {
  if (metaState.saveTimer) {
    clearTimeout(metaState.saveTimer)
    metaState.saveTimer = null
  }
  // B-02 恢复屏障：
  // 1) 丢弃挂起的补写请求，恢复窗口内不再调度新落盘；
  // 2) 等待已开始的原子写结束（其 rename 不可取消），避免读到交换中的文件；
  // 3) 之后才从磁盘重载，保证内存基线就是恢复后的内容。
  metaState.saveSuppressed = true
  metaState.pendingSave = false
  metaState.pendingSnapshot = false
  try {
    while (metaState.saving) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  } finally {
    metaState.saveSuppressed = false
  }
  return loadData()
}

/** 收集元数据中引用的所有封面相对路径（孤儿封面清理的保留名单） */
export function getReferencedCovers() {
  const refs = new Set()
  if (!metaState.data) return refs
  for (const meta of Object.values(metaState.data.models)) {
    if (meta.cover) refs.add(meta.cover)
    for (const c of meta.covers || []) refs.add(c)
  }
  return refs
}

/**
 * 从旧版全局存储（%APPDATA%/modelvault/store.json，绝对路径作键）迁移
 * 属于当前根目录的记录，并复制其封面文件到 <根目录>/.modelvault/covers/。
 */
async function migrateLegacyData() {
  const oldFile = path.join(app.getPath('userData'), LEGACY_STORE_FILE)
  try {
    const text = await fs.readFile(oldFile, 'utf-8')
    const parsed = JSON.parse(text)
    let imported = 0
    for (const [absId, meta] of Object.entries(parsed?.models || {})) {
      const relKey = toRelKey(absId)
      if (!relKey || isUnsafeModelKey(relKey)) continue
      // 旧版封面是 %APPDATA% 下的绝对路径，A7 的规范化会将其剔除，
      // 必须在规范化之前先取出原始引用，供下方迁移复制使用
      const legacyCover =
        typeof meta.cover === 'string' && meta.cover
          ? meta.cover
          : typeof meta.covers?.[0] === 'string'
            ? meta.covers[0]
            : ''
      const normalized = normalizeModelMeta(meta)
      if (!normalized) continue

      // 迁移封面文件：旧版为 %APPDATA% 下的绝对路径。
      // 目标文件名用 md5(源绝对路径小写) 命名（与缩略图命名规则一致）：
      // 不同模型的同名封面（如均为 preview.png）互不覆盖；迁移中断重跑幂等。
      if (legacyCover) {
        try {
          await fs.access(legacyCover)
          await fs.mkdir(getCoversDir(), { recursive: true })
          const destName = `${createHash('md5').update(legacyCover.toLowerCase()).digest('hex')}${path.extname(legacyCover)}`
          const newRel = `${DATA_DIR}/${COVERS_DIR}/${destName}`
          await fs.copyFile(legacyCover, path.join(getCoversDir(), destName))
          normalized.cover = newRel
          // 迁移后的封面同步进封面列表首位（规范化可能已剔除旧绝对路径条目）
          normalized.covers = [
            newRel,
            ...normalized.covers.filter((c) => c !== newRel),
          ]
        } catch {
          normalized.cover = ''
        }
      }
      metaState.data.models[relKey] = normalized
      imported += 1
    }
    if (imported > 0) {
      await saveStoreNow()
      logger.info(`已从旧版存储迁移 ${imported} 条记录到 ${getDataDir()}`)
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn(`旧版存储迁移跳过: ${err.message}`)
    }
  }
}

/** 读取单条模型元数据（键为模型绝对路径） */
export function getModelMeta(modelId) {
  if (!metaState.data) return null
  const relKey = toRelKey(modelId)
  return relKey ? metaState.data.models[relKey] || null : null
}

/** 以绝对路径返回模型元数据表（供主进程内部消费，如库体检） */
export function getMetaMapByAbsPath() {
  const result = {}
  if (!metaState.data || !getCurrentRoot()) return result
  for (const [relKey, meta] of Object.entries(metaState.data.models)) {
    result[path.join(getCurrentRoot(), relKey)] = meta
  }
  return result
}

/**
 * 当前根目录下全部模型的绝对路径（O1）：
 * 启动预热等仅需 id 列表的场景使用，避免构造并丢弃整张元数据映射表。
 * @returns {string[]} 模型绝对路径列表
 */
export function getModelIdsByAbsPath() {
  const root = getCurrentRoot()
  if (!metaState.data || !root) return []
  return Object.keys(metaState.data.models).map((relKey) =>
    path.join(root, relKey),
  )
}

/** 写入单条模型元数据（合并保存，键为模型绝对路径） */
export function setModelMeta(modelId, meta) {
  if (!metaState.data || typeof modelId !== 'string' || !modelId) return null
  const relKey = toRelKey(modelId)
  if (!relKey || isUnsafeModelKey(relKey)) {
    logger.warn(`模型不在当前根目录内，忽略保存: ${modelId}`)
    return null
  }
  const normalized = normalizeModelMeta(meta)
  if (!normalized) return null
  metaState.data.models[relKey] = normalized
  markDirty(relKey)
  scheduleSave()
  return normalized
}

/** 删除单条模型元数据（模型文件被移入回收站时调用） */
export function removeModelMeta(modelId) {
  if (!metaState.data) return false
  const relKey = toRelKey(modelId)
  if (!relKey || !metaState.data.models[relKey]) return false
  delete metaState.data.models[relKey]
  markDirty(relKey)
  scheduleSave()
  return true
}

/**
 * 模型文件改名/移动后整体迁移元数据键（F10 禁用后缀 / F11 库内移动）：
 * 键以相对路径关联，绝对路径变了键就失效——重扫时 relink 的 R1/R2
 * 能自愈大多数场景，但改名 .disabled 会使扩展名变化导致两条规则都
 * 不命中；主动迁移保证标注（含哈希履历）即时无缝跟随。
 *
 * 目标键已有残留标注时（调用方均先确认目标文件不存在，残留必为旧文件
 * 删除后遗留的幽灵标注）：跟随实际文件字节的源标注才是正确绑定，
 * 顶替幽灵并记录其摘要——绝不静默。不做字段级合并：规范化后的元数据
 * 字段集合固定，合并等价于整体覆盖，反而让幽灵侧的哈希/封面引用等
 * 身份字段有绑错文件的风险（宁可不绑也绝不绑错）。
 * @param {string} oldId 旧绝对路径
 * @param {string} newId 新绝对路径
 * @returns {boolean} 迁移成功返回 true（无旧数据/越界/不安全键返回 false）
 */
export function renameModelMeta(oldId, newId) {
  if (!metaState.data) return false
  const oldKey = toRelKey(oldId)
  const newKey = toRelKey(newId)
  if (!oldKey || !newKey || oldKey === newKey) return false
  // FIX-6：与 setModelMeta/loadJournal 同一防线（isUnsafeModelKey）——
  // newKey 写入 models 表会触发 __proto__ 原型 setter（内存污染直至重载，
  // journal/快照写侧不持久化但内存已失真）；oldKey 裸读 `models[__proto__]`
  // 会误取 Object.prototype（真值）作为 meta 顶替目标键的真实标注。
  // 概率极低（需字面名为 __proto__ 的文件路径），但写入口防线必须一致
  if (isUnsafeModelKey(oldKey) || isUnsafeModelKey(newKey)) {
    logger.warn(`元数据键迁移涉及不安全键，忽略: ${oldKey} -> ${newKey}`)
    return false
  }
  const meta = metaState.data.models[oldKey]
  if (!meta) return false
  const displaced = metaState.data.models[newKey]
  if (displaced) {
    logger.warn(
      `元数据键迁移顶替了目标键的幽灵标注（alias="${displaced.alias}" ` +
        `note="${String(displaced.note).slice(0, 50)}" ` +
        `favorite=${displaced.favorite} rating=${displaced.rating}）: ${newKey}`,
    )
  }
  metaState.data.models[newKey] = meta
  delete metaState.data.models[oldKey]
  markDirty(oldKey)
  markDirty(newKey)
  scheduleSave()
  return true
}

/**
 * 切换关联存储根目录（全域唯一入口，A6）：
 * 先把旧根待落盘数据写入旧目录并静止写盘链，再切换根目录。
 * 若先 setDataRoot 再等待防抖自然触发，迟到定时器会把旧根数据
 * 写进新根目录的 store.json，造成跨库污染。加载新根数据（loadData）
 * 由调用方在本函数返回后执行。
 */
export async function switchDataRoot(root) {
  await flushStoreSave()
  // O5：切根后旧根的可用性缓存与离线重试定时器一并作废
  clearOfflineRetry()
  metaState.rootProbe = { root: null, at: 0 }
  setDataRoot(root)
}

/**
 * 重扫后的元数据重关联（A-02）：
 * 用户在库内移动/重命名模型后，以相对路径为键的标注会失联。本函数对比
 * 「本次扫描消失的旧键（孤儿）」与「无元数据的新模型」，用 planMetaRelinks
 * 的确定性规则（同名移动 / 同目录改名 / 哈希履历 mtime，且均要求唯一候选）
 * 把元数据迁移到新键。封面引用位于 .modelvault/covers，与模型路径无关，
 * 随键迁移后继续有效；哈希缓存一并迁移，去重时无需重算。
 *
 * 无法安全关联的孤儿：不含任何用户数据的空条目自动清理（其封面在下次
 * pruneOrphanCovers 时回收）；含标注/哈希的条目保守保留——文件移回或
 * 改名还原时，下次扫描仍可重新关联。
 *
 * @param {Array<{id:string, name:string, ext:string, size:number, mtimeMs:number}>} scanned
 *   scanner 本次扫描出的模型列表
 * @param {object} [options]
 * @param {string[]} [options.affectedDirs] 本次扫描覆盖的相对目录（POSIX，'' 为根直属；
 *   A-03 局部重扫）。仅这些目录（含后代）内消失的键才作为孤儿候选；
 *   未扫描目录内的键一律保持原样——局部扫描"看不见"不等于模型被删除。
 *   缺省为全量语义（全部键参与判定）
 * @returns {{relinked:number, prunedEmpty:number, retainedOrphans:number}}
 *   relinked 迁移条目数；prunedEmpty 清理的空孤儿数；retainedOrphans 保留的数据孤儿数
 */
export function relinkScannedMeta(scanned, options = {}) {
  const zero = { relinked: 0, prunedEmpty: 0, retainedOrphans: 0 }
  if (!metaState.data || !getCurrentRoot() || !Array.isArray(scanned))
    return zero

  const affectedDirs = Array.isArray(options.affectedDirs)
    ? options.affectedDirs
    : null
  /** 键的相对目录是否落在受影响集合内（OP-09 共享实现；null = 全量语义） */
  const keyInScope = (key) => isRelKeyInScope(key, affectedDirs)

  const currentKeys = new Set()
  const newcomers = []
  for (const m of scanned) {
    const key = toRelKey(m.id)
    if (!key) continue
    currentKeys.add(key)
    if (!metaState.data.models[key]) {
      newcomers.push({
        key,
        ...splitRelKey(key),
        size: m.size,
        mtimeMs: m.mtimeMs,
      })
    }
  }

  const orphans = []
  for (const [key, meta] of Object.entries(metaState.data.models)) {
    if (currentKeys.has(key)) continue
    // 局部重扫：范围外的键保持原样，不迁移也不清理
    if (!keyInScope(key)) continue
    orphans.push({
      key,
      ...splitRelKey(key),
      hash: meta.hash || '',
      hashMtime: Number.isFinite(meta.hashMtime) ? meta.hashMtime : 0,
    })
  }
  if (orphans.length === 0) return zero

  const { relinks, unmatchedOrphanKeys } = planMetaRelinks(orphans, newcomers)
  for (const [oldKey, newKey] of relinks) {
    metaState.data.models[newKey] = metaState.data.models[oldKey]
    delete metaState.data.models[oldKey]
    markDirty(oldKey)
    markDirty(newKey)
  }

  let prunedEmpty = 0
  for (const key of unmatchedOrphanKeys) {
    if (isEmptyModelMeta(metaState.data.models[key])) {
      delete metaState.data.models[key]
      markDirty(key)
      prunedEmpty += 1
    }
  }
  const retainedOrphans = unmatchedOrphanKeys.length - prunedEmpty

  if (relinks.length > 0) {
    logger.info(
      `已重新关联 ${relinks.length} 个被移动/重命名模型的标注` +
        (retainedOrphans > 0
          ? `；${retainedOrphans} 个含数据的失效条目已保守保留`
          : ''),
    )
  }
  if (relinks.length > 0 || prunedEmpty > 0) scheduleSave()

  return { relinked: relinks.length, prunedEmpty, retainedOrphans }
}

/* ---------------- 门面再导出（保持 './store-meta' 公共 API 不变） ---------------- */

// 不可信输入规范化（备份恢复/跨库传输直接消费）
export { normalizeStoreData } from './store-meta-normalize'
// 落盘链（备份/退出/切库/离线重试等路径消费）
export {
  saveStoreDeltaNow,
  saveStoreNow,
  flushStoreSave,
} from './store-meta-persist'
