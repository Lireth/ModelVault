import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
// A-12 枚举/默认值单一来源（src/shared）：校验集合与渲染层选项共用同一常量
import { MODEL_EXTENSION_SET } from '../../shared/model-extensions'
import { SORT_BY_KEYS, CARD_SIZE_KEYS, VIEW_MODE_KEYS } from '../../shared/app-enums'
import { DEFAULT_SETTINGS } from '../../shared/defaults'
import { atomicWriteFile } from './atomic-write'
import { notifyStoreSaveError } from './store-events'
import {
  LEGACY_STORE_FILE,
  SETTINGS_FILE,
  LIB_SETTINGS_FILE,
  getCurrentRoot,
  getLibSettingsFilePath
} from './store-paths'

/**
 * 应用设置（C2 自 store.js 拆出）——双层存储：
 *
 * 设置随模型库走（库层）+ 引导字段随系统（引导层）：
 * - 引导层 %APPDATA%/modelvault/settings.json：仅 modelsFolder（激活库）与
 *   modelsFolders（库列表）。这两项无法存在某个库内部——尚未找到库时读不到
 *   列表（引导悖论），必须留在系统目录作为启动引导。
 * - 库层 <模型根目录>/.modelvault/settings.json：其余全部字段（主题/外观/
 *   扫描/浏览/智能视图等）。库文件随模型文件夹移动/复制，换机器打开即恢复
 *   完整配置；每个库相互独立。
 *
 * 内存中保持双态（bootstrap + library），getSettings() 对外返回合并视图，
 * 既有消费方（扫描/窗口主题/备份）的读取 API 与行为不变。
 *
 * 旧版迁移：settings.json 曾承载全部字段。启动加载时若库设置文件不存在，
 * 以全局文件（或旧版 store.json 内嵌 settings）的字段为种子初始化当前激活库，
 * 随后将全局文件原子精简为仅引导字段；其余库在首次切换时以默认值初始化。
 */

/** 引导字段（随系统留存 %APPDATA%，不写入任何库文件） */
const BOOTSTRAP_KEYS = new Set(['modelsFolder', 'modelsFolders'])

/** 应用设置允许的主题取值（system 由渲染层解析为有效亮/暗后应用） */
const VALID_THEMES = new Set(['dark', 'light', 'system'])

/** 强调色取值：预设 key（短字符串，渲染层解析未知值回退默认）或 #rrggbb 自定义色 */
const ACCENT_COLOR_RE = /^#[0-9a-fA-F]{6}$/

/** 规范化强调色：预设 key（≤20 字符）或自定义 hex，其余回退默认 */
function normalizeAccentColor(raw) {
  if (typeof raw !== 'string') return DEFAULT_SETTINGS.accentColor
  const v = raw.trim()
  if (ACCENT_COLOR_RE.test(v)) return v.toLowerCase()
  if (v && v.length <= 20 && !v.includes('#')) return v
  return DEFAULT_SETTINGS.accentColor
}

/** 内存中的引导设置（modelsFolder / modelsFolders） */
let bootstrap = null

/** 内存中的当前库设置（除引导字段外的全部设置，随模型根目录切换） */
let library = null

/** 默认应用设置（A-12 单一来源：src/shared/defaults.js；返回可变副本） */
function defaultSettings() {
  return {
    ...DEFAULT_SETTINGS,
    scanExtensions: [...DEFAULT_SETTINGS.scanExtensions],
    savedViews: [...DEFAULT_SETTINGS.savedViews]
  }
}

/** 默认引导设置 */
function defaultBootstrapSettings() {
  return { modelsFolder: '', modelsFolders: [] }
}

