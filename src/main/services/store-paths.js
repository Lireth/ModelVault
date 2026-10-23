import path from 'node:path'
import { relativeWithin } from '../utils'

/**
 * 存储位置约定与路径换算（C2 自 store.js 拆出）：
 * - 所有关联存储文件的目录/文件名常量（含旧版遗留文件名，供迁移使用）
 * - 当前模型根目录状态（内存单例，切换经 setDataRoot）
 * - 绝对路径 ↔ 相对键的换算（Windows 大小写不敏感兜底）
 */

/** 应用设置文件名（位于 %APPDATA%/modelvault/，仅含引导字段：激活库与库列表） */
export const SETTINGS_FILE = 'settings.json'
/** 旧版全局存储文件名（迁移前的 %APPDATA% 单文件方案，仅迁移路径使用） */
export const LEGACY_STORE_FILE = 'store.json'
/** 关联存储目录名（位于模型根目录内） */
export const DATA_DIR = '.modelvault'
/** 关联存储元数据文件名 */
export const DATA_FILE = 'store.json'
/**
 * 元数据增量日志目录（O5）：背景保存只追加变化键的小批次文件，
 * 达到阈值/退出/备份/切库时合并回 store.json 快照。
 */
export const JOURNAL_DIR = 'journal'
/** 本地扫描索引文件名（F1：秒切库展示缓存，不参与备份） */
export const INDEX_FILE = 'index.json'
/** 库设置文件名（位于模型根目录的 .modelvault/ 内，随模型文件夹走） */
export const LIB_SETTINGS_FILE = 'settings.json'
/** 封面图片目录名（位于 .modelvault/ 内） */
export const COVERS_DIR = 'covers'

/** 当前生效的模型根目录 */
let currentRoot = null

/** 切换当前关联存储的模型根目录（重置内存状态） */
export function setDataRoot(root) {
  currentRoot = root
}

/** 当前生效的模型根目录 */
export function getCurrentRoot() {
  return currentRoot
}

/** 根目录下的关联存储目录 */
export function getDataDir(root = currentRoot) {
  return path.join(root, DATA_DIR)
}

/** 根目录下的关联存储元数据文件路径 */
export function getDataFilePath(root = currentRoot) {
  return path.join(getDataDir(root), DATA_FILE)
}

/** 元数据增量日志目录路径 */
export function getJournalDir(root = currentRoot) {
  return path.join(getDataDir(root), JOURNAL_DIR)
}

/** 本地扫描索引文件路径 */
export function getIndexFilePath(root = currentRoot) {
  return path.join(getDataDir(root), INDEX_FILE)
}

/** 模型根目录下的库设置文件路径（.modelvault/settings.json，随模型文件夹走） */
export function getLibSettingsFilePath(root = currentRoot) {
  return path.join(getDataDir(root), LIB_SETTINGS_FILE)
}

/** 封面图片目录（位于模型根目录内） */
export function getCoversDir() {
  if (!currentRoot) throw new Error('尚未设置模型根目录')
  return path.join(getDataDir(), COVERS_DIR)
}

/**
 * 绝对模型路径 -> 相对键（'/' 分隔）；不在根目录内时返回 null。
 * 归属判定与大小写兜底统一收敛在 utils.relativeWithin（O-1 单一实现），
 * 此处只负责「空相对路径（即根目录自身）视为无效键」与 POSIX 分隔转换。
 * @param {string} absPath 绝对路径
 */
export function toRelKey(absPath) {
  if (!currentRoot || typeof absPath !== 'string') return null
  const rel = relativeWithin(absPath, currentRoot)
  if (!rel) return null
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
  // 封面目录自身（相对路径为空）不构成有效封面，与越界同等处理
  const rel = relativeWithin(absCover, getCoversDir())
  if (!rel) return ''
  return `${DATA_DIR}/${COVERS_DIR}/${rel.split(path.sep).join('/')}`
}
