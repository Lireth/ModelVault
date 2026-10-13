import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import logger from '../../logger'
import {
  getCoversDir,
  getCurrentRoot,
  getModelMeta,
  getSettings,
  isInRoot,
  relativizeCover,
  renameModelMeta,
  setModelMeta,
  toRelKey
} from '../../services/store'
import { computeFileSha256 } from '../../services/hash'
import {
  CIVITAI_API,
  downloadCoverImage,
  downloadToFile,
  fetchVersion,
  matchByHash,
  parseCivitaiVersionId
} from '../../services/civitai'
import { civitaiImportPatch } from '../../services/scanner'
import { hasImageMagic } from '../../services/covers'
import { sidecarFilesFor } from './misc'
import { coverListFromMeta } from './covers'
import { resolveCoverSafe } from './decorate'
import { toImageUrl } from '../../protocol'
import { wrapHandler, checkModelIdInRoot } from '../handler'

/**
 * 文件级操作链路（批次 4）：
 * - models:hashLibrary / models:cancelHash：全库 SHA256 后台批算（F9），
 *   进度经 models:hashProgress 推送，完成后经 models:hashReady 批量就地更新；
 * - models:toggleDisabled：加/去 .disabled 后缀（F10，WebUI 生态通行的
 *   「禁用而非删除」）。改名同时主动迁移元数据键——.disabled 使扩展名
 *   变化，relink 的同名/同目录规则均不命中，主动迁移保证标注即时跟随；
 * - models:moveModelTo：库内移动/归档（F11），目标目录经原生对话框选择，
 *   同名 sidecar 一并移动，移动后元数据键即时迁移，watcher 触发局部重扫。
 * 历史说明：整理功能面板曾在精简阶段移除；本模块只做单文件粒度的
 * 最小闭环，不恢复整套整理 UI。
 */

/** 批算状态锁（与扫描锁独立：哈希是纯读操作，不与扫描互斥） */
let hashing = false
let hashAbort = null

/** 在线匹配批状态锁（F13） */
let matching = false
let matchAbort = null

/** 下载状态锁（F14）：同时只允许一个下载（磁盘与带宽考虑） */
let downloading = false
let downloadAbort = null

/** 是否需要（重）算：无哈希，或 mtime 与计算时不同（F9 复用条件） */
function needsHash(meta, mtimeMs) {
  return !meta?.hash || meta.hashMtime !== mtimeMs
}

