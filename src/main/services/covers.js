import { app, dialog } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
import { IMAGE_EXTENSIONS } from './scanner'

/**
 * 封面图片管理：用户在详情页上传的预览图会复制到
 * 用户数据目录 covers/ 下统一保管，避免模型目录被意外修改。
 */

let coversDir = null

/** 封面存储目录（延迟初始化，需在 app ready 后调用） */
export function getCoversDir() {
  if (!coversDir) {
    coversDir = path.join(app.getPath('userData'), 'covers')
  }
  return coversDir
}

/** 清理文件名中的非法字符 */
function sanitizeBaseName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'cover'
}

/**
 * 弹出图片选择对话框，并将选中的图片复制到封面目录。
 * @param {BrowserWindow} parentWin 父窗口
 * @returns {Promise<{cover: string} | {canceled: true} | {error: string}>}
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