/** 默认库设置（默认设置剔除引导字段，数组字段取独立副本） */
function defaultLibrarySettings() {
  const base = defaultSettings()
  return {
    autoScan: base.autoScan,
    excludeDirs: [...base.excludeDirs],
    theme: base.theme,
    accentColor: base.accentColor,
    cardSize: base.cardSize,
    viewMode: base.viewMode,
    sortBy: base.sortBy,
    sortAsc: base.sortAsc,
    scanExtensions: [...base.scanExtensions],
    showSize: base.showSize,
    showMtime: base.showMtime,
    showParams: base.showParams,
    civitaiEnabled: base.civitaiEnabled,
    nsfwBlur: base.nsfwBlur,
    autoRescan: base.autoRescan,
    savedViews: [...base.savedViews]
  }
}

/** 规范化扩展名列表：仅接受已知扩展名并去重；为空时回退到全部 */
function normalizeExtensions(raw) {
  const list = Array.isArray(raw)
    ? raw
        .filter((e) => typeof e === 'string')
        .map((e) => e.trim().toLowerCase())
        .filter((e) => MODEL_EXTENSION_SET.has(e))
    : []
  const unique = [...new Set(list)]
  return unique.length > 0 ? unique : [...MODEL_EXTENSION_SET]
}

/**
 * 规范化智能视图列表（组合筛选收藏）：
 * 逐字段类型/长度校验（typeFilter/subFilter 不做枚举校验——非法值在渲染层
 * 仅表现为空筛选结果，无害；枚举单一来源在渲染层侧），id 去重，上限 20 个。
 */
function normalizeSavedViews(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue
    const id = typeof v.id === 'string' ? v.id.trim() : ''
    const name = typeof v.name === 'string' ? v.name.trim() : ''
    if (!id || id.length > 40 || !name || name.length > 30 || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name,
      search: typeof v.search === 'string' ? v.search.slice(0, 100) : '',
      typeFilter: typeof v.typeFilter === 'string' ? v.typeFilter.slice(0, 20) : 'all',
      subFilter: typeof v.subFilter === 'string' ? v.subFilter.slice(0, 50) : '',
      // 基底模型家族筛选（F-2）：旧视图缺省时为 ''（全部）
      baseFilter: typeof v.baseFilter === 'string' ? v.baseFilter.slice(0, 20) : '',
      // 自由标签筛选（F-5）：旧视图缺省时为 ''（全部）
      tagFilter: typeof v.tagFilter === 'string' ? v.tagFilter.slice(0, 32) : '',
      showFavoritesOnly: v.showFavoritesOnly === true,
      // 重复模型筛选（FEAT-1）：旧视图缺省该字段时为 false
      showDuplicatesOnly: v.showDuplicatesOnly === true,
      sortBy: SORT_BY_KEYS.has(v.sortBy) ? v.sortBy : 'name',
      sortAsc: typeof v.sortAsc === 'boolean' ? v.sortAsc : true
    })
    if (out.length >= 20) break
  }
  return out
}

/** 规范化引导字段：仅接受 modelsFolder / modelsFolders */
function normalizeBootstrapSettings(raw) {
  return {
    modelsFolder: typeof raw?.modelsFolder === 'string' ? raw.modelsFolder : '',
    // 多根目录库列表（E7）：与 modelsFolder 取并集（当前根恒在列，防误删激活库），
    // Windows 大小写不敏感去重，上限 20 个
    modelsFolders: normalizeModelsFolders(raw?.modelsFolders, raw?.modelsFolder)
  }
}