/** Civitai API Token（设置页配置，可空） */
function civitaiToken() {
  return (getSettings().civitaiToken || '').trim()
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 注册文件操作链路的 IPC 处理器 */
export function registerFilesHandlers() {
  // 全库后台批算 SHA256（F9）：只补算缺失/过期的，已算且 mtime 未变的复用。
  // 模型清单由渲染层传入（id/mtimeMs，与最近扫描结果同源）——主进程不
  // 持久保存扫描结果，重复扫描既慢又可能与用户视角不一致
  wrapHandler('models:hashLibrary', async (event, { models } = {}) => {
    if (hashing) return { error: '正在计算哈希中' }
    if (!Array.isArray(models)) return { error: '无效的模型清单' }
    if (models.length > 100000) return { error: '模型清单过大' }

    const win = BrowserWindow.fromWebContents(event.sender)
    const candidates = []
    for (const m of models) {
      // 越界/无效条目跳过而非整体失败（清单与主进程状态的陈旧差异可容忍）
      if (typeof m?.id !== 'string' || !m.id || !isInRoot(m.id)) continue
      if (!Number.isFinite(m.mtimeMs)) continue
      if (needsHash(getModelMeta(m.id), m.mtimeMs)) {
        candidates.push({ id: m.id, mtimeMs: m.mtimeMs })
      }
    }
    if (candidates.length === 0) {
      return { computed: 0, skipped: models.length, canceled: false }
    }

    hashing = true
    hashAbort = new AbortController()
    const signal = hashAbort.signal
    const send = (channel, payload) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
    }
    const startedAt = Date.now()
    const updates = []
    let done = 0
    try {
      for (const { id, mtimeMs } of candidates) {
        if (signal.aborted) break
        let hash
        try {
          hash = await computeFileSha256(id, signal)
        } catch (err) {
          if (err?.name === 'AbortError') break
          logger.warn(`哈希计算失败（跳过）: ${id} ${err.message}`)
          continue
        }
        // 合并持久化（hashMtime 记录计算时的 mtime，重启免重算）
        const meta = getModelMeta(id) || {}
        setModelMeta(id, { ...meta, hash, hashMtime: mtimeMs })
        updates.push({ id, hash })
        done += 1
        send('models:hashProgress', { done, total: candidates.length, current: id })
      }
      // 完成后批量推送就地更新（逐个推送会使渲染层 filteredModels 反复失效）
      if (updates.length > 0) send('models:hashReady', { updates })
      const canceled = signal.aborted
      logger.info(
        `哈希批算${canceled ? '已取消' : '完成'}：${updates.length} 个模型 / 耗时 ${Date.now() - startedAt}ms`
      )
      return { computed: updates.length, skipped: models.length - candidates.length, canceled }
    } finally {
      hashing = false
      hashAbort = null
    }
  }, { errorPrefix: '哈希批算失败' })

  // 取消进行中的哈希批算（进行中的单文件算完后停止，已算部分保留）
  wrapHandler('models:cancelHash', () => {
    if (hashing && hashAbort) {
      hashAbort.abort()
      return { ok: true }
    }
    return { ok: false }
  })

  // 加/去 .disabled 后缀（F10）：幂等；目标名已存在时拒绝
  wrapHandler('models:toggleDisabled', async (event, { id, disabled } = {}) => {
    const invalid = checkModelIdInRoot(id)
    if (invalid) return { error: invalid }
    if (typeof disabled !== 'boolean') return { error: '无效的禁用状态' }
    const isCurrently = id.toLowerCase().endsWith('.disabled')
    if (isCurrently === disabled) return { path: id }
    const newPath = disabled ? `${id}.disabled` : id.replace(/\.disabled$/i, '')
    try {
      await fs.access(newPath)
      return { error: '目标文件名已存在' }
    } catch {
      /* 不存在，可改名 */
    }
    try {
      await fs.rename(id, newPath)
    } catch (err) {
      logger.warn(`禁用/启用改名失败: ${id} ${err.message}`)
      return { error: `改名失败: ${err.message}` }
    }
    renameModelMeta(id, newPath)
    logger.info(`模型已${disabled ? '禁用' : '启用'}: ${path.basename(newPath)}`)
    return { path: newPath }
  }, { errorPrefix: '禁用/启用失败' })

  // 库内移动/归档（F11）：目录选择对话框 + 同名 sidecar 一并移动
  wrapHandler('models:moveModelTo', async (event, { id } = {}) => {
    const invalid = checkModelIdInRoot(id)
    if (invalid) return { error: invalid }
    const win = BrowserWindow.fromWebContents(event.sender)
    const pick = await dialog.showOpenDialog(win, {
      title: '选择目标文件夹（须在当前模型库内）',
      properties: ['openDirectory']
    })
    if (pick.canceled || !pick.filePaths[0]) return { canceled: true }
    const targetDir = pick.filePaths[0]
    // 目标目录必须在当前库内（以构造文件路径换算相对键判定）
    const newPath = path.join(targetDir, path.basename(id))
    if (!toRelKey(newPath)) {
      return { error: '目标文件夹不在当前模型库内' }
    }
    if (newPath === id) return { path: id }
    try {
      await fs.access(newPath)
      return { error: '目标位置已存在同名文件' }
    } catch {
      /* 不存在，可移动 */
    }
    try {
      await fs.rename(id, newPath)
    } catch (err) {
      if (err.code === 'EXDEV') {
        return { error: '不支持跨磁盘移动（目标文件夹须与模型库在同一磁盘）' }
      }
      logger.warn(`模型移动失败: ${id} ${err.message}`)
      return { error: `移动失败: ${err.message}` }
    }
    // 同名 sidecar（预览图/说明文本）一并移动：整理场景下说明与模型不应分家
    for (const f of sidecarFilesFor(id)) {
      await fs.rename(f, path.join(targetDir, path.basename(f))).catch(() => {})
    }
    renameModelMeta(id, newPath)
    logger.info(`模型已移动: ${id} -> ${newPath}`)
    return { path: newPath }
  }, { errorPrefix: '移动失败' })

  /* ---------------- Civitai 在线能力（F13/F14，批次 5） ---------------- */

  // 批量在线匹配（F13）：按 SHA256 查询 Civitai，补全触发词/NSFW/封面。
  // items 为 [{ id, hash }]（须先经「查重」算出哈希）；空字段才写入，
  // 与 sidecar/civitai.info 导入同一原则，绝不覆盖用户已有标注
  wrapHandler('models:civitaiMatch', async (event, { items } = {}) => {
    if (matching) return { error: '正在在线匹配中' }
    if (!Array.isArray(items)) return { error: '无效的清单' }
    const candidates = items.filter(
      (x) => typeof x?.id === 'string' && isInRoot(x.id) && /^[0-9a-f]{64}$/.test(x.hash || '')
    )
    if (candidates.length === 0) {
      return { error: '选中模型均无有效哈希，请先执行「查重」计算 SHA256' }
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const token = civitaiToken()
    matching = true
    matchAbort = new AbortController()
    const signal = matchAbort.signal
    const send = (channel, payload) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
    }
    let matched = 0
    let noMatch = 0
    let failed = 0
    let covers = 0
    const updates = []
    try {
      for (let i = 0; i < candidates.length; i++) {
        if (signal.aborted) break
        const { id, hash } = candidates[i]
        send('models:civitaiProgress', { done: i, total: candidates.length, current: id })
        const r = await matchByHash(hash, token, signal)
        if (r.error) {
          failed += 1
          logger.warn(`Civitai 匹配失败（跳过）: ${id} ${r.error}`)
          continue
        }
        if (!r.matched) {
          noMatch += 1
          continue
        }
        matched += 1
        const meta = getModelMeta(id) || {}
        const patch = civitaiImportPatch(meta, r.version) || {}
        // 封面：仅元数据无任何封面时下载示例图（空字段才写入）
        if ((!Array.isArray(meta.covers) || meta.covers.length === 0) && r.version.imageUrls[0]) {
          try {
            const abs = await downloadCoverImage(r.version.imageUrls[0], getCoversDir(), hasImageMagic, {
              token,
              signal
            })
            if (abs) {
              const rel = relativizeCover(abs)
              if (rel) {
                patch.covers = [...(meta.covers || []), rel]
                patch.cover = meta.cover || rel
                covers += 1
              }
            }
          } catch (err) {
            if (err?.name === 'AbortError') throw err
            // 封面失败不影响标注补全
          }
        }
        const merged = Object.keys(patch).length > 0 ? setModelMeta(id, { ...meta, ...patch }) : null
        if (merged) {
          // 推送渲染层就地更新所需字段（与装饰结果同构）
          updates.push({
            id,
            fields: {
              triggerWords: merged.triggerWords || '',
              triggerWordsSource: merged.triggerWordsSource || '',
              nsfw: merged.nsfw === true,
              cover: resolveCoverSafe(merged.cover || ''),
              coverUrl: merged.cover ? toImageUrl(resolveCoverSafe(merged.cover)) : '',
              covers: coverListFromMeta(merged)
            }
          })
        }
        // 公开 API 礼貌间隔，避免限流
        if (i < candidates.length - 1) await sleep(600)
      }
      if (updates.length > 0) send('models:civitaiApplied', { updates })
      const canceled = signal.aborted
      send('models:civitaiProgress', { done: candidates.length, total: candidates.length, current: '' })
      logger.info(
        `Civitai 批量匹配${canceled ? '已取消' : '完成'}：命中 ${matched}（补封面 ${covers}）/ 未命中 ${noMatch} / 失败 ${failed}`
      )
      return { matched, noMatch, failed, covers, canceled }
    } finally {
      matching = false
      matchAbort = null
    }
  }, { errorPrefix: '在线匹配失败' })

  // 取消在线匹配批
  wrapHandler('models:cancelCivitaiMatch', () => {
    if (matching && matchAbort) {
      matchAbort.abort()
      return { ok: true }
    }
    return { ok: false }
  })

  // 解析 Civitai 模型页链接为版本预览（F14 第一步：下载前确认）
  wrapHandler('models:resolveCivitaiLink', async (event, { url } = {}) => {
    const versionId = parseCivitaiVersionId(url)
    if (!versionId) {
      return { error: '无法解析链接：支持 civitai.com/models/… 页面链接（须含版本号）' }
    }
    const r = await fetchVersion(versionId, civitaiToken(), undefined)
    if (r.error) return { error: r.error }
    return { version: r.version }
  }, { errorPrefix: '链接解析失败' })

  // 下载 Civitai 模型到当前库（F14 第二步）：流式下载 + 官方 SHA256 校验 +
  // 成功后预写元数据（触发词/NSFW/哈希——下载完成即有哈希，查重免算）
  wrapHandler('models:downloadCivitaiModel', async (event, { versionId, filename, sha256, trainedWords, nsfw } = {}) => {
    if (downloading) return { error: '已有下载进行中' }
    if (!Number.isInteger(versionId) || versionId <= 0) return { error: '无效的版本号' }
    const root = getCurrentRoot()
    if (!root) return { error: '尚未选择模型文件夹' }
    const safeName = path.basename(
      typeof filename === 'string' && filename ? filename : `civitai-${versionId}.safetensors`
    )
    if (!/\.safetensors$/i.test(safeName)) return { error: '仅支持下载 .safetensors 模型文件' }
    const dest = path.join(root, safeName)
    try {
      await fs.access(dest)
      return { error: '库根目录已存在同名文件' }
    } catch {
      /* 不存在，可下载 */
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const token = civitaiToken()
    downloading = true
    downloadAbort = new AbortController()
    const signal = downloadAbort.signal
    const send = (channel, payload) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
    }
    try {
      const result = await downloadToFile(`${CIVITAI_API}/download/models/${versionId}`, dest, {
        token,
        expectedSha256: /^[0-9a-f]{64}$/.test(sha256 || '') ? sha256 : '',
        onProgress: (p) => send('models:downloadProgress', p),
        signal
      })
      // 预写元数据：下载完成即有官方哈希（hashMtime 锚定当前 mtime）
      const stat = await fs.stat(dest)
      const patch = { hash: result.sha256, hashMtime: stat.mtimeMs }
      if (Array.isArray(trainedWords) && trainedWords.length > 0) {
        patch.triggerWords = trainedWords.filter((w) => typeof w === 'string' && w.trim()).join(', ')
        patch.triggerWordsSource = 'civitai'
      }
      if (nsfw === true) patch.nsfw = true
      setModelMeta(dest, patch)
      logger.info(`模型下载完成: ${dest}（${result.received} 字节，SHA256 校验通过）`)
      return { path: dest, sizeBytes: result.received, sha256: result.sha256 }
    } finally {
      downloading = false
      downloadAbort = null
    }
  }, { errorPrefix: '下载失败' })

  // 取消进行中的下载（半成品文件由下载函数自身清理）
  wrapHandler('models:cancelDownload', () => {
    if (downloading && downloadAbort) {
      downloadAbort.abort()
      return { ok: true }
    }
    return { ok: false }
  })
}
