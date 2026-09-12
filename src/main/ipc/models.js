import { BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
import {
  getCurrentRoot,
  getMetaMapByAbsPath,
  getModelMeta,
  getSettings,
  isInRoot,
  loadSettings,
  loadData,
  relativizeCover,
  removeModelMeta,
  renameModelMeta,
  resolveCover,
  saveStoreNow,
  setDataRoot,
  setModelHash,
  setModelMeta,
  updateSettings
} from '../services/store'
import { findSidecarPreview, scanModels } from '../services/scanner'
import {
  deleteCoverFile,
  importCoverFromPath,
  isValidImageFile,
  pickAndSaveCover,
  pruneOrphanCovers,
  saveClipboardImage
} from '../services/covers'
import { getThumbPath, pruneThumbs } from '../services/thumbs'
import { matchCivitai } from '../services/civitai'
import { toImageUrl } from '../protocol'

/**
 * 模型管理相关 IPC 处理器。
 * 通道命名统一使用 models: 前缀，需与 preload 白名单保持一致。
 * 元数据与封面采用「关联存储」：保存在模型根目录的 .modelvault/ 下。
 */

/** 进度事件节流间隔（ms），避免大量小文件时 IPC 过载 */
const PROGRESS_INTERVAL = 120

let scanning = false

/** 确保指定根目录的关联存储已加载 */
async function ensureRootStore(root) {
  if (getCurrentRoot() !== root) {
    setDataRoot(root)
    await loadData()
  }
}

/** 并行装饰的分批大小：单批内并发 stat，批间串行，避免一次性打开过多文件句柄 */
const DECORATE_BATCH_SIZE = 64

/** 单模型的元数据装饰（封面列表校验、默认封面回退 sidecar 预览图） */
async function decorateOne(model, usedThumbs) {
  const meta = getModelMeta(model.id) || {}
  // 校验多封面列表，过滤已丢失的文件
  const covers = []
  for (const rel of meta.covers || []) {
    const resolved = resolveCoverSafe(rel)
    if (resolved && (await isValidImageFile(resolved))) {
      covers.push({ rel, path: resolved, url: toImageUrl(resolved) })
    }
  }
  // 默认封面：优先显式设置值，缺省取第一张；再缺省回退 sidecar 预览图
  const defaultEntry = covers.find((c) => c.rel === meta.cover) || covers[0] || null
  let cover = defaultEntry ? defaultEntry.path : ''
  if (!cover) {
    cover = await findSidecarPreview(model.id)
  }
  // 卡片显示使用缩略图（缓存未命中时生成），生成失败回退原图
  let coverUrl = ''
  if (cover) {
    const thumbPath = await getThumbPath(cover)
    if (thumbPath) usedThumbs?.add(path.basename(thumbPath))
    coverUrl = toImageUrl(thumbPath || cover)
  }
  return {
    ...model,
    cover,
    coverUrl,
    covers,
    hasManualCover: covers.length > 0,
    params: meta.params || null,
    alias: meta.alias || '',
    note: meta.note || '',
    favorite: meta.favorite === true,
    rating: meta.rating || 0,
    tags: meta.tags || [],
    // 大模型自动标注为「基底模型」分类（未手动标注时默认生效）
    subCategory: meta.subCategory || (model.type === 'checkpoint' ? 'base' : '')
  }
}

/** 为扫描结果补充元数据（封面列表、默认封面 URL、参数、备注、二级分类），分批并行处理并保持原始顺序 */
async function decorateModels(models) {
  /** 本次扫描仍在使用的缩略图文件名（用于清理失效缓存） */
  const usedThumbs = new Set()
  const result = new Array(models.length)
  for (let i = 0; i < models.length; i += DECORATE_BATCH_SIZE) {
    const batch = models.slice(i, i + DECORATE_BATCH_SIZE)
    const decorated = await Promise.all(batch.map((m) => decorateOne(m, usedThumbs)))
    for (let j = 0; j < decorated.length; j++) {
      result[i + j] = decorated[j]
    }
  }
  await pruneThumbs(usedThumbs)
  return result
}

/** 解析相对封面路径（容错：加载失败返回空字符串） */
function resolveCoverSafe(cover) {
  try {
    return resolveCover(cover)
  } catch {
    return ''
  }
}

/** 模型同名的 sidecar 文件（SD WebUI 惯例：同名预览图 + 说明文本） */
function sidecarFilesFor(absModelPath) {
  const dir = path.dirname(absModelPath)
  const base = path.basename(absModelPath, path.extname(absModelPath))
  const files = [path.join(dir, `${base}.txt`), path.join(dir, `${base}.preview.png`)]
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']) {
    files.push(path.join(dir, `${base}${ext}`))
  }
  return files
}

