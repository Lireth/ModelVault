import { app } from 'electron'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
import { atomicWriteFile } from './atomic-write'
import { notifyStoreSaveError } from './store-events'
import { isEmptyModelMeta, planMetaRelinks, splitRelKey } from './meta-relink'
import { ALL_CATEGORY_KEYS } from '../../shared/model-categories'
import { isRelKeyInScope } from '../../shared/scan-dirs'
import {
  COVERS_DIR,
  DATA_DIR,
  DATA_FILE,
  LEGACY_STORE_FILE,
  getCoversDir,
  getCurrentRoot,
  getDataDir,
  getDataFilePath,
  getJournalDir,
  setDataRoot,
  toRelKey
} from './store-paths'

/**
 * 关联存储（C2 自 store.js 拆出）：
 * 模型的所有用户数据（封面、推荐参数、备注、收藏/评分/NSFW、哈希缓存等）
 * 按相对路径关联，统一存于模型根目录 .modelvault/store.json。
 * 写入采用防抖 + 原子替换；O5 起背景保存只写变化键增量日志
 * （.modelvault/journal/），达到阈值/退出/备份/切库时合并为紧凑快照；
 * store.json 损坏时备份后重置；首次对某根目录启用时自动从旧版全局存储迁移。
 */

/**
 * 允许的二级分类标签 key 集合（A-12 单一来源：src/shared/model-categories.js，
 * 与渲染层 SUB_CATEGORIES/LORA_TAGS/CHECKPOINT_TAGS 共用同一定义）
 */
const VALID_SUB_CATEGORIES = ALL_CATEGORY_KEYS

/** 防抖落盘延迟（ms） */
const SAVE_DELAY = 500

/**
 * 增量日志合并阈值（O5）：背景保存累计的脏键/日志条目达到该值即写一次
 * 全量快照并清空日志；退出、备份、切库、备份恢复等路径强制快照。
 */
const JOURNAL_COMPACT_ENTRIES = 200

/** 当前根目录的元数据，键为相对路径（'/' 分隔） */
let data = null
let saveTimer = null
let saving = false
/** 写盘进行期间收到的新保存请求（落盘完成后需补写一次，避免丢失） */
let pendingSave = false
/** 写盘期间又收到「强制快照」请求（flush/saveStoreNow） */
let pendingSnapshot = false
/** 自上次快照以来发生变更的元数据键（增量日志内容） */
let dirtyKeys = new Set()
/** 日志代际：快照记录已合并到的 seq，加载时跳过 ≤ 该值的日志批次 */
let journalSeq = 0
/** 自上次快照以来已写入日志的条目数（触发合并阈值） */
let journalEntryCount = 0
/** 当前根目录是否已存在可读的 store.json 快照 */
let hasSnapshot = false
/**
 * 内存元数据变更版本：用于识别「序列化/写盘期间又发生变更」。
 * 快照若在写盘期间有新变更，绝不整体清空 dirtyKeys（否则新变更静默丢失）。
 */
let mutationVersion = 0

/** 标记脏键并递增变更版本（所有元数据变更的唯一入口） */
function markDirty(key) {
  dirtyKeys.add(key)
  mutationVersion += 1
}
/**
 * 暂停元数据落盘（B-02）：备份恢复替换磁盘文件后、内存重载完成前，
 * 任何由旧内存触发的写入都会把恢复结果覆盖回去。重载窗口内直接丢弃
 * 保存请求，待 loadData 完成后恢复；并发写入的互斥由维护锁（MV-02）保证。
 */
let saveSuppressed = false
/** 元数据是否因损坏被重置（为 true 时应跳过孤儿封面清理，避免误删） */
let dataReset = false

/**
 * 危险对象键（原型污染防御，B-04）：备份 zip 与磁盘 store.json 均属
 * 不可信输入。JSON.parse 会为 "__proto__" 生成自有属性，直接写入普通
 * 对象会改写其原型；constructor/prototype 一并拒绝，避免后续任何
 * 基于原型链的回退查找命中伪造元数据。
 */
const UNSAFE_MODEL_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * 键是否可用于元数据表（拒绝空键与原型相关危险键）。
 * @param {unknown} key 相对路径键
 * @returns {boolean}
 */
export function isUnsafeModelKey(key) {
  return typeof key !== 'string' || key === '' || UNSAFE_MODEL_KEYS.has(key)
}

