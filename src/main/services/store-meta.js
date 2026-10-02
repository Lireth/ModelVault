import { app } from 'electron'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
import { atomicWriteFile } from './atomic-write'
import { notifyStoreSaveError } from './store-events'
import {
  COVERS_DIR,
  DATA_DIR,
  DATA_FILE,
  LEGACY_STORE_FILE,
  getCoversDir,
  getCurrentRoot,
  getDataDir,
  getDataFilePath,
  toRelKey
} from './store-paths'

/**
 * 关联存储（C2 自 store.js 拆出）：
 * 模型的所有用户数据（封面、推荐参数、备注、收藏/评分/NSFW、哈希缓存等）
 * 按相对路径关联，统一存于模型根目录 .modelvault/store.json。
 * 写入采用防抖 + 原子替换；store.json 损坏时备份后重置；
 * 首次对某根目录启用时自动从旧版全局存储迁移。
 */

/** 「其他模型」允许的二级分类标签 */
const VALID_SUB_CATEGORIES = new Set([
  'embedding', 'controlnet', 'upscale', 'hypernetwork', 'other',
  // LoRA 分类标签
  'role', 'style', 'concept', 'outfit', 'background', 'pose', 'tool',
  // Checkpoint 自动分类
  'base'
])

/** 防抖落盘延迟（ms） */
const SAVE_DELAY = 500

/** 当前根目录的元数据，键为相对路径（'/' 分隔） */
let data = null
let saveTimer = null
let saving = false
/** 写盘进行期间收到的新保存请求（落盘完成后需补写一次，避免丢失） */
let pendingSave = false
/** 元数据是否因损坏被重置（为 true 时应跳过孤儿封面清理，避免误删） */
let dataReset = false

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
    // 触发词来源（'sidecar' 表示由同名 .txt 首行自动导入；用户在详情页保存后清除）
    triggerWordsSource: raw.triggerWordsSource === 'sidecar' ? 'sidecar' : '',
    // 收藏标记（false 为未收藏）
    favorite: raw.favorite === true,
    // NSFW 标记：勾选后首页卡片预览图做模糊处理（详情页正常展示）
    nsfw: raw.nsfw === true,
    // 评分（0-5 整数，0 为未评分）
    rating: Number.isInteger(raw.rating) && raw.rating >= 0 && raw.rating <= 5 ? raw.rating : 0,
    // Civitai AutoV2 哈希（SHA256 hex）与计算时的文件 mtime，
    // mtime 一致则重启后无需重新计算大文件哈希
    hash: typeof raw.hash === 'string' && /^[0-9a-f]{64}$/i.test(raw.hash) ? raw.hash.toLowerCase() : '',
    hashMtime: Number.isFinite(raw.hashMtime) ? raw.hashMtime : 0,
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
  scheduleSave()
  return true
}

/**
 * 持久化模型的 AutoV2 哈希与计算时的文件 mtime（防抖落盘）。
 * 文件被修改（mtime 变化）后哈希自动失效，下次匹配重新计算。
 * @param {string} modelId 模型绝对路径
 * @param {string} hash SHA256 hex 字符串
 * @param {number} mtimeMs 计算哈希时的文件修改时间
 */
export function setModelHash(modelId, hash, mtimeMs) {
  if (!data) return false
  const relKey = toRelKey(modelId)
  if (!relKey || !data.models[relKey]) return false
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) return false
  data.models[relKey].hash = hash.toLowerCase()
  data.models[relKey].hashMtime = Number.isFinite(mtimeMs) ? mtimeMs : 0
  scheduleSave()
  return true
}

/**
 * 加载当前根目录的关联存储数据。
 * store.json 不存在时创建空数据，并尝试从旧版全局存储迁移属于该目录的记录。
 */
export async function loadData() {
  dataReset = false
  if (!getCurrentRoot()) {
    data = { version: 1, models: {} }
    return data
  }
  const file = getDataFilePath()
  try {
    const text = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(text)
    data = { version: 1, models: {} }
    for (const [key, meta] of Object.entries(parsed?.models || {})) {
      const normalized = normalizeModelMeta(meta)
      if (normalized) data.models[key] = normalized
    }
    logger.info(`关联存储加载完成：${Object.keys(data.models).length} 条记录（${file}）`)
  } catch (err) {
    if (err.code === 'ENOENT') {
      data = { version: 1, models: {} }
      await migrateLegacyData()
    } else {
      data = { version: 1, models: {} }
      dataReset = true
      // store.json 损坏（如写入中断电、磁盘错误）：先备份原文件再重置，保留手动恢复机会
      try {
        await fs.rename(file, `${file}.bak`)
        logger.error(`关联存储文件损坏，原文件已备份为 ${DATA_FILE}.bak 后重置: ${err.message}`)
      } catch (backupErr) {
        logger.error(`关联存储加载失败，已重置（备份失败: ${backupErr.message}）: ${err.message}`)
      }
    }
  }
  return data
}

/** 元数据是否因损坏被重置（孤儿封面清理前应检查，避免误删） */
export function wasDataReset() {
  return dataReset
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
      if (!relKey) continue
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
  if (!relKey) {
    logger.warn(`模型不在当前根目录内，忽略保存: ${modelId}`)
    return null
  }
  const normalized = normalizeModelMeta(meta)
  if (!normalized) return null
  data.models[relKey] = normalized
  scheduleSave()
  return normalized
}

/** 防抖保存：短时间内多次修改只落盘一次 */
export function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveStoreNow().catch(notifyStoreSaveError)
  }, SAVE_DELAY)
}

/** 立即落盘（原子写入：临时文件 -> 重命名；并发请求排队补写，不会丢失） */
export async function saveStoreNow() {
  if (!data || !getCurrentRoot()) return
  if (saving) {
    // 写盘进行中又有新修改：标记待补写，由 finally 在落盘完成后触发补写
    pendingSave = true
    return
  }
  saving = true
  try {
    await atomicWriteFile(getDataFilePath(), JSON.stringify(data, null, 2))
  } catch (err) {
    notifyStoreSaveError(err)
  } finally {
    saving = false
    if (pendingSave) {
      pendingSave = false
      // 补写读取的是当前最新 data，覆盖写盘期间的任何后续修改
      saveStoreNow().catch(notifyStoreSaveError)
    }
  }
}

/**
 * 等待元数据写盘链完全静止（退出路径专用，替代直接 await saveStoreNow）：
 * saveStoreNow 在写盘进行中仅登记 pendingSave 立即返回，退出流程若直接 await
 * 会过早 quit 中断在途写入，且 finally 中的补写永无机会执行，导致最后一批
 * 元数据修改丢失。本函数先取消未触发的防抖定时器、触发一次落盘请求
 * （空闲则立即写入，写盘中则登记补写），随后等待写盘与补写全部完成。
 */
export async function flushStoreSave() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  await saveStoreNow()
  while (saving || pendingSave) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}
