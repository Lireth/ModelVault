import { MODEL_EXTENSION_SET } from '../../shared/model-extensions'
import {
  CARD_SIZE_KEYS,
  HASH_WARMUP_KEYS,
  MAX_SAVED_VIEW_NAME,
  MAX_SAVED_VIEWS,
  MAX_TAG_LEN,
  MAX_VIEW_TAG_FILTERS,
  MAX_WARMUP_CONCURRENCY,
  MIN_WARMUP_CONCURRENCY,
  NSFW_BLUR_KEYS,
  SORT_BY_KEYS,
  VIEW_MODE_KEYS,
} from '../../shared/app-enums'
import { DEFAULT_SETTINGS, LIBRARY_SETTING_KEYS } from '../../shared/defaults'

/**
 * 应用设置的纯规范化层（自 store-settings.js 拆出，无模块状态）：
 * 默认值构造、旧版字段迁移、类型/枚举/长度收口。主进程加载/保存与备份
 * 恢复均经此入口，保证磁盘、内存与导入数据遵循同一套规则。
 */

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

/** 默认应用设置（A-12 单一来源：src/shared/defaults.js；返回可变副本） */
function defaultSettings() {
  return {
    ...DEFAULT_SETTINGS,
    scanExtensions: [...DEFAULT_SETTINGS.scanExtensions],
    savedViews: [...DEFAULT_SETTINGS.savedViews],
  }
}

/** 默认引导设置 */
export function defaultBootstrapSettings() {
  return { modelsFolder: '', modelsFolders: [] }
}

/**
 * 默认库设置（默认设置剔除引导字段，数组字段取独立副本）：
 * 字段清单来自 shared/defaults.LIBRARY_SETTING_KEYS，新增设置项无需在此
 * 复制一份，避免「DEFAULT_SETTINGS 加了、库层默认值漏加」的静默丢失。
 */
export function defaultLibrarySettings() {
  const base = defaultSettings()
  const out = {}
  for (const key of LIBRARY_SETTING_KEYS) {
    const value = base[key]
    out[key] = Array.isArray(value) ? [...value] : value
  }
  return out
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
 * 规范化哈希预热并发数（OPT-3）：整数收口到 shared/app-enums 定义的区间，
 * 非法值回退基准值。并发收益受磁盘随机读限制，更高并发只放大内存与句柄占用。
 * @param {unknown} raw 设置原文
 * @param {number} fallback 非法时的回退值（默认设置或旧值）
 * @returns {number} 合法区间内的整数
 */
function normalizeHashConcurrency(raw, fallback) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(
    MAX_WARMUP_CONCURRENCY,
    Math.max(MIN_WARMUP_CONCURRENCY, Math.floor(n)),
  )
}

/**
 * 规范化视图标签筛选（FEAT-01）：
 * - 新数据为 tagFilters 数组；旧数据可能是单个 tagFilter 字符串；
 * - 逐项 trim/截断/去重，最多 MAX_VIEW_TAG_FILTERS 个。
 * @param {unknown} raw tagFilters 数组或旧 tagFilter 字符串
 * @returns {string[]}
 */
function normalizeViewTagFilters(raw) {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string' && raw
      ? [raw]
      : []
  const out = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const tag = item.trim().slice(0, MAX_TAG_LEN)
    if (!tag || out.includes(tag)) continue
    out.push(tag)
    if (out.length >= MAX_VIEW_TAG_FILTERS) break
  }
  return out
}

/**
 * 规范化智能视图列表（组合筛选收藏）：
 * 逐字段类型/长度校验（typeFilter/subFilter 不做枚举校验——非法值在渲染层
 * 仅表现为空筛选结果，无害；枚举单一来源在渲染层侧），id 去重，上限
 * MAX_SAVED_VIEWS 个。
 * @param {unknown} raw 原始视图数组
 * @returns {object[]}
 */
function normalizeSavedViews(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue
    const id = typeof v.id === 'string' ? v.id.trim() : ''
    const name = typeof v.name === 'string' ? v.name.trim() : ''
    if (
      !id ||
      id.length > 40 ||
      !name ||
      name.length > MAX_SAVED_VIEW_NAME ||
      seen.has(id)
    )
      continue
    seen.add(id)
    out.push({
      id,
      name,
      search: typeof v.search === 'string' ? v.search.slice(0, 100) : '',
      typeFilter:
        typeof v.typeFilter === 'string' ? v.typeFilter.slice(0, 20) : 'all',
      subFilter:
        typeof v.subFilter === 'string' ? v.subFilter.slice(0, 50) : '',
      // 基底模型家族筛选（F-2）：旧视图缺省时为 ''（全部）
      baseFilter:
        typeof v.baseFilter === 'string' ? v.baseFilter.slice(0, 20) : '',
      // 自由标签筛选（F-5/FEAT-01）：新字段为数组；旧视图单字符串迁移
      tagFilters: normalizeViewTagFilters(v.tagFilters ?? v.tagFilter),
      showFavoritesOnly: v.showFavoritesOnly === true,
      // 重复模型筛选（FEAT-1）：旧视图缺省该字段时为 false
      showDuplicatesOnly: v.showDuplicatesOnly === true,
      // 疑似损坏筛选（FEAT-01）：旧视图缺省该字段时为 false
      showSuspectOnly: v.showSuspectOnly === true,
      sortBy: SORT_BY_KEYS.has(v.sortBy) ? v.sortBy : 'name',
      sortAsc: typeof v.sortAsc === 'boolean' ? v.sortAsc : true,
    })
    if (out.length >= MAX_SAVED_VIEWS) break
  }
  return out
}

