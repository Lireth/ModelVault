import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, Menu, clipboard, shell } from 'electron'
import logger from '../../logger'
import { isInRoot, getModelMeta, removeModelMeta } from '../../services/store'
import { SIDECAR_PREVIEW_EXTS } from '../../services/scanner'
import { wrapHandler, checkModelId, checkModelIdInRoot } from '../handler'

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

/** 路径是否为 .disabled 后缀的禁用模型（F10，大小写不敏感；仅本模块使用） */
function isDisabledPath(p) {
  return typeof p === 'string' && p.toLowerCase().endsWith('.disabled')
}

/** 注册其他模型操作链路的 IPC 处理器 */
export function registerMiscHandlers() {
  // 删除模型文件（移入回收站）并清理关联元数据与同名 sidecar 文件
  wrapHandler('models:deleteModel', async (event, { id } = {}) => {
    const invalid = checkModelId(id) || (isInRoot(id) ? '' : '模型不在当前根目录内，无法删除')
    if (invalid) return { error: invalid }
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
      await shell.trashItem(f).catch((err) => {
        // 回收失败（权限/被占用）不应无声无息：标注/物理文件状态可能不一致
        logger.warn(`sidecar 清理失败（不影响删除）: ${f} ${err.message}`)
      })
    }
    removeModelMeta(id)
    logger.info(`模型已移入回收站: ${id}`)
    return { ok: true }
  }, { errorPrefix: '删除失败' })

  // 卡片/详情右键菜单：主进程构建原生菜单，动作经 menuAction 事件回传渲染进程
  wrapHandler('models:popupMenu', (event, { id } = {}) => {
    const invalid = checkModelIdInRoot(id)
    if (invalid) return { error: invalid }
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
    if (meta.triggerWords) {
      items.push({ label: '复制触发词', click: () => clipboard.writeText(meta.triggerWords) })
    }
    items.push(
      { type: 'separator' },
      // 禁用/启用（F10）：加/去 .disabled 后缀，绘画工具不再加载该文件
      {
        label: isDisabledPath(id) ? '启用此模型' : '禁用此模型',
        click: () => send(isDisabledPath(id) ? 'enableModel' : 'disableModel')
      },
      // 库内移动（F11）
      { label: '移动到…', click: () => send('moveModel') },
      { type: 'separator' },
      { label: meta.favorite ? '取消收藏' : '收藏', click: () => send('toggleFavorite') },
      { label: '移入回收站', click: () => send('deleteModel') }
    )
    Menu.buildFromTemplate(items).popup({ window: win })
    return { ok: true }
  }, { errorPrefix: '打开菜单失败' })

  // 在资源管理器中显示模型文件（仅限当前模型根目录内的路径，C6：
  // 与 deleteModel/popupMenu 的越界校验一致，防止任意路径探测）
  wrapHandler('models:reveal', (event, { path: targetPath } = {}) => {
    if (typeof targetPath !== 'string' || !targetPath || !isInRoot(targetPath)) {
      return { error: '无效的路径' }
    }
    shell.showItemInFolder(targetPath)
    return { ok: true }
  }, { errorPrefix: '定位文件失败' })
}
