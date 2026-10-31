import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
// A-12 枚举/默认值单一来源（src/shared）：校验集合与渲染层选项共用同一常量
import { MODEL_EXTENSION_SET } from '../../shared/model-extensions'
import {
  SORT_BY_KEYS,
  CARD_SIZE_KEYS,
  VIEW_MODE_KEYS,
  HASH_WARMUP_KEYS,
  NSFW_BLUR_KEYS,
} from '../../shared/app-enums'
import { DEFAULT_SETTINGS } from '../../shared/defaults'
import { atomicWriteFile } from './atomic-write'
import { preserveCorruptedFile, samePathIgnoreCase } from '../utils'
import { notifyStoreSaveError } from './store-events'
import {
  LEGACY_STORE_FILE,
  SETTINGS_FILE,
  getCurrentRoot,
  getLibSettingsFilePath,
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
    savedViews: [...DEFAULT_SETTINGS.savedViews],
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
    autoCheckUpdate: base.autoCheckUpdate,
    hashWarmup: base.hashWarmup,
    hashWarmupConcurrency: base.hashWarmupConcurrency,
    autoBackup: base.autoBackup,
    savedViews: [...base.savedViews],
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
 * 规范化哈希预热并发数（OPT-3）：整数收口到 [1, 4]，非法值回退基准值。
 * 上限 4 与 schema（vInt min 1 max 4）一致：并发收益受磁盘随机读限制，
 * 更高并发只放大内存与句柄占用。
 * @param {unknown} raw 设置原文
 * @param {number} fallback 非法时的回退值（默认设置或旧值）
 * @returns {number} 1-4 的整数
 */
function normalizeHashConcurrency(raw, fallback) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(4, Math.max(1, Math.floor(n)))
}

/**
 * 规范化视图标签筛选（FEAT-01）：
 * - 新数据为 tagFilters 数组；旧数据可能是单个 tagFilter 字符串；
 * - 逐项 trim/截断/去重，最多 20 个。
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
    const tag = item.trim().slice(0, 32)
    if (!tag || out.includes(tag)) continue
    out.push(tag)
    if (out.length >= 20) break
  }
  return out
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
    if (!id || id.length > 40 || !name || name.length > 30 || seen.has(id))
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
      sortBy: SORT_BY_KEYS.has(v.sortBy) ? v.sortBy : 'name',
      sortAsc: typeof v.sortAsc === 'boolean' ? v.sortAsc : true,
    })
    if (out.length >= 20) break
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

/** 规范化引导字段：仅接受 modelsFolder / modelsFolders */
function normalizeBootstrapSettings(raw) {
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
function normalizeSettings(raw) {
  return {
    ...normalizeLibrarySettings(raw),
    ...normalizeBootstrapSettings(raw),
  }
}

/**
 * 规范化多根目录库列表（E7）：当前激活根（modelsFolder）恒保留在首位，
 * 其余条目按传入顺序追加；大小写不敏感去重；非法条目（非字符串/超长/空）剔除。
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

function getSettingsFilePath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE)
}

/** 目标库目录是否可用（O5：离线库跳过库设置写入，避免重建 .modelvault） */
async function isDirectoryAvailable(dir) {
  try {
    return (await fs.stat(dir)).isDirectory()
  } catch {
    return false
  }
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
      // 该库首次打开：以迁移种子（旧版全局设置遗留字段）或默认值初始化并落盘。
      // O5：库目录离线（被移动/盘符未挂载）时只驻内存，不写入（否则 mkdir
      // 会把 .modelvault 重建到已失效的旧路径）
      const seeded = normalizeLibrarySettings(seedRaw)
      if (!(await isDirectoryAvailable(root))) {
        logger.warn(`模型库目录不可用，跳过库设置初始化写入: ${root}`)
        return seeded
      }
      try {
        await enqueueLibraryWrite(root, JSON.stringify(seeded, null, 2))
        if (seedRaw) logger.info(`应用设置已迁移至模型库: ${file}`)
      } catch (writeErr) {
        // 目录只读/磁盘离线等：库文件不落盘，设置本次会话仅内存生效
        logger.warn(`库设置初始化写入失败（仅内存生效）: ${writeErr.message}`)
      }
      return seeded
    }
    // 库设置损坏（如写入中断电、磁盘错误）：备份原文件后重置，保留手动恢复机会
    // （时间戳命名滚动保留，连续损坏不互相覆盖）
    try {
      const backup = await preserveCorruptedFile(file)
      logger.error(
        `库设置文件损坏，原文件已备份为 ${path.basename(backup)} 后重置: ${err.message}`,
      )
    } catch (backupErr) {
      logger.error(
        `库设置加载失败，已重置（备份失败: ${backupErr.message}）: ${err.message}`,
      )
    }
    return defaultLibrarySettings()
  }
}

