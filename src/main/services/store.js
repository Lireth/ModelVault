import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'

/**
 * 关联存储模块：
 * - 应用设置（最近使用的模型根目录）保存在用户数据目录 settings.json
 * - 模型的所有用户数据（封面图片、推荐参数、备注、二级分类标签等）
 *   统一保存在用户所选模型根目录下的 .modelvault/ 文件夹中：
 *     <模型根目录>/.modelvault/store.json   元数据（按相对路径关联模型）
 *     <模型根目录>/.modelvault/covers/      上传的封面图片
 * - 元数据键为相对于模型根目录的路径，封面为相对路径，
 *   因此整个模型文件夹移动/复制到其他位置后关联关系依然成立。
 * - 首次对某个根目录启用关联存储时，自动从旧版（%APPDATA% 全局存储）
 *   迁移属于该目录的记录，并复制封面文件。
 * 写入采用防抖 + 原子替换（先写临时文件再重命名）。
 */

const SETTINGS_FILE = 'settings.json'
const LEGACY_STORE_FILE = 'store.json'
export const DATA_DIR = '.modelvault'
export const DATA_FILE = 'store.json'
export const COVERS_DIR = 'covers'
const SAVE_DELAY = 500

/** 「其他模型」允许的二级分类标签 */
const VALID_SUB_CATEGORIES = new Set([
  'embedding', 'controlnet', 'upscale', 'hypernetwork', 'other',
  // LoRA 分类标签
  'role', 'style', 'concept', 'outfit', 'background', 'pose', 'tool',
  // Checkpoint 自动分类
  'base'
])

/** 应用设置允许的主题取值 */
const VALID_THEMES = new Set(['dark', 'light'])
/** 应用设置允许的卡片尺寸取值 */
const VALID_CARD_SIZES = new Set(['compact', 'normal', 'large'])
/** 应用设置允许的默认排序方式 */
const VALID_SORT_BY = new Set(['name', 'type', 'size', 'mtime'])
/** 应用设置允许的扫描文件扩展名（与 scanner.js 的 MODEL_EXTENSIONS 保持一致） */
const VALID_SCAN_EXTENSIONS = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.bin'])

/** 默认应用设置 */
function defaultSettings() {
  return {
    modelsFolder: '',
    autoScan: true,
    excludeDirs: [],
    theme: 'dark',
    cardSize: 'normal',
    sortBy: 'name',
    scanExtensions: [...VALID_SCAN_EXTENSIONS],
    showSize: true,
    showMtime: true,
    showParams: true
  }
}

/** 规范化扩展名列表：仅接受已知扩展名并去重；为空时回退到全部 */
function normalizeExtensions(raw) {
  const list = Array.isArray(raw)
    ? raw
        .filter((e) => typeof e === 'string')
        .map((e) => e.trim().toLowerCase())
        .filter((e) => VALID_SCAN_EXTENSIONS.has(e))
    : []
  const unique = [...new Set(list)]
  return unique.length > 0 ? unique : [...VALID_SCAN_EXTENSIONS]
}

/** 规范化应用设置：仅接受已知字段并校验类型 */
function normalizeSettings(raw) {
  const base = defaultSettings()
  if (!raw || typeof raw !== 'object') return base
  const excludeDirs = Array.isArray(raw.excludeDirs)
    ? [...new Set(
        raw.excludeDirs
          .filter((d) => typeof d === 'string')
          .map((d) => d.trim())
          .filter((d) => d && d.length <= 100)
      )].slice(0, 100)
    : base.excludeDirs
  return {
    modelsFolder: typeof raw.modelsFolder === 'string' ? raw.modelsFolder : base.modelsFolder,
    autoScan: typeof raw.autoScan === 'boolean' ? raw.autoScan : base.autoScan,
    excludeDirs,
    theme: VALID_THEMES.has(raw.theme) ? raw.theme : base.theme,
    cardSize: VALID_CARD_SIZES.has(raw.cardSize) ? raw.cardSize : base.cardSize,
    sortBy: VALID_SORT_BY.has(raw.sortBy) ? raw.sortBy : base.sortBy,
    scanExtensions: normalizeExtensions(raw.scanExtensions),
    showSize: typeof raw.showSize === 'boolean' ? raw.showSize : base.showSize,
    showMtime: typeof raw.showMtime === 'boolean' ? raw.showMtime : base.showMtime,
    showParams: typeof raw.showParams === 'boolean' ? raw.showParams : base.showParams
  }
}

let settings = defaultSettings()
let currentRoot = null
/** 根目录的小写形式（Windows 大小写不敏感路径匹配兜底用） */
let currentRootLower = null
/** 当前根目录的元数据，键为相对路径（'/' 分隔） */
let data = null
let saveTimer = null
let saving = false
/** 写盘进行期间收到的新保存请求（落盘完成后需补写一次，避免丢失） */
let pendingSave = false
/** 元数据是否因损坏被重置（为 true 时应跳过孤儿封面清理，避免误删） */
let dataReset = false

