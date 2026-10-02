import path from 'node:path'

/**
 * 存储位置约定与路径换算（C2 自 store.js 拆出）：
 * - 所有关联存储文件的目录/文件名常量（含旧版遗留文件名，供迁移使用）
 * - 当前模型根目录状态（内存单例，切换经 setDataRoot）
 * - 绝对路径 ↔ 相对键的换算（Windows 大小写不敏感兜底）
 */

/** 应用设置文件名（位于 %APPDATA%/modelvault/） */
export const SETTINGS_FILE = 'settings.json'
/** 旧版全局存储文件名（迁移前的 %APPDATA% 单文件方案，仅迁移路径使用） */
export const LEGACY_STORE_FILE = 'store.json'
/** 关联存储目录名（位于模型根目录内） */
export const DATA_DIR = '.modelvault'
/** 关联存储元数据文件名 */
export const DATA_FILE = 'store.json'
/** 封面图片目录名（位于 .modelvault/ 内） */
export const COVERS_DIR = 'covers'

/** 当前生效的模型根目录 */
let currentRoot = null
/** 根目录的小写形式（Windows 大小写不敏感路径匹配兜底用） */
let currentRootLower = null

/** 切换当前关联存储的模型根目录（重置内存状态） */
export function setDataRoot(root) {
  currentRoot = root
  currentRootLower = root ? root.toLowerCase() : null
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

/** 封面图片目录（位于模型根目录内） */
export function getCoversDir() {
  if (!currentRoot) throw new Error('尚未设置模型根目录')
  return path.join(getDataDir(), COVERS_DIR)
}

/**
 * 绝对模型路径 -> 相对键（'/' 分隔）；不在根目录内时返回 null。
 * Windows 文件系统大小写不敏感：路径仅大小写不同时 path.relative
 * 会返回 '..\..' 导致关联失联，改用大小写不敏感的前缀匹配兜底。
 * @param {string} absPath 绝对路径
 */
export function toRelKey(absPath) {
  if (!currentRoot || typeof absPath !== 'string') return null
  const rel = path.relative(currentRoot, absPath)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
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