/**
 * 将任意来源的 store.json 结构规范化为可信元数据表（纯函数，B-04）：
 * - 剔除危险键，杜绝原型污染；
 * - 逐条走 normalizeModelMeta（字段截断/类型校验/绝对封面自愈）。
 * @param {unknown} parsed JSON.parse 结果（可能缺字段或为恶意构造）
 * @returns {{version: number, models: Record<string, object>}}
 */
export function normalizeStoreData(parsed) {
  const models = {}
  const source = parsed && typeof parsed === 'object' ? parsed.models : null
  if (source && typeof source === 'object') {
    for (const [key, meta] of Object.entries(source)) {
      if (isUnsafeModelKey(key)) continue
      const normalized = normalizeModelMeta(meta)
      if (normalized) models[key] = normalized
    }
  }
  return { version: 1, models }
}

/**
 * 规范化单条封面引用（A7 绝对路径自愈）：
 * - 相对路径原样保留（规范存储格式）；
 * - 绝对路径是历史数据残留（如根目录移动前的旧位置），协议层只放行当前根目录，
 *   根目录外的绝对路径会恒 403，形成「有封面但永不显示」的死状态。
 *   位于当前根目录内的绝对路径转换为相对引用（自愈）；根目录外的视为失效，剔除。
 * @param {string} c 封面引用（相对路径或历史绝对路径）
 * @returns {string} 规范化的相对路径（失效时为空串）
 */
function normalizeCoverRef(c) {
  if (typeof c !== 'string' || !c) return ''
  if (!path.isAbsolute(c)) return c
  return toRelKey(c) || ''
}

/** 取新字段；缺失时回退到旧版宽/高字段中的较小值 */
function pickLegacyRes(value, legacyValues) {
  if (Number.isFinite(value)) return value
  const legacy = legacyValues.filter((v) => Number.isFinite(v))
  return legacy.length > 0 ? Math.min(...legacy) : null
}

/** 自由标签上限：单模型标签数与单标签长度（F-5） */
const MAX_TAGS = 20
const MAX_TAG_LEN = 32

/**
 * 规范化自由标签列表（F-5）：逐项 trim + 截断长度，去空项与重复项
 * （大小写不敏感去重，保留首个原始写法），总量超限截断。
 * @param {unknown} raw 原始 tags 值
 * @returns {string[]} 规范化后的标签数组（无标签为空数组）
 */
