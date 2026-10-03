import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
// 扫描扩展名单一来源：直接复用 scanner.js 的 MODEL_EXTENSIONS，
// 避免双份常量人工同步漂移导致「设置校验」与「实际扫描」不一致（C3）
import { MODEL_EXTENSIONS } from './scanner'
import { atomicWriteFile } from './atomic-write'
import { notifyStoreSaveError } from './store-events'
import { LEGACY_STORE_FILE, SETTINGS_FILE } from './store-paths'

/**
 * 应用设置（C2 自 store.js 拆出）：
 * settings.json 的加载/规范化/更新。启动时经 loadSettings 读盘一次，
 * 运行期内存为准（getSettings），更新即时原子落盘。
 */

/** 应用设置允许的主题取值 */
const VALID_THEMES = new Set(['dark', 'light'])
/** 应用设置允许的卡片尺寸取值 */
const VALID_CARD_SIZES = new Set(['compact', 'normal', 'large'])
/** 应用设置允许的默认排序方式 */
const VALID_SORT_BY = new Set(['name', 'type', 'size', 'mtime', 'favorite', 'rating'])
/** 应用设置允许的扫描文件扩展名（单一来源：scanner.js 的 MODEL_EXTENSIONS，C3） */
const VALID_SCAN_EXTENSIONS = MODEL_EXTENSIONS

/** 内存中的应用设置 */
let settings = null

/** 默认应用设置 */
export function defaultSettings() {
  return {
    modelsFolder: '',
    modelsFolders: [],
    autoScan: true,
    excludeDirs: [],
    theme: 'dark',
    cardSize: 'normal',
    sortBy: 'name',
    sortAsc: true,
    scanExtensions: [...VALID_SCAN_EXTENSIONS],
    showSize: true,
    showMtime: true,
    showParams: true,
    autoRescan: false
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
export function normalizeSettings(raw) {
  const base = defaultSettings()
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
    modelsFolder: typeof raw.modelsFolder === 'string' ? raw.modelsFolder : base.modelsFolder,
    // 多根目录库列表（E7）：与 modelsFolder 取并集（当前根恒在列，防误删激活库），
    // Windows 大小写不敏感去重，上限 20 个
    modelsFolders: normalizeModelsFolders(raw.modelsFolders, raw.modelsFolder),
    autoScan: typeof raw.autoScan === 'boolean' ? raw.autoScan : base.autoScan,
    excludeDirs,
    theme: VALID_THEMES.has(raw.theme) ? raw.theme : base.theme,
    cardSize: VALID_CARD_SIZES.has(raw.cardSize) ? raw.cardSize : base.cardSize,
    sortBy: VALID_SORT_BY.has(raw.sortBy) ? raw.sortBy : base.sortBy,
    sortAsc: typeof raw.sortAsc === 'boolean' ? raw.sortAsc : base.sortAsc,
    scanExtensions: normalizeExtensions(raw.scanExtensions),
    showSize: typeof raw.showSize === 'boolean' ? raw.showSize : base.showSize,
    showMtime: typeof raw.showMtime === 'boolean' ? raw.showMtime : base.showMtime,
    showParams: typeof raw.showParams === 'boolean' ? raw.showParams : base.showParams,
    autoRescan: raw.autoRescan === true
  }
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

/**
 * 加载应用设置（含通用/扫描/外观设置；旧版数据内嵌于 store.json，自动回退并迁移）。
 * 仅应用启动时调用一次，运行期以 getSettings() 读取内存值。
 */
export async function loadSettings() {
  try {
    const text = await fs.readFile(getSettingsFilePath(), 'utf-8')
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('根节点不是 JSON 对象')
    }
    settings = normalizeSettings(parsed)
  } catch (err) {
    if (err.code === 'ENOENT') {
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
        } else {
          settings = defaultSettings()
        }
      } catch {
        settings = defaultSettings()
      }
    } else {
      // settings.json 损坏（如写入中断电、磁盘错误）：备份原文件后重置，保留手动恢复机会
      settings = defaultSettings()
      try {
        await fs.rename(getSettingsFilePath(), `${getSettingsFilePath()}.bak`)
        logger.error(`应用设置文件损坏，原文件已备份为 ${SETTINGS_FILE}.bak 后重置: ${err.message}`)
      } catch (backupErr) {
        logger.error(`应用设置加载失败，已重置（备份失败: ${backupErr.message}）: ${err.message}`)
      }
    }
  }
  return settings
}

/** 获取当前内存中的应用设置 */
export function getSettings() {
  // loadSettings 之前防御性返回默认值（正常启动时序下不会走到）
  if (!settings) settings = defaultSettings()
  return settings
}

/** 更新应用设置（规范化后立即落盘，原子写入） */
export async function updateSettings(patch) {
  if (!patch) return
  settings = normalizeSettings({ ...settings, ...patch })
  try {
    await atomicWriteFile(getSettingsFilePath(), JSON.stringify(settings, null, 2))
  } catch (err) {
    // 设置落盘失败与元数据同样经监听器通知渲染进程（C7）：
    // 否则磁盘满/权限错误时用户无感知，重启后设置静默丢失
    notifyStoreSaveError(Object.assign(new Error(`设置保存失败: ${err.message}`)))
  }
}
