import fs from 'node:fs/promises'
import { BrowserWindow, ipcMain } from 'electron'
import logger from '../../logger'
import { getModelMeta, isInRoot, setModelHash, setModelMeta } from '../../services/store'
import { matchCivitai } from '../../services/civitai'

/**
 * 元数据链路：详情页标注保存、快捷标记（收藏/NSFW/评分）、Civitai 匹配。
 * matchingIds/matchAborts 为本模块私有状态，仅 Civitai 匹配通道使用
 * （B3/S5 按 id 防重入；E9 进度推送与取消）。
 */

/** 进度事件节流间隔（ms），避免大文件哈希回调打满 IPC（E9） */
const CIVITAI_PROGRESS_INTERVAL = 120

/**
 * 合并详情页保存的元数据字段（纯函数，不修改入参）。
 * 仅覆盖请求中显式传入（!== undefined）的字段，防止局部保存时将已有值静默清空。
 * note 显式传入时视为用户编辑，清除 sidecar 自动导入来源标记。
 * @param {object} existing 已有元数据
 * @param {{alias?: string, params?: object|null, note?: string, subCategory?: string}} patch 本次保存的字段
 * @returns {object} 合并后的新元数据
 */
export function mergeSaveModelData(existing, patch) {
  const merged = { ...existing }
  if (patch.alias !== undefined) merged.alias = patch.alias
  if (patch.params !== undefined) merged.params = patch.params
  if (patch.note !== undefined) {
    merged.note = patch.note
    merged.noteSource = ''
  }
  if (patch.subCategory !== undefined) merged.subCategory = patch.subCategory
  return merged
}

/** 进行中匹配的模型 id 集合（按 id 互斥，S5）：全局单例会连带拒绝
 *  不同模型的匹配请求，大库逐个匹配体验割裂；同一模型仍须防并发重复哈希 */
const matchingIds = new Set()

/** 进行中匹配的取消控制器（id -> AbortController，E9） */
const matchAborts = new Map()

/** 注册元数据链路的 IPC 处理器 */
export function registerMetaHandlers() {
  // 保存单个模型的元数据（备注名 / 推荐参数 / 备注 / 二级分类标签 / 触发词）
  ipcMain.handle('models:saveModelData', (event, { id, alias, params, note, subCategory, triggerWords } = {}) => {
    if (typeof id !== 'string' || !id) {
      return { error: '无效的模型标识' }
    }
    // 合并已有元数据，避免覆盖丢失封面等未随本次请求传入的字段
    const existing = getModelMeta(id) || {}
    const merged = mergeSaveModelData(existing, { alias, params, note, subCategory })
    // 触发词仅 LoRA 详情页编辑：请求未携带该字段时不更新，避免误清空
    if (typeof triggerWords === 'string') {
      merged.triggerWords = triggerWords
      merged.triggerWordsSource = ''
    }
    const meta = setModelMeta(id, merged)
    if (!meta) {
      return { error: '模型元数据保存失败（模型需位于当前模型根目录内）' }
    }
    logger.info(`模型元数据已保存: ${id}`)
    return { meta }
  })

  // 更新模型快捷标记（收藏/NSFW/评分；仅更新传入的字段，即时落盘）
  ipcMain.handle('models:setMetaFlags', (event, { id, favorite, nsfw, rating } = {}) => {
    if (typeof id !== 'string' || !id) {
      return { error: '无效的模型标识' }
    }
    const patch = {}
    if (favorite !== undefined) {
      if (typeof favorite !== 'boolean') return { error: '无效的收藏状态' }
      patch.favorite = favorite
    }
    if (nsfw !== undefined) {
      if (typeof nsfw !== 'boolean') return { error: '无效的 NSFW 状态' }
      patch.nsfw = nsfw
    }
    if (rating !== undefined) {
      if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
        return { error: '评分需为 0-5 的整数' }
      }
      patch.rating = rating
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

  // Civitai 匹配：计算模型文件 SHA256 并查询 Civitai API（耗时操作，大文件需数秒）。
  // 已计算的哈希持久化在元数据中（hash/hashMtime），文件未变化时直接复用，重启后无需重算
  ipcMain.handle('models:civitaiMatch', async (event, { id } = {}) => {
    if (typeof id !== 'string' || !id) {
      return { error: '无效的模型标识' }
    }
    // 同步先检查并置位：任何 await 之前完成（B4 惯例）。按 id 互斥（S5）：
    // 同一模型防并发重复哈希（GB 级文件占用磁盘），不同模型可并行匹配
    if (matchingIds.has(id)) {
      return { error: '该模型正在匹配中，请稍候' }
    }
    matchingIds.add(id)
    const abort = new AbortController()
    matchAborts.set(id, abort)
    try {
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
      // 哈希进度经 models:civitaiProgress 节流推送（E9），窗口销毁前须校验 isDestroyed
      const win = BrowserWindow.fromWebContents?.(event.sender) || null
      let lastSent = 0
      const onProgress = (loaded, total) => {
        const now = Date.now()
        if (now - lastSent < CIVITAI_PROGRESS_INTERVAL) return
        lastSent = now
        if (win && !win.isDestroyed()) {
          win.webContents.send('models:civitaiProgress', {
            id,
            loaded,
            total,
            percent: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0
          })
        }
      }
      const result = await matchCivitai(id, knownHash, { signal: abort.signal, onProgress })
      if (result.hash) {
        // TOCTOU 复验（A10）：哈希计算期间文件被替换时，最初 stat 的 mtime
        // 与当前内容不匹配，持久化将导致后续永远复用过期哈希；
        // 复验失败时照常返回匹配结果，但跳过哈希持久化（下次重算）
        let canPersist = false
        try {
          canPersist = (await fs.stat(id)).mtimeMs === mtimeMs
        } catch {
          canPersist = false
        }
        if (canPersist) setModelHash(id, result.hash, mtimeMs)
      }
      return result
    } catch (err) {
      // 用户取消（E9）：返回 { canceled: true } 而非错误提示
      if (err?.name === 'AbortError') {
        logger.info(`Civitai 匹配已取消: ${id}`)
        return { canceled: true }
      }
      logger.warn(`Civitai 匹配失败: ${err.message}`)
      return { error: `Civitai 匹配失败: ${err.message}` }
    } finally {
      matchingIds.delete(id)
      matchAborts.delete(id)
    }
  })

  // 取消进行中的 Civitai 匹配（E9）：中止哈希计算与网络请求
  ipcMain.handle('models:cancelCivitai', (_event, { id } = {}) => {
    if (typeof id === 'string' && id && matchAborts.has(id)) {
      matchAborts.get(id).abort()
      return { ok: true }
    }
    return { ok: false }
  })
}