/**
 * 原子写入文本文件（先写临时文件再重命名）。
 * 写入中断电/崩溃时不会损坏目标文件，settings.json、
 * window-state.json 与关联存储统一采用该策略。
 * @param {string} file 目标文件绝对路径
 * @param {string} content 待写入内容
 */
export async function atomicWriteFile(file, content) {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(tmp, content, 'utf-8')
    await fs.rename(tmp, file)
  } catch (err) {
    try {
      await fs.rm(tmp, { force: true })
    } catch {
      /* 清理失败可忽略 */
    }
    throw err
  }
}

/* ---------------- 路径辅助 ---------------- */

function getSettingsFilePath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE)
}

/** 根目录下的关联存储目录 */
function getDataDir(root = currentRoot) {
  return path.join(root, DATA_DIR)
}

function getDataFilePath(root = currentRoot) {
  return path.join(getDataDir(root), DATA_FILE)
}

/** 封面图片目录（位于模型根目录内） */
export function getCoversDir() {
  if (!currentRoot) throw new Error('尚未设置模型根目录')
  return path.join(getDataDir(), COVERS_DIR)
}

/** 当前生效的模型根目录 */
export function getCurrentRoot() {
  return currentRoot
}

/** 绝对模型路径 -> 相对键（'/' 分隔）；不在根目录内时返回 null */
function toRelKey(absPath) {
  if (!currentRoot || typeof absPath !== 'string') return null
  const rel = path.relative(currentRoot, absPath)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    // Windows 文件系统大小写不敏感：路径仅大小写不同时 path.relative
    // 会返回 '..\..' 导致关联失联，改用大小写不敏感的前缀匹配兜底
    if (process.platform !== 'win32' || !currentRootLower) return null
    const absLower = absPath.toLowerCase()
    const rootLower = currentRootLower.endsWith(path.sep)
      ? currentRootLower
      : currentRootLower + path.sep
    if (!absLower.startsWith(rootLower)) return null
    const rest = absPath.slice(rootLower.length)
    if (!rest) return null
    return rest.split(path.sep).join('/')
  }
  return rel.split(path.sep).join('/')
}

/** 判断绝对路径是否位于当前根目录内（Windows 大小写不敏感） */
export function isInRoot(absPath) {
  return typeof absPath === 'string' && !!toRelKey(absPath)
}

/** 相对封面路径 -> 绝对路径 */
export function resolveCover(coverRel) {
  if (!coverRel || !currentRoot) return ''
  if (path.isAbsolute(coverRel)) return coverRel
  return path.join(currentRoot, coverRel)
}

/** 绝对封面路径 -> 相对封面路径（仅限封面目录内的文件） */
export function relativizeCover(absCover) {
  if (!currentRoot || typeof absCover !== 'string') return ''
  const rel = path.relative(getCoversDir(), absCover)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return ''
  return `${DATA_DIR}/${COVERS_DIR}/${rel.split(path.sep).join('/')}`
}

/* ---------------- 元数据规范化 ---------------- */