function normalizeTags(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const tag = item.trim().slice(0, MAX_TAG_LEN)
    if (!tag) continue
    const lower = tag.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

/** 规范化单条模型元数据，剔除未知字段 */
function normalizeModelMeta(raw) {
  if (!raw || typeof raw !== 'object') return null
  const params = raw.params && typeof raw.params === 'object' ? raw.params : {}
  // 多封面列表（相对路径，顺序即添加顺序），兼容旧版单封面字段；
  // 逐条做绝对路径自愈后过滤失效项（A7）
  let covers = Array.isArray(raw.covers)
    ? raw.covers
        .map(normalizeCoverRef)
        .filter((c) => c && c.length <= 500)
        .slice(0, 50)
    : []
  if (covers.length === 0 && typeof raw.cover === 'string' && raw.cover) {
    const healed = normalizeCoverRef(raw.cover)
    if (healed) covers = [healed]
  }
  let cover = normalizeCoverRef(raw.cover)
  if (!cover && covers.length > 0) cover = covers[0]
  return {
    cover,
    covers,
    // 备注名：用户自定义显示名称（为空时回退文件名）
    alias: typeof raw.alias === 'string' ? raw.alias.trim().slice(0, 100) : '',
    note: typeof raw.note === 'string' ? raw.note.slice(0, 2000) : '',
    // 备注来源（'sidecar' 表示由同名 .txt 自动导入；用户在详情页保存后清除）
    noteSource: raw.noteSource === 'sidecar' ? 'sidecar' : '',
    subCategory: VALID_SUB_CATEGORIES.has(raw.subCategory) ? raw.subCategory : '',
    // 触发词（LoRA 等模型的唤起词，自由文本，详情页可一键复制）
    triggerWords:
      typeof raw.triggerWords === 'string' ? raw.triggerWords.trim().slice(0, 1000) : '',
    // 触发词来源（'sidecar' = 同名 .txt 首行自动导入；'civitai' = 同名
    // .civitai.info 的 trainedWords 自动导入，F8；用户在详情页保存后清除）
    triggerWordsSource:
      raw.triggerWordsSource === 'sidecar' || raw.triggerWordsSource === 'civitai'
        ? raw.triggerWordsSource
        : '',
    // 收藏标记（false 为未收藏）
    favorite: raw.favorite === true,
    // NSFW 标记：勾选后首页卡片预览图做模糊处理（详情页正常展示）
    nsfw: raw.nsfw === true,
    // 评分（0-5 整数，0 为未评分）
    rating: Number.isInteger(raw.rating) && raw.rating >= 0 && raw.rating <= 5 ? raw.rating : 0,
    // 文件 SHA256 哈希与计算时的文件 mtime，
    // mtime 一致则重启后无需重新计算大文件哈希
    hash: typeof raw.hash === 'string' && /^[0-9a-f]{64}$/i.test(raw.hash) ? raw.hash.toLowerCase() : '',
    hashMtime: Number.isFinite(raw.hashMtime) ? raw.hashMtime : 0,
    // Civitai 在线识别结果（识别成功时由 models:civitaiIdentify 写入）：
    // 模型页面 URL（仅放行 civitai.com 页面链接，渲染层经外链白名单打开）
    civitaiUrl:
      typeof raw.civitaiUrl === 'string' &&
      /^https:\/\/civitai\.com\/models\/\d+/.test(raw.civitaiUrl)
        ? raw.civitaiUrl
        : '',
    // 基底模型（F-2 筛选数据源之二）：Civitai 识别回填（safetensors 头部
    // 解析不可用或未携带时的补全来源）；渲染层与 autoInfo.baseModel 合并展示
    baseModel:
      typeof raw.baseModel === 'string' ? raw.baseModel.trim().slice(0, 100) : '',
    // 自由标签（F-5）：用户自定义多标签，与二级分类标签（固定枚举）互补；
    // 随元数据整体迁移（relink），不参与文件夹整理的目录映射
    tags: normalizeTags(raw.tags),
    params: {
      steps: Number.isFinite(params.steps) ? params.steps : null,
      // CFG 为区间字段；兼容旧版单值 cfg（迁移为 min = max = 旧值）
      cfgMin: pickLegacyRes(params.cfgMin, [params.cfg]),
      cfgMax: pickLegacyRes(params.cfgMax, [params.cfg]),
      sampler: typeof params.sampler === 'string' ? params.sampler : '',
      scheduler: typeof params.scheduler === 'string' ? params.scheduler : '',
      // 模型精度（如 FP16 / BF16 / FP32 / FP8）
      precision: typeof params.precision === 'string' ? params.precision.slice(0, 20) : '',
      // 兼容旧版四字段（resMinW/resMinH/resMaxW/resMaxH），迁移为宽高共用的单值区间
      resMin: pickLegacyRes(params.resMin, [params.resMinW, params.resMinH]),
      resMax: pickLegacyRes(params.resMax, [params.resMaxW, params.resMaxH])
    }
  }
}

/** 删除单条模型元数据（模型文件被移入回收站时调用） */
export function removeModelMeta(modelId) {
  if (!data) return false
  const relKey = toRelKey(modelId)
  if (!relKey || !data.models[relKey]) return false
  delete data.models[relKey]
  markDirty(relKey)
  scheduleSave()
  return true
}

/**
 * 模型文件改名/移动后整体迁移元数据键（F10 禁用后缀 / F11 库内移动）：
 * 键以相对路径关联，绝对路径变了键就失效——重扫时 relink 的 R1/R2
 * 能自愈大多数场景，但改名 .disabled 会使扩展名变化导致两条规则都
 * 不命中；主动迁移保证标注（含哈希履历）即时无缝跟随。
 * @param {string} oldId 旧绝对路径
 * @param {string} newId 新绝对路径
 * @returns {boolean} 迁移成功返回 true（无旧数据/越界返回 false）
 */
export function renameModelMeta(oldId, newId) {
  if (!data) return false
  const oldKey = toRelKey(oldId)
  const newKey = toRelKey(newId)
  if (!oldKey || !newKey || oldKey === newKey) return false
  const meta = data.models[oldKey]
  if (!meta) return false
  data.models[newKey] = meta
  delete data.models[oldKey]
  markDirty(oldKey)
  markDirty(newKey)
  scheduleSave()
  return true
}

/** 删除增量日志目录（快照成功后/快照损坏重置时；best-effort） */
async function removeJournalDir() {
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
async function loadJournal(snapshotSeq) {
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
        if (normalized) data.models[entry.key] = normalized
      } else if (entry.op === 'del') {
        delete data.models[entry.key]
      }
    }
    journalSeq = Math.max(journalSeq, parsed.seq)
    journalEntryCount += parsed.entries.length
  }
}