/** 由元数据构造渲染进程使用的封面列表（含绝对路径与 mvimg URL） */
function coverListFromMeta(meta) {
  return (meta?.covers || []).map((rel) => {
    const abs = resolveCoverSafe(rel)
    return { rel, path: abs, url: abs ? toImageUrl(abs) : '' }
  })
}

/** 将推荐参数格式化为可复制的文本（用于右键菜单「复制推荐参数」） */
function paramSummaryFromMeta(params) {
  if (!params) return ''
  const parts = []
  if (Number.isFinite(params.steps)) parts.push(`Steps: ${params.steps}`)
  if (Number.isFinite(params.cfgMin) && Number.isFinite(params.cfgMax) && params.cfgMin !== params.cfgMax) {
    parts.push(`CFG: ${params.cfgMin}~${params.cfgMax}`)
  } else if (Number.isFinite(params.cfgMin)) {
    parts.push(`CFG: ${params.cfgMin}`)
  }
  if (params.sampler) parts.push(`Sampler: ${params.sampler}`)
  if (params.scheduler) parts.push(`Scheduler: ${params.scheduler}`)
  if (Number.isFinite(params.resMin) && Number.isFinite(params.resMax)) {
    parts.push(`Size: ${params.resMin}x${params.resMax}`)
  }
  return parts.join(', ')
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

export function registerModelIpcHandlers() {
  // 加载持久化数据（设置 + 当前模型根目录的元数据，键为绝对路径）
  ipcMain.handle('models:loadStore', async () => {
    const settings = await loadSettings()
    let metaMap = {}
    if (settings.modelsFolder) {
      await ensureRootStore(settings.modelsFolder)
      // 清理不再被元数据引用的孤儿封面文件
      await pruneOrphanCovers()
      metaMap = getMetaMapByAbsPath()
    }
    return {
      settings,
      models: metaMap
    }
  })

  // 选择模型根目录
  ipcMain.handle('models:chooseFolder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win, {
      title: '选择模型文件夹',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const folder = result.filePaths[0]
    await updateSettings({ modelsFolder: folder })
    logger.info(`模型目录已设置为: ${folder}`)
    return folder
  })

  // 扫描模型目录（耗时操作，进度通过 models:scanProgress 事件推送）
  ipcMain.handle('models:scan', async (event, { folder } = {}) => {
    const root = typeof folder === 'string' && folder ? folder : (await loadSettings()).modelsFolder
    if (!root) {
      return { error: '尚未设置模型文件夹' }
    }
    if (scanning) {
      return { error: '正在扫描中，请稍候' }
    }

    const win = BrowserWindow.fromWebContents(event.sender)
    scanning = true
    const startedAt = Date.now()
    logger.info(`开始扫描模型目录: ${root}`)

    try {
      // 切换/加载该根目录的关联存储，并清理孤儿封面文件
      await ensureRootStore(root)
      await pruneOrphanCovers()

      let lastSent = 0
      // 应用扫描规则：排除目录 + 扫描文件扩展名（来自应用设置）
      const appSettings = getSettings()
      const { models, errors, dirCount } = await scanModels(
        root,
        (progress) => {
          const now = Date.now()
          if (now - lastSent >= PROGRESS_INTERVAL) {
            lastSent = now
            win?.webContents.send('models:scanProgress', progress)
          }
        },
        {
          excludeDirs: appSettings.excludeDirs || [],
          extensions: appSettings.scanExtensions || []
        }
      )

      const decorated = await decorateModels(models)
      const byType = {}
      for (const m of decorated) {
        byType[m.type] = (byType[m.type] || 0) + 1
      }

      logger.info(
        `扫描完成：${decorated.length} 个模型 / ${dirCount} 个目录 / 耗时 ${Date.now() - startedAt}ms / ${errors.length} 个错误`
      )
      if (errors.length > 0) {
        logger.warn(`扫描错误详情: ${JSON.stringify(errors.slice(0, 20))}`)
      }

      return {
        root,
        models: decorated,
        byType,
        errors,
        durationMs: Date.now() - startedAt
      }
    } catch (err) {
      logger.error(`扫描失败: ${err.stack || err.message}`)
      return { error: `扫描失败: ${err.message}` }
    } finally {
      scanning = false
    }
  })

  // 保存单个模型的元数据（备注名 / 推荐参数 / 备注 / 二级分类标签）
  ipcMain.handle('models:saveModelData', (event, { id, alias, params, note, subCategory } = {}) => {
    if (typeof id !== 'string' || !id) {
      return { error: '无效的模型标识' }
    }
    // 合并已有元数据，避免覆盖丢失封面等未随本次请求传入的字段
    const existing = getModelMeta(id) || {}
    const meta = setModelMeta(id, { ...existing, alias, params, note, subCategory })
    if (!meta) {
      return { error: '模型元数据保存失败（模型需位于当前模型根目录内）' }
    }
    logger.info(`模型元数据已保存: ${id}`)
    return { meta }
  })

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
    return {
      cover: result.cover,
      coverUrl: toImageUrl(result.cover),
      covers: coverListFromMeta(applied.meta),
      meta: applied.meta
    }
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
    return {
      cover: result.cover,
      coverUrl: toImageUrl(result.cover),
      covers: coverListFromMeta(applied.meta),
      meta: applied.meta
    }
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
    const abs = resolveCoverSafe(cover)
    return {
      cover: abs,
      coverUrl: abs ? toImageUrl(abs) : '',
      covers: coverListFromMeta(meta),
      meta
    }
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
    const nextAbs = resolveCoverSafe(meta.cover)
    return {
      cover: nextAbs,
      coverUrl: nextAbs ? toImageUrl(nextAbs) : '',
      covers: coverListFromMeta(meta),
      meta
    }
  })

  // 更新应用设置（通用/扫描/外观），返回规范化后的完整设置
  ipcMain.handle('settings:update', async (event, patch = {}) => {
    await updateSettings(patch)
    const settings = getSettings()
    logger.info(`应用设置已更新: ${JSON.stringify(patch).slice(0, 200)}`)
    return { settings }
  })

  // Civitai 匹配：计算模型文件 SHA256 并查询 Civitai API（耗时操作，大文件需数秒）。
  // 已计算的哈希持久化在元数据中（hash/hashMtime），文件未变化时直接复用，重启后无需重算
  ipcMain.handle('models:civitaiMatch', async (event, { id } = {}) => {
    if (typeof id !== 'string' || !id) {
      return { error: '无效的模型标识' }
    }
    if (!isInRoot(id)) {
      return { error: '模型不在当前根目录内，无法匹配' }
    }
    let mtimeMs = 0
    try {
      mtimeMs = (await fs.stat(id)).mtimeMs
    } catch {
      return { error: '模型文件不存在' }
    }
    // mtime 一致时复用持久化哈希，跳过耗时的全文件 SHA256 计算
    const meta = getModelMeta(id) || {}
    const knownHash = meta.hash && meta.hashMtime === mtimeMs ? meta.hash : ''
    try {
      const result = await matchCivitai(id, knownHash)
      if (result.hash) setModelHash(id, result.hash, mtimeMs)
      return result
    } catch (err) {
      logger.warn(`Civitai 匹配失败: ${err.message}`)
      return { error: `Civitai 匹配失败: ${err.message}` }
    }
  })

  // 删除模型文件（移入系统回收站）并清理关联元数据与同名 sidecar 文件
  ipcMain.handle('models:deleteModel', async (event, { id } = {}) => {
    if (typeof id !== 'string' || !id) {
      return { error: '无效的模型标识' }
    }
    if (!isInRoot(id)) {
      return { error: '模型不在当前根目录内，无法删除' }
    }
    try {
      const stat = await fs.stat(id)
      if (!stat.isFile()) {
        return { error: '无效的模型文件' }
      }
    } catch {
      return { error: '模型文件不存在' }
    }
    try {
      await shell.trashItem(id)
    } catch (err) {
      logger.warn(`模型删除失败: ${err.message}`)
      return { error: `删除失败: ${err.message}` }
    }
    // 同步移除同名的 sidecar 预览图/说明文件（失败不阻塞）
    for (const f of sidecarFilesFor(id)) {
      await shell.trashItem(f).catch(() => {})
    }
    removeModelMeta(id)
    logger.info(`模型已移入回收站: ${id}`)
    return { ok: true }
  })

  // 重命名模型文件（保留扩展名，联动迁移元数据键与同名 sidecar 文件）
  ipcMain.handle('models:renameModel', async (event, { id, newName } = {}) => {
    if (typeof id !== 'string' || !id || typeof newName !== 'string') {
      return { error: '无效的参数' }
    }
    const name = newName.trim()
    if (!name || /[\\/:*?"<>|]/.test(name)) {
      return { error: '名称为空或包含非法字符' }
    }
    if (name.length > 200) {
      return { error: '名称过长（最多 200 字符）' }
    }
    if (!isInRoot(id)) {
      return { error: '模型不在当前根目录内，无法重命名' }
    }
    try {
      const stat = await fs.stat(id)
      if (!stat.isFile()) {
        return { error: '无效的模型文件' }
      }
    } catch {
      return { error: '模型文件不存在' }
    }

    const ext = path.extname(id)
    const dir = path.dirname(id)
    const newId = path.join(dir, `${name}${ext}`)
    if (newId === path.normalize(id)) {
      return { ok: true, id, name }
    }
    try {
      await fs.access(newId)
      return { error: '目标文件名已存在' }
    } catch {
      /* 目标不存在，可以重命名 */
    }
    try {
      await fs.rename(id, newId)
    } catch (err) {
      logger.warn(`模型重命名失败: ${err.message}`)
      return { error: `重命名失败: ${err.message}` }
    }

    // 联动重命名同名 sidecar 文件（预览图/说明文本）
    const oldBase = path.basename(id, ext)
    for (const f of sidecarFilesFor(id)) {
      try {
        await fs.access(f)
      } catch {
        continue
      }
      const suffix = path.basename(f).slice(oldBase.length)
      const newF = path.join(dir, `${name}${suffix}`)
      if (newF === f) continue
      try {
        await fs.rename(f, newF)
      } catch (err) {
        logger.warn(`sidecar 文件重命名失败: ${f} -> ${newF}: ${err.message}`)
      }
    }

    renameModelMeta(id, newId)
    logger.info(`模型已重命名: ${id} -> ${newId}`)
    return { ok: true, id: newId, name }
  })

  // 更新模型快捷标记（收藏/评分/自定义标签；仅更新传入的字段，即时落盘）
  ipcMain.handle('models:setMetaFlags', (event, { id, favorite, rating, tags } = {}) => {
    if (typeof id !== 'string' || !id) {
      return { error: '无效的模型标识' }
    }
    const patch = {}
    if (favorite !== undefined) {
      if (typeof favorite !== 'boolean') return { error: '无效的收藏状态' }
      patch.favorite = favorite
    }
    if (rating !== undefined) {
      if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
        return { error: '评分需为 0-5 的整数' }
      }
      patch.rating = rating
    }
    if (tags !== undefined) {
      if (!Array.isArray(tags)) return { error: '无效的标签列表' }
      patch.tags = tags
    }
    if (Object.keys(patch).length === 0) {
      return { error: '无有效的更新字段' }
    }
    const existing = getModelMeta(id) || {}
    const meta = setModelMeta(id, { ...existing, ...patch })
    if (!meta) {
      return { error: '保存失败（模型需位于当前模型根目录内）' }
    }
    return { meta }
  })

  // 卡片/详情右键菜单：主进程构建原生菜单，动作经 menuAction 事件回传渲染进程
  ipcMain.handle('models:popupMenu', (event, { id } = {}) => {
    if (typeof id !== 'string' || !id || !isInRoot(id)) {
      return { error: '无效的模型标识' }
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const meta = getModelMeta(id) || {}
    const send = (action) => win?.webContents.send('models:menuAction', { id, action })
    const items = [
      { label: '打开详情', click: () => send('openDetail') },
      { label: '打开所在文件夹', click: () => shell.showItemInFolder(id) },
      { label: '复制文件路径', click: () => clipboard.writeText(id) }
    ]
    const summary = paramSummaryFromMeta(meta.params)
    if (summary) {
      items.push({ label: '复制推荐参数', click: () => clipboard.writeText(summary) })
    }
    items.push(
      { type: 'separator' },
      { label: meta.favorite ? '取消收藏' : '收藏', click: () => send('toggleFavorite') },
      { label: '移入回收站', click: () => send('deleteModel') }
    )
    Menu.buildFromTemplate(items).popup({ window: win })
    return { ok: true }
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
    return {
      cover: result.cover,
      coverUrl: toImageUrl(result.cover),
      covers: coverListFromMeta(applied.meta),
      meta: applied.meta
    }
  })

  // 在资源管理器中显示模型文件
  ipcMain.handle('models:reveal', (event, { path: targetPath } = {}) => {
    if (typeof targetPath !== 'string' || !targetPath) {
      return { error: '无效的路径' }
    }
    shell.showItemInFolder(targetPath)
    return { ok: true }
  })

  // 强制立即落盘（窗口关闭前等场景）
  ipcMain.handle('models:flushStore', async () => {
    await saveStoreNow()
    return { ok: true }
  })

  logger.info('模型管理 IPC 处理器注册完成')
}
