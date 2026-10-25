import { BrowserWindow } from 'electron'
import logger from '../../logger'
import { runWithConcurrency } from '../../utils'
import {
  getMetaMapByAbsPath,
  getModelMeta,
  relativizeCover,
  setModelMeta,
} from '../../services/store'
import {
  deleteCoverFile,
  importCoverFromPath,
  pickAndSaveCover,
  saveClipboardImage,
} from '../../services/covers'
import {
  getThumbPathDeferred,
  removeThumbsForSources,
} from '../../services/thumbs'
import { toImageUrl } from '../../protocol'
import {
  resolveCoverSafe,
  sendThumbReady,
  startThumbDrain,
  trackDeferredOwner,
} from './decorate'
import { wrapHandler, checkModelId } from '../handler'

/**
 * 封面链路：上传 / 粘贴 / 拖拽导入 / 设置默认 / 删除封面。
 * 所有成功路径统一返回 { cover, coverUrl, covers, meta } 结构
 * （项目约定，渲染进程按此结构更新，与 preload 注释保持一致）。
 * appendCoverMeta/buildCoverResponse/refreshCoverThumbnail 导出供
 * Civitai 示例图导入链路复用（同一封面结构与缩略图刷新约定）。
 */

/** 由元数据构造渲染进程使用的封面列表（含绝对路径与 mvimg URL） */
function coverListFromMeta(meta) {
  return (meta?.covers || []).map((rel) => {
    const abs = resolveCoverSafe(rel)
    return { rel, path: abs, url: abs ? toImageUrl(abs) : '' }
  })
}

/**
 * 构造封面操作的标准响应（upload/paste/import/setDefault/delete 共用）。
 * @param {string} absCover 操作后的默认封面绝对路径（可为空串）
 * @param {Record<string, any>} meta 操作后的完整元数据
 */
export function buildCoverResponse(absCover, meta) {
  const coverUrl = absCover ? toImageUrl(absCover) : ''
  return {
    cover: absCover,
    coverUrl,
    covers: coverListFromMeta(meta),
    meta,
  }
}

/**
 * 将新封面文件追加到模型的封面列表（去重）。
 * 若尚无默认封面，则将新图设为默认（首页第一张默认显示）。
 * @param {string} id 模型绝对路径
 * @param {string} absCover 封面绝对路径
 * @returns {{error?: string, coverRel?: string, meta?: Record<string, any>}}
 *   失败 {error}；成功 {coverRel, meta}
 */
export function appendCoverMeta(id, absCover) {
  const coverRel = relativizeCover(absCover)
  if (!coverRel) {
    return { error: '封面保存位置异常，无法关联到当前模型文件夹' }
  }
  const existing = getModelMeta(id) || {}
  const covers = Array.isArray(existing.covers)
    ? existing.covers.filter((c) => c !== coverRel)
    : []
  covers.push(coverRel)
  const meta = setModelMeta(id, {
    ...existing,
    covers,
    cover: existing.cover || coverRel,
  })
  if (!meta) {
    return { error: '封面关联失败（模型需位于当前模型根目录内）' }
  }
  return { coverRel, meta }
}

/**
 * 封面变更后即时刷新缩略图（A-09）：
 * 用户上传/粘贴/拖入/切换默认封面后，卡片在下次扫描前一直加载原图；
 * 此处立即登记归属并查询缩略图——已缓存则直接推送 thumbsReady 切换卡片图，
 * 未缓存则经后台 drain 生成后由既有链路推送。
 * @param {any} win 来源窗口
 * @param {string} modelId 模型绝对路径
 * @param {string} absCover 默认封面绝对路径（空串时跳过）
 */
export async function refreshCoverThumbnail(win, modelId, absCover) {
  if (!absCover) return
  try {
    trackDeferredOwner(modelId, absCover)
    const thumbPath = await getThumbPathDeferred(absCover)
    if (thumbPath) {
      sendThumbReady(win, [{ id: modelId, coverUrl: toImageUrl(thumbPath) }])
    } else {
      startThumbDrain(win)
    }
  } catch (err) {
    // 缩略图是锦上添花：失败不影响封面设置结果，下次扫描仍会补齐
    logger.warn(`封面即时缩略图失败: ${err.message}`)
  }
}

