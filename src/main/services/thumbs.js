import { nativeImage } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
import { getCurrentRoot } from './store'

/**
 * 封面缩略图缓存：
 * - 网格卡片只需小图，直接加载原图（大分辨率 WebP/PNG）会带来
 *   高内存占用与解码卡顿；此处将封面缩放为固定宽度的 JPEG 缓存；
 * - 缩略图保存在模型根目录的 .modelvault/thumbs/ 内（关联存储，
 *   随模型文件夹一起移动），文件名为「路径哈希-源图修改时间」，
 *   源图变化自动失效并重新生成；
 * - 生成失败（不支持的格式、损坏文件等）时回退使用原图，不影响功能。
 */

const THUMBS_DIR = 'thumbs'
/** 缩略图目标宽度（px），兼顾网格清晰度与详情页预览 */
const THUMB_WIDTH = 640
/** 仅当原图宽度超过该值时才生成缩略图，小图直接使用原图 */
const MIN_SOURCE_WIDTH = 720
const JPEG_QUALITY = 82

/** 缩略图缓存目录（位于模型根目录内） */
function getThumbsDir() {
  return path.join(getCurrentRoot(), '.modelvault', THUMBS_DIR)
}

/** 缩略图文件名：源图路径哈希（小写化，兼容 Windows 大小写）+ mtime */
function thumbFileName(absCover, mtimeMs) {
  const hash = crypto.createHash('md5').update(absCover.toLowerCase()).digest('hex').slice(0, 16)
  return `${hash}-${Math.round(mtimeMs)}.jpg`
}

/**
 * 获取封面缩略图的绝对路径；缓存未命中时同步生成后返回。
 * 生成失败或无需缩放时返回空字符串，调用方应回退使用原图路径。
 * @param {string} absCover 封面图片绝对路径
 * @returns {Promise<string>} 缩略图绝对路径，失败返回 ''
 */
export async function getThumbPath(absCover) {
  if (!absCover || typeof absCover !== 'string' || !getCurrentRoot()) return ''
  try {
    const stat = await fs.stat(absCover)
    const name = thumbFileName(absCover, stat.mtimeMs)
    const thumbPath = path.join(getThumbsDir(), name)
    try {
      await fs.access(thumbPath)
      return thumbPath
    } catch {
      /* 缓存未命中，继续生成 */
    }
    const image = nativeImage.createFromPath(absCover)
    if (image.isEmpty()) return ''
    const { width } = image.getSize()
    if (width <= MIN_SOURCE_WIDTH) return ''
    const resized = image.resize({ width: THUMB_WIDTH })
    await fs.mkdir(getThumbsDir(), { recursive: true })
    await fs.writeFile(thumbPath, resized.toJPEG(JPEG_QUALITY))
    return thumbPath
  } catch (err) {
    logger.warn(`缩略图生成失败（回退原图）: ${err.message}`)
    return ''
  }
}

/**
 * 清理缩略图目录中不在保留名单内的旧文件
 * （源图被修改/删除、封面被移除后遗留的失效缓存）。
 * @param {Set<string>} keepNames 本次扫描中仍在使用的缩略图文件名
 */
export async function pruneThumbs(keepNames) {
  try {
    const entries = await fs.readdir(getThumbsDir())
    const stale = entries.filter((n) => !keepNames.has(n))
    if (stale.length === 0) return
    await Promise.all(stale.map((n) => fs.rm(path.join(getThumbsDir(), n), { force: true })))
    logger.info(`已清理 ${stale.length} 个失效缩略图`)
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`缩略图清理失败: ${err.message}`)
  }
}