/**
 * 加载当前根目录的关联存储数据（O5：store.json 快照 + 增量日志回放）。
 * store.json 不存在时创建空数据，并尝试从旧版全局存储迁移属于该目录的记录。
 */
export async function loadData() {
  dataReset = false
  dirtyKeys = new Set()
  journalSeq = 0
  journalEntryCount = 0
  hasSnapshot = false
  pendingSnapshot = false
  mutationVersion = 0
  if (!getCurrentRoot()) {
    data = { version: 1, models: {} }
    return data
  }
  const file = getDataFilePath()
  let snapshotSeq = 0
  try {
    const text = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(text)
    // B-04：磁盘文件同样按不可信输入处理（可能由恶意备份写入或外部编辑）
    data = normalizeStoreData(parsed)
    hasSnapshot = true
    snapshotSeq = Number.isFinite(parsed?.journalSeq) ? parsed.journalSeq : 0
    journalSeq = snapshotSeq
    logger.info(`关联存储加载完成：${Object.keys(data.models).length} 条记录（${file}）`)
  } catch (err) {
    if (err.code === 'ENOENT') {
      data = { version: 1, models: {} }
      await loadJournal(0)
      await migrateLegacyData()
    } else {
      data = { version: 1, models: {} }
      dataReset = true
      // store.json 损坏（如写入中断电、磁盘错误）：先备份原文件再重置，保留手动恢复机会。
      // 增量日志同时丢弃——在缺失快照基线时回放 delta 可能把半套数据重新拼起来
      try {
        await fs.rename(file, `${file}.bak`)
        logger.error(`关联存储文件损坏，原文件已备份为 ${DATA_FILE}.bak 后重置: ${err.message}`)
      } catch (backupErr) {
        logger.error(`关联存储加载失败，已重置（备份失败: ${backupErr.message}）: ${err.message}`)
      }
      await removeJournalDir()
    }
  }
  if (!dataReset && hasSnapshot) await loadJournal(snapshotSeq)
  return data
}

/** 元数据是否因损坏被重置（孤儿封面清理前应检查，避免误删） */
export function wasDataReset() {
  return dataReset
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
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  // B-02 恢复屏障：
  // 1) 丢弃挂起的补写请求，恢复窗口内不再调度新落盘；
  // 2) 等待已开始的原子写结束（其 rename 不可取消），避免读到交换中的文件；
  // 3) 之后才从磁盘重载，保证内存基线就是恢复后的内容。
  saveSuppressed = true
  pendingSave = false
  pendingSnapshot = false
  try {
    while (saving) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  } finally {
    saveSuppressed = false
  }
  return loadData()
}

/** 收集元数据中引用的所有封面相对路径（孤儿封面清理的保留名单） */
export function getReferencedCovers() {
  const refs = new Set()
  if (!data) return refs
  for (const meta of Object.values(data.models)) {
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
          normalized.covers = [newRel, ...normalized.covers.filter((c) => c !== newRel)]
        } catch {
          normalized.cover = ''
        }
      }
      data.models[relKey] = normalized
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
  if (!data) return null
  const relKey = toRelKey(modelId)
  return relKey ? data.models[relKey] || null : null
}

/** 以绝对路径返回模型元数据表（供渲染进程使用） */
export function getMetaMapByAbsPath() {
  const result = {}
  if (!data || !getCurrentRoot()) return result
  for (const [relKey, meta] of Object.entries(data.models)) {
    result[path.join(getCurrentRoot(), relKey)] = meta
  }
  return result
}

/** 写入单条模型元数据（合并保存，键为模型绝对路径） */
export function setModelMeta(modelId, meta) {
  if (!data || typeof modelId !== 'string' || !modelId) return null
  const relKey = toRelKey(modelId)
  if (!relKey || isUnsafeModelKey(relKey)) {
    logger.warn(`模型不在当前根目录内，忽略保存: ${modelId}`)
    return null
  }
  const normalized = normalizeModelMeta(meta)
  if (!normalized) return null
  data.models[relKey] = normalized
  markDirty(relKey)
  scheduleSave()
  return normalized
}