/** 注册封面链路的 IPC 处理器 */
export function registerCoverHandlers() {
  // 上传/添加模型封面图（追加到多封面列表，无默认时设为默认）
  wrapHandler(
    'models:uploadCover',
    async (event, { id } = {}) => {
      const invalid = checkModelId(id)
      if (invalid) return { error: invalid }
      const win = BrowserWindow.fromWebContents(event.sender)
      const result = await pickAndSaveCover(win)
      if (result.canceled) return { canceled: true }
      if (result.error) return { error: result.error }

      const applied = appendCoverMeta(id, result.cover)
      if (applied.error) return applied
      logger.info(`模型封面已添加: ${id}`)
      await refreshCoverThumbnail(
        win,
        id,
        applied.meta.cover ? resolveCoverSafe(applied.meta.cover) : '',
      )
      return buildCoverResponse(result.cover, applied.meta)
    },
    { errorPrefix: '封面上传失败' },
  )

  // 将剪贴板中的图片添加为模型预览图
  wrapHandler(
    'models:pasteCover',
    async (event, { id } = {}) => {
      const invalid = checkModelId(id)
      if (invalid) return { error: invalid }
      const result = await saveClipboardImage()
      if (result.error) return result

      const applied = appendCoverMeta(id, result.cover)
      if (applied.error) return applied
      logger.info(`剪贴板封面已添加: ${id}`)
      await refreshCoverThumbnail(
        BrowserWindow.fromWebContents(event.sender),
        id,
        applied.meta.cover ? resolveCoverSafe(applied.meta.cover) : '',
      )
      return buildCoverResponse(result.cover, applied.meta)
    },
    { errorPrefix: '封面粘贴失败' },
  )

  // 设置默认封面（首页卡片显示的图片）
  wrapHandler(
    'models:setDefaultCover',
    async (event, { id, cover } = {}) => {
      const invalid =
        checkModelId(id) ||
        (typeof cover === 'string' && cover ? '' : '无效的封面参数')
      if (invalid) return { error: invalid }
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
      await refreshCoverThumbnail(
        BrowserWindow.fromWebContents(event.sender),
        id,
        resolveCoverSafe(meta.cover),
      )
      return buildCoverResponse(resolveCoverSafe(cover), meta)
    },
    { errorPrefix: '默认封面设置失败' },
  )

  // 删除单张封面（更新元数据默认封面，并删除物理文件）
  wrapHandler(
    'models:deleteCover',
    async (event, { id, cover } = {}) => {
      const invalid =
        checkModelId(id) ||
        (typeof cover === 'string' && cover ? '' : '无效的封面参数')
      if (invalid) return { error: invalid }
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
        cover: wasDefault ? newCovers[0] || '' : existing.cover,
      })
      if (!meta) {
        return { error: '封面删除失败' }
      }
      if (abs) await deleteCoverFile(abs)
      logger.info(`封面已删除: ${id} -> ${cover}`)
      return buildCoverResponse(resolveCoverSafe(meta.cover), meta)
    },
    { errorPrefix: '封面删除失败' },
  )

  // 一键移除全部示例图（清空元数据封面列表并删除物理文件）
  wrapHandler(
    'models:clearCovers',
    async (event, { id } = {}) => {
      const invalid = checkModelId(id)
      if (invalid) return { error: invalid }
      const existing = getModelMeta(id) || {}
      const covers = Array.isArray(existing.covers) ? existing.covers : []
      const meta = setModelMeta(id, { ...existing, covers: [], cover: '' })
      if (!meta) {
        return { error: '封面移除失败' }
      }
      // 物理文件删除放在元数据更新之后：单张失败不阻塞整体（失败残留的
      // 孤儿文件由 pruneOrphanCovers 周期清理兜底）。OPT-09：有界并发删除
      await runWithConcurrency(
        covers,
        (rel) => deleteCoverFile(resolveCoverSafe(rel)),
        8,
      )
      logger.info(`已移除全部示例图: ${id}（${covers.length} 张）`)
      return buildCoverResponse('', meta)
    },
    { errorPrefix: '封面移除失败' },
  )

  // 一键清空当前库全部模型的示例图（设置页数据清理入口）：
  // 逐模型清空封面引用（复用 setModelMeta 规范化与防抖落盘），再删除物理文件
  wrapHandler(
    'models:clearAllCovers',
    async () => {
      const metas = getMetaMapByAbsPath()
      let clearedModels = 0
      let clearedImages = 0
      const deletions = []
      for (const [id, meta] of Object.entries(metas)) {
        const covers = Array.isArray(meta.covers) ? meta.covers : []
        if (covers.length === 0) continue
        setModelMeta(id, { ...meta, covers: [], cover: '' })
        clearedModels += 1
        clearedImages += covers.length
        for (const rel of covers) {
          deletions.push(resolveCoverSafe(rel))
        }
      }
      // 引用清理已全部完成后统一删文件：单张失败不阻塞（孤儿文件由
      // pruneOrphanCovers 周期清理兜底）。OPT-09：全库封面可能数千张，
      // 统一有界并发，避免瞬时耗尽文件句柄
      await runWithConcurrency(deletions, (abs) => deleteCoverFile(abs), 8)
      // 同步清理被移除封面对应的失效缩略图（按源图路径哈希前缀精确匹配，
      // 不误删 sidecar 预览图等仍在使用的缩略图；失败不阻塞清理结果）
      await removeThumbsForSources(deletions)
      logger.info(
        `已清空全部示例图: ${clearedModels} 个模型共 ${clearedImages} 张`,
      )
      return { cleared: clearedModels, images: clearedImages }
    },
    { errorPrefix: '示例图清空失败' },
  )

  // 拖拽导入封面：将外部图片文件复制到封面目录并追加到封面列表
  wrapHandler(
    'models:importCover',
    async (event, { id, path: source } = {}) => {
      const invalid = checkModelId(id)
      if (invalid) return { error: invalid }
      const result = await importCoverFromPath(source)
      if (result.error) return result
      const applied = appendCoverMeta(id, result.cover)
      if (applied.error) return applied
      logger.info(`拖拽封面已添加: ${id}`)
      await refreshCoverThumbnail(
        BrowserWindow.fromWebContents(event.sender),
        id,
        applied.meta.cover ? resolveCoverSafe(applied.meta.cover) : '',
      )
      return buildCoverResponse(result.cover, applied.meta)
    },
    { errorPrefix: '封面导入失败' },
  )
}