/** 规范化库字段：仅接受已知字段并校验类型（引导字段一律剔除，恢复/导入安全） */
export function normalizeLibrarySettings(raw) {
  const base = defaultLibrarySettings()
  if (!raw || typeof raw !== 'object') return base
  const excludeDirs = Array.isArray(raw.excludeDirs)
    ? [...new Set(
        raw.excludeDirs
          .filter((d) => typeof d === 'string')
          // 统一小写：scanner 以小写目录名匹配（Windows 不区分大小写），去重亦随之不区分大小写
          .map((d) => d.trim().toLowerCase())
          .filter((d) => d && d.length <= 100)
      )].slice(0, 100)
    : base.excludeDirs
  return {
    autoScan: typeof raw.autoScan === 'boolean' ? raw.autoScan : base.autoScan,
    excludeDirs,
    theme: VALID_THEMES.has(raw.theme) ? raw.theme : base.theme,
    accentColor: normalizeAccentColor(raw.accentColor),
    cardSize: CARD_SIZE_KEYS.has(raw.cardSize) ? raw.cardSize : base.cardSize,
    viewMode: VIEW_MODE_KEYS.has(raw.viewMode) ? raw.viewMode : base.viewMode,
    sortBy: SORT_BY_KEYS.has(raw.sortBy) ? raw.sortBy : base.sortBy,
    sortAsc: typeof raw.sortAsc === 'boolean' ? raw.sortAsc : base.sortAsc,
    scanExtensions: normalizeExtensions(raw.scanExtensions),
    showSize: typeof raw.showSize === 'boolean' ? raw.showSize : base.showSize,
    showMtime: typeof raw.showMtime === 'boolean' ? raw.showMtime : base.showMtime,
    showParams: typeof raw.showParams === 'boolean' ? raw.showParams : base.showParams,
    civitaiEnabled: raw.civitaiEnabled !== false,
    nsfwBlur: raw.nsfwBlur !== false,
    autoRescan: raw.autoRescan === true,
    savedViews: normalizeSavedViews(raw.savedViews)
  }
}

/** 规范化合并设置（内存统一入口）：库字段 + 引导字段 */
function normalizeSettings(raw) {
  return { ...normalizeLibrarySettings(raw), ...normalizeBootstrapSettings(raw) }
}

/**
 * 规范化多根目录库列表（E7）：当前激活根（modelsFolder）恒保留在首位，
 * 其余条目按传入顺序追加；大小写不敏感去重；非法条目（非字符串/超长/空）剔除。
 */
function normalizeModelsFolders(rawFolders, modelsFolder) {
  const primary = typeof modelsFolder === 'string' ? modelsFolder.trim() : ''
  const list = Array.isArray(rawFolders)
    ? rawFolders.filter((f) => typeof f === 'string' && f.trim() && f.length <= 500)
    : []
  const result = []
  const seen = new Set()
  for (const f of [primary, ...list]) {
    const trimmed = typeof f === 'string' ? f.trim() : ''
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(trimmed)
    if (result.length >= 20) break
  }
  return result
}

function getSettingsFilePath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE)
}

/** 加载指定根目录的库设置文件（.modelvault/settings.json）。
 * @param {string} root 模型根目录绝对路径
 * @param {object|null} [seedRaw] 首次初始化种子（旧版全局设置的遗留字段；空则用默认值）
 * @returns {Promise<object>} 规范化后的库设置（仅内存，不写引导层）
 */
async function loadLibrarySettings(root, seedRaw = null) {
  const file = getLibSettingsFilePath(root)
  try {
    const text = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('根节点不是 JSON 对象')
    }
    return normalizeLibrarySettings(parsed)
  } catch (err) {
    if (err.code === 'ENOENT') {
      // 该库首次打开：以迁移种子（旧版全局设置遗留字段）或默认值初始化并落盘
      const seeded = normalizeLibrarySettings(seedRaw)
      try {
        await atomicWriteFile(file, JSON.stringify(seeded, null, 2))
        if (seedRaw) logger.info(`应用设置已迁移至模型库: ${file}`)
      } catch (writeErr) {
        // 目录只读/磁盘离线等：库文件不落盘，设置本次会话仅内存生效
        logger.warn(`库设置初始化写入失败（仅内存生效）: ${writeErr.message}`)
      }
      return seeded
    }
    // 库设置损坏（如写入中断电、磁盘错误）：备份原文件后重置，保留手动恢复机会
    try {
      await fs.rename(file, `${file}.bak`)
      logger.error(`库设置文件损坏，原文件已备份为 ${LIB_SETTINGS_FILE}.bak 后重置: ${err.message}`)
    } catch (backupErr) {
      logger.error(`库设置加载失败，已重置（备份失败: ${backupErr.message}）: ${err.message}`)
    }
    return defaultLibrarySettings()
  }
}