/** 防抖保存：短时间内多次修改只落盘一次 */
function scheduleSave() {
  // 恢复重载窗口内不调度：定时器携带的是恢复前的旧内存
  if (saveSuppressed) return
  if (saveTimer) clearTimeout(saveTimer)
  // 记录调度时的根目录（A6）：定时器触发时若根已切换，本次防抖携带的
  // 是旧根数据，直接落盘会写进新根目录的 store.json（跨库污染）——丢弃。
  // 正常流程下切库前已由 switchDataRoot 静止写盘链，此处为兜底
  const scheduledRoot = getCurrentRoot()
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (getCurrentRoot() !== scheduledRoot) {
      logger.warn('丢弃跨根目录的迟到防抖保存（数据已在切库前落盘）')
      return
    }
    // O5：防抖保存只落「变化键」增量日志，不再每次全量 pretty 序列化；
    // 达到阈值/退出/备份/切库时由写盘链合并为紧凑快照
    saveStoreDeltaNow().catch(notifyStoreSaveError)
  }, SAVE_DELAY)
}

/**
 * 写全量快照（O5：紧凑 JSON，不再 pretty 缩进）+ 清空增量日志。
 * 快照携带 journalSeq：即使快照成功后清理日志失败，加载时也会跳过
 * seq ≤ snapshotSeq 的旧批次，不会用旧 delta 回滚快照内容。
 */
async function writeSnapshot() {
  // 版本快照必须在同步序列化之前捕获：JSON.stringify 期间/写盘 await 期间
  // 若有新变更，dirtyKeys 不能整体清空（否则丢失尚未落盘的修改）
  const versionAtWrite = mutationVersion
  const payload = { version: 1, models: data.models, journalSeq }
  const text = JSON.stringify(payload)
  await atomicWriteFile(getDataFilePath(), text)
  hasSnapshot = true
  journalEntryCount = 0
  if (mutationVersion === versionAtWrite) dirtyKeys.clear()
  await removeJournalDir()
}

/**
 * 写一批增量日志（O5）：只序列化自上次快照以来发生变化的键。
 * 每个批次经 atomicWriteFile 原子落盘（独立文件），避免 append 半行；
 * seq 单调递增，快照合并后旧批次按代际跳过。
 * @param {string[]} keys 脏键列表
 */
async function writeDeltaJournal(keys) {
  const seq = journalSeq + 1
  const entries = []
  /** 写入内容对应的元数据引用：写盘期间被再次修改的键必须保留为脏 */
  const written = new Map()
  for (const key of keys) {
    if (isUnsafeModelKey(key)) continue
    const meta = data.models[key] || null
    written.set(key, meta)
    entries.push(meta ? { op: 'set', key, meta } : { op: 'del', key })
  }
  if (entries.length === 0) {
    dirtyKeys.clear()
    return
  }
  const file = path.join(
    getJournalDir(),
    `delta-${String(seq).padStart(12, '0')}.json`
  )
  await atomicWriteFile(file, JSON.stringify({ seq, entries }))
  journalSeq = seq
  journalEntryCount += entries.length
  for (const [key, metaAtWrite] of written) {
    // 引用一致 = 写盘期间未再修改该键；否则保留脏标记，下次增量补写最新值
    if (metaAtWrite === null ? !data.models[key] : data.models[key] === metaAtWrite) {
      dirtyKeys.delete(key)
    }
  }
}

/**
 * 统一写盘入口：增量日志或全量快照。
 * @param {boolean} forceSnapshot 是否强制写全量快照
 */
async function runSave(forceSnapshot) {
  if (!data || !getCurrentRoot() || saveSuppressed) return
  if (saving) {
    // 写盘进行中又有新修改：标记待补写；若其中有强制快照请求，补写也必须快照
    pendingSave = true
    pendingSnapshot = pendingSnapshot || forceSnapshot
    return
  }
  saving = true
  try {
    const keys = [...dirtyKeys]
    if (
      forceSnapshot ||
      !hasSnapshot ||
      journalEntryCount + keys.length >= JOURNAL_COMPACT_ENTRIES
    ) {
      await writeSnapshot()
    } else if (keys.length > 0) {
      await writeDeltaJournal(keys)
    }
  } catch (err) {
    notifyStoreSaveError(err)
  } finally {
    saving = false
    if (pendingSave) {
      pendingSave = false
      const force = pendingSnapshot
      pendingSnapshot = false
      // 补写读取的是当前最新 data，覆盖写盘期间的任何后续修改；
      // 若已进入恢复重载窗口则丢弃，绝不把旧内存写回刚恢复的文件
      if (!saveSuppressed) {
        (force ? runSave(true) : runSave(false)).catch(notifyStoreSaveError)
      }
    }
  }
}