/**
 * 规范化 NSFW 模糊样式（off/blur/heavy）：
 * - 旧版布尔值迁移：true → blur（原「开启模糊」），false → off（原「关闭」）；
 * - 枚举字符串校验，非法值回退基准值（默认「模糊」）。
 * @param {unknown} raw 设置原文
 * @param {string} fallback 非法时的回退值（默认设置或旧值）
 * @returns {string} off / blur / heavy
 */
function normalizeNsfwBlur(raw, fallback) {
  if (raw === true) return 'blur'
  if (raw === false) return 'off'
  return typeof raw === 'string' && NSFW_BLUR_KEYS.has(raw) ? raw : fallback
}

/**
 * 规范化多根目录库列表（E7）：当前激活根（modelsFolder）恒保留在首位，
 * 其余条目按传入顺序追加；大小写不敏感去重；非法条目（非字符串/超长/空）剔除。
 * @param {unknown} rawFolders 原始库列表
 * @param {unknown} modelsFolder 激活库
 * @returns {string[]}
 */
function normalizeModelsFolders(rawFolders, modelsFolder) {
  const primary = typeof modelsFolder === 'string' ? modelsFolder.trim() : ''
  const list = Array.isArray(rawFolders)
    ? rawFolders.filter(
        (f) => typeof f === 'string' && f.trim() && f.length <= 500,
      )
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

/** 规范化引导字段：仅接受 modelsFolder / modelsFolders */
export function normalizeBootstrapSettings(raw) {
  return {
    modelsFolder: typeof raw?.modelsFolder === 'string' ? raw.modelsFolder : '',
    // 多根目录库列表（E7）：与 modelsFolder 取并集（当前根恒在列，防误删激活库），
    // Windows 大小写不敏感去重，上限 20 个
    modelsFolders: normalizeModelsFolders(
      raw?.modelsFolders,
      raw?.modelsFolder,
    ),
  }
}

/** 规范化库字段：仅接受已知字段并校验类型（引导字段一律剔除，恢复/导入安全） */
export function normalizeLibrarySettings(raw) {
  const base = defaultLibrarySettings()
  if (!raw || typeof raw !== 'object') return base
  const excludeDirs = Array.isArray(raw.excludeDirs)
    ? [
        ...new Set(
          raw.excludeDirs
            .filter((d) => typeof d === 'string')
            // 统一小写：scanner 以小写目录名匹配（Windows 不区分大小写），去重亦随之不区分大小写
            .map((d) => d.trim().toLowerCase())
            .filter((d) => d && d.length <= 100),
        ),
      ].slice(0, 100)
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
    showMtime:
      typeof raw.showMtime === 'boolean' ? raw.showMtime : base.showMtime,
    showParams:
      typeof raw.showParams === 'boolean' ? raw.showParams : base.showParams,
    civitaiEnabled: raw.civitaiEnabled !== false,
    // NSFW 模糊样式（off/blur/heavy）：旧版为布尔值（true=模糊/false=关闭），
    // 读到布尔时迁移为对应样式；非法值回退默认「模糊」
    nsfwBlur: normalizeNsfwBlur(raw.nsfwBlur, base.nsfwBlur),
    // 隐藏 NSFW 模型开关：缺省视为关闭
    hideNsfwModels: raw.hideNsfwModels === true,
    autoRescan: raw.autoRescan === true,
    // 启动自动检查更新（O-3）：缺省视为开启（与 civitaiEnabled 同款默认真语义）
    autoCheckUpdate: raw.autoCheckUpdate !== false,
    hashWarmup: HASH_WARMUP_KEYS.has(raw.hashWarmup)
      ? raw.hashWarmup
      : base.hashWarmup,
    // 哈希预热并发数（OPT-3）：非法/越界回退基准值（默认 1，串行）
    hashWarmupConcurrency: normalizeHashConcurrency(
      raw.hashWarmupConcurrency,
      base.hashWarmupConcurrency,
    ),
    // 自动定期元数据备份（OPT-07）：缺省视为开启（默认真语义）
    autoBackup: raw.autoBackup !== false,
    savedViews: normalizeSavedViews(raw.savedViews),
  }
}

/** 规范化合并设置（内存统一入口）：库字段 + 引导字段 */
export function normalizeSettings(raw) {
  return {
    ...normalizeLibrarySettings(raw),
    ...normalizeBootstrapSettings(raw),
  }
}