/** 将引导字段原子写入全局设置文件（精简后的引导层布局） */
async function writeBootstrapFile() {
  await atomicWriteFile(getSettingsFilePath(), JSON.stringify(bootstrap, null, 2))
}

/**
 * 加载应用设置（双层）：引导层读 %APPDATA%，随后按激活库加载库层设置。
 * 仅应用启动时调用一次，运行期以 getSettings() 读取内存值。
 * 旧版兼容：settings.json 不存在时尝试从旧版 store.json 内嵌 settings 恢复；
 * 全局文件仍为旧版完整布局时，激活库完成种子迁移后自动精简为引导字段。
 */
export async function loadSettings() {
  let rawGlobal = null
  let globalCorrupt = false
  try {
    const text = await fs.readFile(getSettingsFilePath(), 'utf-8')
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('根节点不是 JSON 对象')
    }
    rawGlobal = parsed
  } catch (err) {
    if (err.code !== 'ENOENT') {
      globalCorrupt = true
      // settings.json 损坏：备份原文件后重置，保留手动恢复机会
      bootstrap = defaultBootstrapSettings()
      try {
        await fs.rename(getSettingsFilePath(), `${getSettingsFilePath()}.bak`)
        logger.error(`应用设置文件损坏，原文件已备份为 ${SETTINGS_FILE}.bak 后重置: ${err.message}`)
      } catch (backupErr) {
        logger.error(`应用设置加载失败，已重置（备份失败: ${backupErr.message}）: ${err.message}`)
      }
    }
  }

  if (rawGlobal) {
    bootstrap = normalizeBootstrapSettings(rawGlobal)
  } else if (!globalCorrupt) {
    bootstrap = defaultBootstrapSettings()
    // settings.json 不存在：尝试从旧版 store.json 恢复设置
    try {
      const legacyText = await fs.readFile(
        path.join(app.getPath('userData'), LEGACY_STORE_FILE),
        'utf-8'
      )
      const legacy = JSON.parse(legacyText)
      if (typeof legacy?.settings?.modelsFolder === 'string' && legacy.settings.modelsFolder) {
        bootstrap = normalizeBootstrapSettings(legacy.settings)
        rawGlobal = legacy.settings
        logger.info(`已从旧版存储恢复应用设置: ${bootstrap.modelsFolder}`)
      }
    } catch {
      /* 无旧版数据，使用默认值 */
    }
  }

  if (bootstrap.modelsFolder) {
    // 已设置目录不存在（磁盘离线/被移动）时库设置以默认值驻内存，不落盘、不迁移
    library = await loadLibrarySettings(bootstrap.modelsFolder, rawGlobal)
    // 旧版布局迁移收尾：激活库文件已生成后，将全局文件精简为仅引导字段
    // （旧值已迁入库文件；库文件写入失败时保留全局原样，下次启动重试迁移）
    const hasLegacyFields = Object.keys(rawGlobal || {}).some((k) => !BOOTSTRAP_KEYS.has(k))
    if (hasLegacyFields) {
      try {
        await fs.access(getLibSettingsFilePath(bootstrap.modelsFolder))
        await writeBootstrapFile()
        logger.info('全局设置已精简为引导字段（激活库/库列表），其余设置随模型库存储')
      } catch {
        /* 库文件尚未生成，保留全局文件作为下次迁移种子 */
      }
    }
  } else if (getCurrentRoot()) {
    // 引导层尚无激活库但内存中已有生效根目录（loadStore 重入等场景）：
    // 库设置跟随当前激活根加载，避免把已生效的库设置重置为默认值
    library = await loadLibrarySettings(getCurrentRoot())
  } else {
    library = defaultLibrarySettings()
  }
  return getSettings()
}

/** 获取当前内存中的应用设置（引导层 + 当前库的合并视图） */
export function getSettings() {
  // loadSettings 之前防御性返回默认值（正常启动时序下不会走到）
  if (!bootstrap) bootstrap = defaultBootstrapSettings()
  if (!library) library = defaultLibrarySettings()
  return { ...library, ...bootstrap }
}