/** 规范化单条模型元数据，剔除未知字段 */
function normalizeModelMeta(raw) {
  if (!raw || typeof raw !== 'object') return null
  const params = raw.params && typeof raw.params === 'object' ? raw.params : {}
  // 多封面列表（相对路径，顺序即添加顺序），兼容旧版单封面字段
  let covers = Array.isArray(raw.covers)
    ? raw.covers
        .filter((c) => typeof c === 'string' && c && c.length <= 500)
        .slice(0, 50)
    : []
  if (covers.length === 0 && typeof raw.cover === 'string' && raw.cover) {
    covers = [raw.cover]
  }
  let cover = typeof raw.cover === 'string' ? raw.cover : ''
  if (!cover && covers.length > 0) cover = covers[0]
  // 自定义标签：字符串数组，去空、去重、限量
  const tags = Array.isArray(raw.tags)
    ? [...new Set(
        raw.tags
          .filter((t) => typeof t === 'string')
          .map((t) => t.trim().slice(0, 30))
          .filter(Boolean)
      )].slice(0, 20)
    : []
  return {
    cover,
    covers,
    // 备注名：用户自定义显示名称（为空时回退文件名）
    alias: typeof raw.alias === 'string' ? raw.alias.trim().slice(0, 100) : '',
    note: typeof raw.note === 'string' ? raw.note.slice(0, 2000) : '',
    subCategory: VALID_SUB_CATEGORIES.has(raw.subCategory) ? raw.subCategory : '',
    // 收藏标记（false 为未收藏）
    favorite: raw.favorite === true,
    // 评分（0-5 整数，0 为未评分）
    rating: Number.isInteger(raw.rating) && raw.rating >= 0 && raw.rating <= 5 ? raw.rating : 0,
    // 自定义多标签
    tags,
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

/** 取新字段；缺失时回退到旧版宽/高字段中的较小值 */
function pickLegacyRes(value, legacyValues) {
  if (Number.isFinite(value)) return value
  const legacy = legacyValues.filter((v) => Number.isFinite(v))
  return legacy.length > 0 ? Math.min(...legacy) : null
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

/** 模型重命名后迁移元数据键（保留封面、参数、备注等全部标注数据） */
export function renameModelMeta(oldId, newId) {
  if (!data) return false
  const oldKey = toRelKey(oldId)
  const newKey = toRelKey(newId)
  if (!oldKey || !newKey || !data.models[oldKey]) return false
  // 目标键已存在时拒绝覆盖（重命名前已校验目标文件不存在，此处为防御性保护）
  if (data.models[newKey]) return false
  data.models[newKey] = data.models[oldKey]
  delete data.models[oldKey]
  scheduleSave()
  return true
}

/* ---------------- 应用设置（全局） ---------------- */

/** 加载应用设置（含通用/扫描/外观设置；旧版数据内嵌于 store.json，自动回退并迁移） */
export async function loadSettings() {
  try {
    const text = await fs.readFile(getSettingsFilePath(), 'utf-8')
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') {
      settings = normalizeSettings(parsed)
    }
  } catch {
    // settings.json 不存在：尝试从旧版 store.json 恢复设置
    try {
      const legacyText = await fs.readFile(
        path.join(app.getPath('userData'), LEGACY_STORE_FILE),
        'utf-8'
      )
      const legacy = JSON.parse(legacyText)
      if (typeof legacy?.settings?.modelsFolder === 'string') {
        settings = normalizeSettings(legacy.settings)
        await updateSettings(settings)
        logger.info(`已从旧版存储恢复应用设置: ${settings.modelsFolder}`)
      }
    } catch {
      settings = defaultSettings()
    }
  }
  return settings
}

/** 获取当前内存中的应用设置 */
export function getSettings() {
  return settings
}

/** 更新应用设置（规范化后立即落盘，原子写入） */
export async function updateSettings(patch) {
  if (!patch) return
  settings = normalizeSettings({ ...settings, ...patch })
  try {
    await atomicWriteFile(getSettingsFilePath(), JSON.stringify(settings, null, 2))
  } catch (err) {
    logger.error(`设置写入失败: ${err.message}`)
  }
}

/* ---------------- 关联存储（按模型根目录） ---------------- */

/** 切换当前关联存储的模型根目录（重置内存数据） */
export function setDataRoot(root) {
  currentRoot = root
  currentRootLower = root ? root.toLowerCase() : null
  data = null
}

/**
 * 加载当前根目录的关联存储数据。
 * store.json 不存在时创建空数据，并尝试从旧版全局存储迁移属于该目录的记录。
 */
export async function loadData() {
  dataReset = false
  if (!currentRoot) {
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
      const normalized = normalizeModelMeta(meta)
      if (!normalized) continue

      // 迁移封面文件：旧版为 %APPDATA% 下的绝对路径
      if (normalized.cover) {
        try {
          const oldAbs = normalized.cover
          await fs.access(oldAbs)
          await fs.mkdir(getCoversDir(), { recursive: true })
          const dest = path.join(getCoversDir(), path.basename(oldAbs))
          await fs.copyFile(oldAbs, dest)
          normalized.cover = `${DATA_DIR}/${COVERS_DIR}/${path.basename(oldAbs).split(path.sep).join('/')}`
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
  if (!data || !currentRoot) return result
  for (const [relKey, meta] of Object.entries(data.models)) {
    result[path.join(currentRoot, relKey)] = meta
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
    saveStoreNow().catch((err) => logger.error(`保存关联存储失败: ${err.message}`))
  }, SAVE_DELAY)
}

/** 立即落盘（原子写入：临时文件 -> 重命名；并发请求排队补写，不会丢失） */
export async function saveStoreNow() {
  if (!data || !currentRoot) return
  if (saving) {
    // 写盘进行中又有新修改：标记待补写，由 finally 在落盘完成后触发补写
    pendingSave = true
    return
  }
  saving = true
  try {
    await atomicWriteFile(getDataFilePath(), JSON.stringify(data, null, 2))
  } catch (err) {
    logger.error(`关联存储写入失败: ${err.message}`)
  } finally {
    saving = false
    if (pendingSave) {
      pendingSave = false
      // 补写读取的是当前最新 data，覆盖写盘期间的任何后续修改
      saveStoreNow().catch((err) => logger.error(`保存关联存储失败: ${err.message}`))
    }
  }
}
