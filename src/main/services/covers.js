import { clipboard, dialog } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
import { IMAGE_EXTENSIONS } from './scanner'
import { COVERS_DIR, DATA_DIR, getCoversDir, getReferencedCovers, relativizeCover, wasDataReset } from './store'

/**
 * 封面图片管理：用户在详情页上传的预览图会复制到
 * 模型根目录下的 .modelvault/covers/ 统一保管（关联存储），
 * 避免模型目录被意外修改，且随模型文件夹一起移动。
 */

/** 清理文件名中的非法字符 */
function sanitizeBaseName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'cover'
}

/**
 * 弹出图片选择对话框，并将选中的图片复制到关联存储的封面目录。
 * @param {BrowserWindow} parentWin 父窗口
 * @returns {Promise<{cover: string} | {canceled: true} | {error: string}>}
 *   cover 为复制后的绝对路径
 */
export async function pickAndSaveCover(parentWin) {
  const result = await dialog.showOpenDialog(parentWin, {
    title: '选择模型预览图',
    properties: ['openFile'],
    filters: [
      { name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }
    ]
  })
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true }
  }

  const source = result.filePaths[0]
  const ext = path.extname(source).toLowerCase()
  if (!IMAGE_EXTENSIONS.has(ext)) {
    return { error: '不支持的图片格式，请选择 png/jpg/webp/gif/bmp 图片' }
  }

  try {
    await fs.access(source)
    await fs.mkdir(getCoversDir(), { recursive: true })
    const baseName = sanitizeBaseName(path.basename(source, ext))
    const fileName = `${Date.now()}-${baseName}${ext}`
    const dest = path.join(getCoversDir(), fileName)
    await fs.copyFile(source, dest)
    logger.info(`封面已保存: ${dest}`)
    return { cover: dest }
  } catch (err) {
    logger.error(`封面保存失败: ${err.message}`)
    return { error: `封面保存失败: ${err.message}` }
  }
}

/** 校验路径是否为存在的图片文件 */
export async function isValidImageFile(p) {
  if (typeof p !== 'string' || !p) return false
  if (!IMAGE_EXTENSIONS.has(path.extname(p).toLowerCase())) return false
  try {
    const stat = await fs.stat(p)
    return stat.isFile()
  } catch {
    return false
  }
}

/**
 * 读取系统剪贴板中的图片并保存到关联存储的封面目录。
 * Electron 44 起 clipboard 对齐 W3C Clipboard API：readImage 已移除，
 * 改用 clipboard.read() 返回 ClipboardItem[]，按 MIME 类型取图片 Blob。
 * @returns {Promise<{cover: string} | {error: string}>} cover 为保存后的绝对路径
 */
export async function saveClipboardImage() {
  try {
    const MIME_EXT = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'image/bmp': '.bmp'
    }
    const items = await clipboard.read()
    const item = items.find((it) => it.types.some((t) => t in MIME_EXT))
    if (!item) {
      return { error: '剪贴板中没有图片内容' }
    }
    const mime = item.types.find((t) => t in MIME_EXT)
    const blob = await item.getType(mime)
    await fs.mkdir(getCoversDir(), { recursive: true })
    const dest = path.join(getCoversDir(), `${Date.now()}-clipboard${MIME_EXT[mime]}`)
    await fs.writeFile(dest, Buffer.from(await blob.arrayBuffer()))
    logger.info(`剪贴板图片已保存: ${dest}`)
    return { cover: dest }
  } catch (err) {
    logger.error(`剪贴板图片保存失败: ${err.message}`)
    return { error: `剪贴板图片保存失败: ${err.message}` }
  }
}

/**
 * 删除封面物理文件（仅允许删除关联存储封面目录内的文件）。
 * @param {string} absCover 封面绝对路径
 * @returns {Promise<boolean>} 是否删除成功（路径越界或删除失败返回 false）
 */
export async function deleteCoverFile(absCover) {
  if (!absCover || typeof absCover !== 'string') return false
  if (!relativizeCover(absCover)) return false
  try {
    await fs.rm(absCover, { force: true })
    return true
  } catch (err) {
    logger.warn(`封面文件删除失败: ${err.message}`)
    return false
  }
}

/**
 * 清理封面目录中不再被任何元数据引用的孤儿文件
 * （元数据被手动删除/损坏修复后遗留的失效封面）。
 * 元数据因损坏被重置时跳过清理，避免把仍有价值的封面误删。
 */
export async function pruneOrphanCovers() {
  try {
    if (wasDataReset()) {
      logger.warn('元数据曾损坏重置，跳过孤儿封面清理以避免误删')
      return
    }
    const referenced = getReferencedCovers()
    const dir = getCoversDir()
    const entries = await fs.readdir(dir)
    const prefix = `${DATA_DIR}/${COVERS_DIR}/`
    const stale = entries.filter((n) => !referenced.has(`${prefix}${n}`))
    if (stale.length === 0) return
    await Promise.all(stale.map((n) => fs.rm(path.join(dir, n), { force: true })))
    logger.info(`已清理 ${stale.length} 个孤儿封面文件`)
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`孤儿封面清理失败: ${err.message}`)
  }
}