/**
 * 增量落盘（防抖保存路径）：只写脏键日志；达到阈值时自动合并快照。
 * @returns {Promise<void>}
 */
export async function saveStoreDeltaNow() {
  return runSave(false)
}

/**
 * 立即写全量快照（原子写入：临时文件 -> 重命名；并发请求排队补写，不会丢失）。
 * 退出、备份、切库、备份恢复等需要磁盘为完整快照的场景使用。
 */
export async function saveStoreNow() {
  return runSave(true)
}

/**
 * 等待元数据写盘链完全静止（退出路径专用，替代直接 await saveStoreNow）：
 * saveStoreNow 在写盘进行中仅登记 pendingSave 立即返回，退出流程若直接 await
 * 会过早 quit 中断在途写入，且 finally 中的补写永无机会执行，导致最后一批
 * 元数据修改丢失。本函数先取消未触发的防抖定时器、触发一次落盘请求
 * （空闲则立即写入，写盘中则登记补写），随后等待写盘与补写全部完成。
 */
export async function flushStoreSave() {
  const hadPendingTimer = saveTimer !== null
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  // 无待落盘内容时不要“为写而写”：空库首次导出/退出不应凭空创建 store.json。
  // 存在增量日志时必须强制快照——备份/退出读取的是 store.json 快照本身。
  if (
    !hadPendingTimer &&
    !saving &&
    !pendingSave &&
    dirtyKeys.size === 0 &&
    journalEntryCount === 0
  ) {
    return
  }
  await saveStoreNow()
  while (saving || pendingSave) {
    await new Promise((resolve) => setImmediate(resolve))
  }
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
  if (!data || !getCurrentRoot() || !Array.isArray(scanned)) return zero

  const affectedDirs = Array.isArray(options.affectedDirs) ? options.affectedDirs : null
  /** 键的相对目录是否落在受影响集合内（OP-09 共享实现；null = 全量语义） */
  const keyInScope = (key) => isRelKeyInScope(key, affectedDirs)

  const currentKeys = new Set()
  const newcomers = []
  for (const m of scanned) {
    const key = toRelKey(m.id)
    if (!key) continue
    currentKeys.add(key)
    if (!data.models[key]) {
      newcomers.push({
        key,
        ...splitRelKey(key),
        size: m.size,
        mtimeMs: m.mtimeMs
      })
    }
  }

  const orphans = []
  for (const [key, meta] of Object.entries(data.models)) {
    if (currentKeys.has(key)) continue
    // 局部重扫：范围外的键保持原样，不迁移也不清理
    if (!keyInScope(key)) continue
    orphans.push({
      key,
      ...splitRelKey(key),
      hash: meta.hash || '',
      hashMtime: Number.isFinite(meta.hashMtime) ? meta.hashMtime : 0
    })
  }
  if (orphans.length === 0) return zero

  const { relinks, unmatchedOrphanKeys } = planMetaRelinks(orphans, newcomers)
  for (const [oldKey, newKey] of relinks) {
    data.models[newKey] = data.models[oldKey]
    delete data.models[oldKey]
    markDirty(oldKey)
    markDirty(newKey)
  }

  let prunedEmpty = 0
  for (const key of unmatchedOrphanKeys) {
    if (isEmptyModelMeta(data.models[key])) {
      delete data.models[key]
      markDirty(key)
      prunedEmpty += 1
    }
  }
  const retainedOrphans = unmatchedOrphanKeys.length - prunedEmpty

  if (relinks.length > 0) {
    logger.info(
      `已重新关联 ${relinks.length} 个被移动/重命名模型的标注` +
        (retainedOrphans > 0 ? `；${retainedOrphans} 个含数据的失效条目已保守保留` : '')
    )
  }
  if (relinks.length > 0 || prunedEmpty > 0) scheduleSave()

  return { relinked: relinks.length, prunedEmpty, retainedOrphans }
}