/** 获取当前库设置（不含引导字段；备份导出用——备份不得携带库列表/激活库） */
export function getLibrarySettings() {
  if (!library) library = defaultLibrarySettings()
  return library
}

/**
 * 设置落盘串行队列（A1）：并发 updateSettings 依次写盘，
 * 最终落盘必为最新合并快照。单次写失败经监听器上报后队列继续服务
 * 后续写入，不被中断。引导层与库层各自独立排队。
 */
let bootstrapWriteChain = Promise.resolve()
let libraryWriteChain = Promise.resolve()

/**
 * 更新应用设置（规范化后按层拆分落盘，原子写入）：
 * - 引导字段 → %APPDATA%/modelvault/settings.json
 * - 库字段 → <当前模型根目录>/.modelvault/settings.json（无激活根时仅内存生效，
 *   首次选库扫描后经库设置初始化落盘）
 */
export async function updateSettings(patch) {
  if (!patch || typeof patch !== 'object') return
  // 合并规范化（单一校验入口），再按层拆分内存态
  const merged = normalizeSettings({ ...getSettings(), ...patch })
  bootstrap = normalizeBootstrapSettings(merged)
  library = normalizeLibrarySettings(merged)

  const touchesBootstrap = 'modelsFolder' in patch || 'modelsFolders' in patch
  const touchesLibrary = Object.keys(patch).some((k) => !BOOTSTRAP_KEYS.has(k))

  // 序列化在执行时求值：即使写盘期间又有新补丁合并进内存，本次落盘即为最新快照
  const tasks = []
  if (touchesBootstrap) {
    const task = bootstrapWriteChain.then(() =>
      atomicWriteFile(getSettingsFilePath(), JSON.stringify(bootstrap, null, 2))
    )
    bootstrapWriteChain = task.catch(() => {})
    tasks.push(task)
  }
  if (touchesLibrary) {
    const root = getCurrentRoot()
    if (root) {
      const task = libraryWriteChain.then(() =>
        atomicWriteFile(getLibSettingsFilePath(root), JSON.stringify(library, null, 2))
      )
      libraryWriteChain = task.catch(() => {})
      tasks.push(task)
    }
  }
  for (const task of tasks) {
    try {
      await task
    } catch (err) {
      // 设置落盘失败与元数据同样经监听器通知渲染进程（C7）：
      // 否则磁盘满/权限错误时用户无感知，重启后设置静默丢失
      notifyStoreSaveError(Object.assign(new Error(`设置保存失败: ${err.message}`)))
    }
  }
}

/**
 * 重载指定根目录的库设置到内存（切库/备份恢复到当前库后调用）：
 * 读取该库的 .modelvault/settings.json；文件不存在时以默认值初始化并落盘，
 * 损坏时备份 .bak 后以默认值重置。root 为空时内存回退默认值。
 * @param {string|null} root 模型根目录绝对路径
 */
export async function reloadLibrarySettings(root) {
  library = root ? await loadLibrarySettings(root) : defaultLibrarySettings()
}

/**
 * 保存库设置到指定根目录（备份导入的设置-only 路径使用）：
 * 规范化后原子写入该库的 .modelvault/settings.json；目标为当前激活库时
 * 同步更新内存，使本次会话立即生效。
 * @param {string} root 模型根目录绝对路径
 * @param {object} raw 原始库设置（引导字段被自动剔除）
 * @returns {Promise<object>} 规范化后的库设置
 */
export async function saveLibrarySettings(root, raw) {
  const normalized = normalizeLibrarySettings(raw)
  await atomicWriteFile(getLibSettingsFilePath(root), JSON.stringify(normalized, null, 2))
  const active = getCurrentRoot()
  if (root && active && root.toLowerCase() === active.toLowerCase()) {
    library = normalized
  }
  return normalized
}