/** 将引导字段原子写入全局设置文件（精简后的引导层布局） */
async function writeBootstrapFile() {
  await atomicWriteFile(
    getSettingsFilePath(),
    JSON.stringify(bootstrap, null, 2),
  )
}

/**
 * 加载应用设置（双层）：引导层读 %APPDATA%，随后按激活库加载库层设置。
 * 仅应用启动时调用一次，运行期以 getSettings() 读取内存值。
 * 旧版兼容：settings.json 不存在时尝试从旧版 store.json 内嵌 settings 恢复；
 * 全局文件仍为旧版完整布局时，激活库完成种子迁移后自动精简为引导字段。
 */
export async function loadSettings() {
  // OPT-4：先完整冲刷防抖待写再读盘——重入场景（loadStore 链路会在会话中
  // 再次调用本函数）若读到滞后的磁盘，会用陈旧引导层重置内存，把尚未落盘的
  // 激活库/库列表更新静默回滚。无待写时冲刷为立即返回的空操作
  await flushSettingsSave()
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
      // （时间戳命名滚动保留，连续损坏不互相覆盖）
      bootstrap = defaultBootstrapSettings()
      try {
        const backup = await preserveCorruptedFile(getSettingsFilePath())
        logger.error(
          `应用设置文件损坏，原文件已备份为 ${path.basename(backup)} 后重置: ${err.message}`,
        )
      } catch (backupErr) {
        logger.error(
          `应用设置加载失败，已重置（备份失败: ${backupErr.message}）: ${err.message}`,
        )
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
        'utf-8',
      )
      const legacy = JSON.parse(legacyText)
      if (
        typeof legacy?.settings?.modelsFolder === 'string' &&
        legacy.settings.modelsFolder
      ) {
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
    const hasLegacyFields = Object.keys(rawGlobal || {}).some(
      (k) => !BOOTSTRAP_KEYS.has(k),
    )
    if (hasLegacyFields) {
      try {
        await fs.access(getLibSettingsFilePath(bootstrap.modelsFolder))
        await writeBootstrapFile()
        logger.info(
          '全局设置已精简为引导字段（激活库/库列表），其余设置随模型库存储',
        )
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
 * 目录是否属于模型库白名单（B1，单一可信来源）：settings.modelsFolders
 * （上限 20）。列表条目只能经 models:chooseFolder（用户对话框确认）写入；
 * 主进程扫描成功链路只更新已登记库的激活根，不新增条目；settings:update
 * 仅允许激活/移除/重排已登记库，不能再新增根目录。该列表是
 * 「.modelvault 写入点可以指向哪里」的唯一可信来源；渲染进程直接传入的
 * 任意路径不得成为关联存储根。Windows 大小写不敏感比较。
 * （此前 ipc/models/scan.js 与 store.js 各有一份逐字实现——白名单是
 * 安全关键判定，双份实现存在漂移风险，收敛于此。）
 * @param {unknown} dir 目标目录
 * @returns {boolean} 已登记为模型库时为 true
 */
export function isRegisteredLibrary(dir) {
  const list = getSettings().modelsFolders || []
  const lower = String(dir).toLowerCase()
  return list.some((f) => typeof f === 'string' && f.toLowerCase() === lower)
}

/**
 * 设置落盘串行队列（A1）：并发写入依次落盘，最终落盘必为最新合并快照。
 * 单次写失败经监听器上报后队列继续服务后续写入，不被中断。
 * 引导层与库层各自独立排队。
 */
let bootstrapWriteChain = Promise.resolve()
let libraryWriteChain = Promise.resolve()

/** 库/引导层设置写盘防抖窗口（ms，OPT-4）：与元数据侧 SAVE_DELAY 同值 */
const SETTINGS_SAVE_DELAY_MS = 500
/** 防抖最长等待（ms）：持续变更（滑块连点）时保证有限时间内落盘 */
const SETTINGS_SAVE_MAX_WAIT_MS = 2000

/** 防抖窗口（测试可注入小值；0 表示下一个宏任务即冲刷） */
let settingsSaveDelayMs = SETTINGS_SAVE_DELAY_MS

/**
 * 注入设置写盘防抖窗口（仅供单元测试使用；生产代码严禁调用）
 * @param {number} ms 毫秒
 */
export function setSettingsSaveDelayForTests(ms) {
  settingsSaveDelayMs =
    Number.isFinite(ms) && ms >= 0 ? ms : SETTINGS_SAVE_DELAY_MS
}

/**
 * 防抖窗口内待落盘的快照（OPT-4）。快照与 root 均在 updateSettings 的调用
 * 同步段捕获（B-02 语义保持：迟到的落盘只写「本次调用所属库」的内容）；
 * 防抖仅延迟「入队写盘链」的时机：
 * - 引导层全量快照最新者胜（窗口内多次更新合并为一次写）；
 * - 库层按序保留且 root 随条目走——防切库窗口内跨库丢写，同库多条目
 *   由写盘链串行自然「后写覆盖」。
 */
let pendingBootstrapSnapshot = null
const pendingLibrarySaves = []
let settingsSaveTimer = null
let firstPendingAt = 0

/** 是否仍有未入队的待写快照 */
function hasPendingSettingsSaves() {
  return pendingBootstrapSnapshot !== null || pendingLibrarySaves.length > 0
}

/** 安排防抖冲刷（重复调用顺延，但受最长等待约束保证前进） */
function scheduleSettingsSaveFlush() {
  const now = Date.now()
  if (!firstPendingAt) firstPendingAt = now
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer)
  const elapsed = now - firstPendingAt
  const delay = Math.max(
    0,
    Math.min(settingsSaveDelayMs, SETTINGS_SAVE_MAX_WAIT_MS - elapsed),
  )
  settingsSaveTimer = setTimeout(() => {
    settingsSaveTimer = null
    flushPendingSettingsSaves()
  }, delay)
  settingsSaveTimer.unref?.()
}

/** 立即将全部待写快照入队写盘链（flushSettingsSave/防抖到期共用） */
function flushPendingSettingsSaves() {
  if (settingsSaveTimer) {
    clearTimeout(settingsSaveTimer)
    settingsSaveTimer = null
  }
  firstPendingAt = 0
  const bootstrapSnapshot = pendingBootstrapSnapshot
  pendingBootstrapSnapshot = null
  if (bootstrapSnapshot) {
    notifySaveFailure(enqueueBootstrapWrite(bootstrapSnapshot))
  }
  const librarySaves = pendingLibrarySaves.splice(0)
  if (librarySaves.length > 0) {
    // 同根多条目合并为最新一份（全量快照，旧份严格过时）；跨根保持先后
    // 顺序（Map 插入序，原地更新 snapshot 不改变次序）
    const latestByRoot = new Map()
    for (const save of librarySaves) {
      const key = save.root.toLowerCase()
      const prev = latestByRoot.get(key)
      if (prev) prev.snapshot = save.snapshot
      else latestByRoot.set(key, { root: save.root, snapshot: save.snapshot })
    }
    for (const { root, snapshot } of latestByRoot.values()) {
      notifySaveFailure(enqueueLibraryWrite(root, snapshot))
    }
  }
}

/** 写失败经监听器通知渲染进程（C7）——防抖路径无调用方等待，通知随任务挂接 */
function notifySaveFailure(task) {
  task.catch((err) => {
    notifyStoreSaveError(
      Object.assign(new Error(`设置保存失败: ${err.message}`)),
    )
  })
}

/** 将引导层快照排入写盘链（唯一的引导层写入通道，与库层同一串行化语义） */
function enqueueBootstrapWrite(snapshot) {
  const task = bootstrapWriteChain.then(() =>
    atomicWriteFile(getSettingsFilePath(), snapshot),
  )
  bootstrapWriteChain = task.catch(() => {})
  return task
}

/**
 * 等待设置写盘链完全静止（B-02）：
 * 切库、备份导出/恢复、退出等需要「磁盘已是最新设置」的场景调用。
 * 先冲刷防抖窗口内尚未入队的待写快照，再循环比较链引用——覆盖等待期间
 * 又有新写入入队（或新待写产生）的情况。
 */
export async function flushSettingsSave() {
  for (;;) {
    flushPendingSettingsSaves()
    const bootstrapTask = bootstrapWriteChain
    const libraryTask = libraryWriteChain
    // 两条链在入队时已 catch（失败经监听器上报），此处等待不会 reject
    await Promise.all([bootstrapTask, libraryTask])
    if (
      bootstrapTask === bootstrapWriteChain &&
      libraryTask === libraryWriteChain &&
      !hasPendingSettingsSaves()
    )
      return
  }
}

/**
 * 将库设置文本排入库层写盘链（唯一的库设置写入通道）。
 * @param {string} root 目标库根目录
 * @param {string} text 已序列化的设置快照
 * @returns {Promise<void>} 本次写入完成（失败时 reject，链本身继续服务后续写入）
 */
function enqueueLibraryWrite(root, text) {
  const task = libraryWriteChain.then(async () => {
    // O5：执行时再次确认库目录可用（排队期间可能被移动/卸载）；
    // 抛出后由 updateSettings 统一经 notifyStoreSaveError 告知用户
    if (!(await isDirectoryAvailable(root))) {
      throw new Error(`模型库目录不可用，已跳过设置落盘: ${root}`)
    }
    const file = getLibSettingsFilePath(root)
    try {
      // 非递归 mkdir：库根离线时返回 ENOENT，绝不重建根目录树
      await fs.mkdir(path.dirname(file))
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    await atomicWriteFile(file, text, { createDirs: false })
  })
  libraryWriteChain = task.catch(() => {})
  return task
}

/**
 * 更新应用设置（规范化后按层拆分，内存即时生效，落盘经防抖合并）：
 * - 内存：规范化结果与当前内存逐层比对，有变化才替换（getSettings 立即可见）；
 * - 变更检测（OPT-4）：纯重复更新（同一设置重复提交、规范化幂等回退）零磁盘
 *   IO、不入防抖队列——主题/排序/卡片尺寸等连续切换不再逐次触发全量
 *   「mkdir + tmp + fsync + rename」；
 * - 防抖（OPT-4）：短窗口内的多次更新合并为一次落盘（与元数据侧 SAVE_DELAY
 *   同值 500ms，持续变更受最长等待约束保证前进）；快照与 root 仍在调用
 *   同步段捕获（B-02），迟到的落盘只写「本次调用所属库」的内容；
 * - 引导字段 → %APPDATA%/modelvault/settings.json；库字段 →
 *   <当前模型根目录>/.modelvault/settings.json（无激活根时仅内存生效，
 *   首次选库扫描后经库设置初始化落盘）。切库/备份/退出经 flushSettingsSave
 *   冲刷待写快照，落盘时机语义与防抖前一致。
 */
export async function updateSettings(patch) {
  if (!patch || typeof patch !== 'object') return
  // 合并规范化（单一校验入口）
  const merged = normalizeSettings({ ...getSettings(), ...patch })
  const nextBootstrap = normalizeBootstrapSettings(merged)
  const nextLibrary = normalizeLibrarySettings(merged)

  const touchesBootstrap = 'modelsFolder' in patch || 'modelsFolders' in patch
  const touchesLibrary = Object.keys(patch).some((k) => !BOOTSTRAP_KEYS.has(k))

  if (touchesBootstrap) {
    const snapshot = JSON.stringify(nextBootstrap, null, 2)
    if (snapshot !== JSON.stringify(bootstrap, null, 2)) {
      bootstrap = nextBootstrap
      pendingBootstrapSnapshot = snapshot
      scheduleSettingsSaveFlush()
    }
  }
  if (touchesLibrary) {
    // 调度时立即序列化快照（B-02）：执行时求值会读取可能已被切库/重载替换的
    // 全局 library，导致旧库补丁写入新库。快照 + root 均在同步段捕获，
    // 队列任务只写「本次调用所属库」的内容
    const snapshot = JSON.stringify(nextLibrary, null, 2)
    if (snapshot !== JSON.stringify(library, null, 2)) {
      library = nextLibrary
      const libraryRoot = getCurrentRoot()
      if (libraryRoot) {
        pendingLibrarySaves.push({ root: libraryRoot, snapshot })
        scheduleSettingsSaveFlush()
      }
    }
  }
}

/**
 * 重载指定根目录的库设置到内存（切库/备份恢复到当前库后调用）：
 * 读取该库的 .modelvault/settings.json；文件不存在时以默认值初始化并落盘，
 * 损坏时备份为带时间戳的 .bak（滚动保留最近 3 份）后以默认值重置。root 为
 * 空时内存回退默认值。
 * @param {string|null} root 模型根目录绝对路径
 */
export async function reloadLibrarySettings(root) {
  // 先静止旧库写盘链（B-02）：排队中的补丁都携带旧库快照，必须写完再切换内存视图，
  // 避免重载后的新库设置立刻被旧任务覆盖
  await flushSettingsSave()
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
  // 与 updateSettings 共用同一条写盘链（B-02）：备份恢复写入库设置时，
  // 若与在途的设置更新并发，共享临时文件会互相打断或让旧快照后落盘
  const snapshot = JSON.stringify(normalized, null, 2)
  await enqueueLibraryWrite(root, snapshot)
  const active = getCurrentRoot()
  if (root && active && samePathIgnoreCase(root, active)) {
    library = normalized
  }
  return normalized
}
