import { BrowserWindow, ipcMain } from 'electron'
import logger from '../../logger'
import { getModelMeta, relativizeCover, setModelMeta } from '../../services/store'
import { deleteCoverFile, importCoverFromPath, pickAndSaveCover, saveClipboardImage } from '../../services/covers'
import { toImageUrl } from '../../protocol'
import { resolveCoverSafe } from './decorate'

/**
 * 封面链路：上传 / 粘贴 / 拖拽导入 / 设置默认 / 删除封面。
 * 所有成功路径统一返回 { cover, coverUrl, covers, meta } 结构
 * （项目约定，渲染进程按此结构更新，与 preload 注释保持一致）。
 */

/** 由元数据构造渲染进程使用的封面列表（含绝对路径与 mvimg URL） */
export function coverListFromMeta(meta) {
  return (meta?.covers || []).map((rel) => {
    const abs = resolveCoverSafe(rel)
    return { rel, path: abs, url: abs ? toImageUrl(abs) : '' }
  })
}

/**
 * 构造封面操作的标准响应（upload/paste/import/setDefault/delete 共用）。
 * @param {string} absCover 操作后的默认封面绝对路径（可为空串）
 * @param {object} meta 操作后的完整元数据
 */
function buildCoverResponse(absCover, meta) {
  const coverUrl = absCover ? toImageUrl(absCover) : ''
  return {
    cover: absCover,
    coverUrl,
    covers: coverListFromMeta(meta),
    meta
  }
}

/**
 * 将新封面文件追加到模型的封面列表（去重）。
 * 若尚无默认封面，则将新图设为默认（首页第一张默认显示）。
 */
function appendCoverMeta(id, absCover) {
  const coverRel = relativizeCover(absCover)
  if (!coverRel) {
    return { error: '封面保存位置异常，无法关联到当前模型文件夹' }
  }
  const existing = getModelMeta(id) || {}
  const covers = Array.isArray(existing.covers)
    ? existing.covers.filter((c) => c !== coverRel)
    : []
  covers.push(coverRel)
  const meta = setModelMeta(id, { ...existing, covers, cover: existing.cover || coverRel })
  if (!meta) {
    return { error: '封面关联失败（模型需位于当前模型根目录内）' }
  }
  return { coverRel, meta }
}

/** 注册封面链路的 IPC 处理器 */
export function registerCoverHandlers() {
  // 上传/添加模型封面图（追加到多封面列表，无默认时设为默认）
  ipcMain.handle('models:uploadCover', async (event, { id } = {}) => {
    if (typeof id !== 'string' || !id) {
      return { error: '无效的模型标识' }
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await pickAndSaveCover(win)
    if (result.canceled) return { canceled: true }
    if (result.error) return { error: result.error }

    const applied = appendCoverMeta(id, result.cover)
    if (applied.error) return applied
    logger.info(`模型封面已添加: ${id}`)
    return buildCoverResponse(result.cover, applied.meta)
  })

  // 将剪贴板中的图片添加为模型预览图
  ipcMain.handle('models:pasteCover', async (event, { id } = {}) => {
    if (typeof id !== 'string' || !id) {
      return { error: '无效的模型标识' }
    }
    const result = await saveClipboardImage()
    if (result.error) return result

    const applied = appendCoverMeta(id, result.cover)
    if (applied.error) return applied
    logger.info(`剪贴板封面已添加: ${id}`)
    return buildCoverResponse(result.cover, applied.meta)
  })

  // 设置默认封面（首页卡片显示的图片）
  ipcMain.handle('models:setDefaultCover', (event, { id, cover } = {}) => {
    if (typeof id !== 'string' || !id || typeof cover !== 'string' || !cover) {
      return { error: '无效的参数' }
    }
    const existing = getModelMeta(id) || {}
    const covers = Array.isArray(existing.covers) ? existing.covers : []
    if (!covers.includes(cover)) {
      return { error: '封面不存在，无法设为默认' }
    }
    const meta = setModelMeta(id, { ...existing, cover })
    if (!meta) {
      return { error: '默认封面设置失败' }
    }
    logger.info(`默认封面已切换: ${id} -> ${cover}`)
    return buildCoverResponse(resolveCoverSafe(cover), meta)
  })

  // 删除单张封面（更新元数据默认封面，并删除物理文件）
  ipcMain.handle('models:deleteCover', async (event, { id, cover } = {}) => {
    if (typeof id !== 'string' || !id || typeof cover !== 'string' || !cover) {
      return { error: '无效的参数' }
    }
    const existing = getModelMeta(id) || {}
    const covers = Array.isArray(existing.covers) ? existing.covers : []
    if (!covers.includes(cover)) {
      return { error: '封面不存在，无法删除' }
    }
    const abs = resolveCoverSafe(cover)
    const wasDefault = existing.cover === cover
    const newCovers = covers.filter((c) => c !== cover)
    // 删除默认封面时自动回退到下一张（无剩余则为空，卡片回退 sidecar 预览图）
    const meta = setModelMeta(id, {
      ...existing,
      covers: newCovers,
      cover: wasDefault ? newCovers[0] || '' : existing.cover
    })
    if (!meta) {
      return { error: '封面删除失败' }
    }
    if (abs) await deleteCoverFile(abs)
    logger.info(`封面已删除: ${id} -> ${cover}`)
    return buildCoverResponse(resolveCoverSafe(meta.cover), meta)
  })

  // 拖拽导入封面：将外部图片文件复制到封面目录并追加到封面列表
  ipcMain.handle('models:importCover', async (event, { id, path: source } = {}) => {
    if (typeof id !== 'string' || !id) {
      return { error: '无效的模型标识' }
    }
    const result = await importCoverFromPath(source)
    if (result.error) return result
    const applied = appendCoverMeta(id, result.cover)
    if (applied.error) return applied
    logger.info(`拖拽封面已添加: ${id}`)
    return buildCoverResponse(result.cover, applied.meta)
  })
}
