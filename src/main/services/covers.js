import { clipboard, dialog } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
import { IMAGE_EXTENSIONS } from './scanner'
import { getCoversDir } from './store'

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
 * 读取系统剪贴板中的图片并保存到关联存储的封面目录（PNG 格式）。
 * @returns {Promise<{cover: string} | {error: string}>} cover 为保存后的绝对路径
 */
export async function saveClipboardImage() {
  try {
    const image = clipboard.readImage()
    if (image.isEmpty()) {
      return { error: '剪贴板中没有图片内容' }
    }
    await fs.mkdir(getCoversDir(), { recursive: true })
    const dest = path.join(getCoversDir(), `${Date.now()}-clipboard.png`)
    await fs.writeFile(dest, image.toPNG())
    logger.info(`剪贴板图片已保存: ${dest}`)
    return { cover: dest }
  } catch (err) {
    logger.error(`剪贴板图片保存失败: ${err.message}`)
    return { error: `剪贴板图片保存失败: ${err.message}` }
  }
}
