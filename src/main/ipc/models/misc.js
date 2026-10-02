import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, Menu, clipboard, ipcMain, shell } from 'electron'
import logger from '../../logger'
import { isInRoot, getModelMeta, removeModelMeta } from '../../services/store'
import { SIDECAR_PREVIEW_EXTS } from '../../services/scanner'

/**
 * 其他模型操作链路：删除模型（回收站 + sidecar 清理）、
 * 右键上下文菜单、资源管理器定位。
 */

/** 模型同名的 sidecar 文件（SD WebUI 惯例：同名预览图 + 说明文本）。
 * 图片候选与展示侧共用 SIDECAR_PREVIEW_EXTS，保证清理集与展示集一致（B17） */
export function sidecarFilesFor(absModelPath) {
  const dir = path.dirname(absModelPath)
  const base = path.basename(absModelPath, path.extname(absModelPath))
  const files = [path.join(dir, `${base}.txt`)]
  for (const ext of SIDECAR_PREVIEW_EXTS) {
    files.push(path.join(dir, `${base}${ext}`))
  }
  return files
}

/** 将推荐参数格式化为可复制的文本（用于右键菜单「复制推荐参数」） */
export function paramSummaryFromMeta(params) {
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

/** 注册其他模型操作链路的 IPC 处理器 */
export function registerMiscHandlers() {
  // 删除模型文件（移入回收站）并清理关联元数据与同名 sidecar 文件
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

  // 卡片/详情右键菜单：主进程构建原生菜单，动作经 menuAction 事件回传渲染进程
  ipcMain.handle('models:popupMenu', (event, { id } = {}) => {
    if (typeof id !== 'string' || !id || !isInRoot(id)) {
      return { error: '无效的模型标识' }
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const meta = getModelMeta(id) || {}
    // 菜单项点击时窗口可能已关闭（打开菜单后按 Alt+F4），须判销毁防 webContents 抛错
    const send = (action) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('models:menuAction', { id, action })
      }
    }
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

  // 在资源管理器中显示模型文件（仅限当前模型根目录内的路径，C6：
  // 与 deleteModel/popupMenu 的越界校验一致，防止任意路径探测）
  ipcMain.handle('models:reveal', (event, { path: targetPath } = {}) => {
    if (typeof targetPath !== 'string' || !targetPath || !isInRoot(targetPath)) {
      return { error: '无效的路径' }
    }
    shell.showItemInFolder(targetPath)
    return { ok: true }
  })
}
