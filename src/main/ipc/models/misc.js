import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, Menu, clipboard, dialog, ipcMain, shell } from 'electron'
import logger from '../../logger'
import { isInRoot, getModelMeta, removeModelMeta } from '../../services/store'
import { SIDECAR_PREVIEW_EXTS } from '../../services/scanner'

/**
 * 其他模型操作链路：删除模型（回收站 + sidecar 清理）、
 * 右键上下文菜单、资源管理器定位、模型列表导出（E2）。
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

  // 导出模型列表（E2）：渲染进程传当前列表行，主进程弹保存对话框并写文件。
  // 复用已装饰的模型数据（备注/参数/收藏等随行携带），CSV 带 BOM 便于 Excel 打开
  ipcMain.handle('models:exportList', async (event, { format, rows } = {}) => {
    if (format !== 'csv') {
      return { error: '不支持的导出格式' }
    }
    if (!Array.isArray(rows)) {
      return { error: '无效的导出数据' }
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const date = new Date().toISOString().slice(0, 10)
    const result = await dialog.showSaveDialog(win, {
      title: '导出模型列表',
      defaultPath: `modelvault-export-${date}.${format}`,
      filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
    })
    if (result.canceled || !result.filePath) {
      return { canceled: true }
    }
    try {
      await fs.writeFile(result.filePath, buildModelsCsv(rows), 'utf-8')
      logger.info(`模型列表已导出: ${result.filePath}（${rows.length} 条）`)
      return { path: result.filePath, count: rows.length }
    } catch (err) {
      logger.warn(`模型列表导出失败: ${err.message}`)
      return { error: `导出失败: ${err.message}` }
    }
  })
}

/** CSV 导出的列定义（E2）：顺序即文件列顺序 */
const EXPORT_COLUMNS = [
  ['name', '名称'],
  ['alias', '备注名'],
  ['type', '分类'],
  ['subCategory', '分类标签'],
  ['favorite', '收藏'],
  ['rating', '评分'],
  ['nsfw', 'NSFW'],
  ['triggerWords', '触发词'],
  ['steps', '采样步数'],
  ['cfg', 'CFG'],
  ['sampler', '采样器'],
  ['scheduler', '调度器'],
  ['precision', '精度'],
  ['resolution', '推荐分辨率'],
  ['sizeBytes', '文件大小(字节)'],
  ['mtimeIso', '修改时间'],
  ['note', '备注'],
  ['path', '文件路径']
]

/** CSV 字段转义：含分隔符/引号/换行的字段包裹双引号，内部引号翻倍；null/undefined 输出空串 */
function csvEscape(value) {
  const s = value == null ? '' : String(value)
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/**
 * 将模型行数组构建为 CSV 文本（纯函数，E2）。
 * @param {Array<object>} rows 渲染进程传来的模型行（appStore.exportModels 组装）
 * @returns {string} CSV 文本（含 BOM，便于 Excel 直接打开不乱码）
 */
export function buildModelsCsv(rows) {
  const header = EXPORT_COLUMNS.map(([, title]) => csvEscape(title)).join(',')
  const lines = rows.map((r) => {
    const p = r.params || {}
    const cells = [
      r.name,
      r.alias,
      r.type,
      r.subCategory,
      r.favorite ? '是' : '',
      Number.isFinite(r.rating) && r.rating > 0 ? r.rating : '',
      r.nsfw ? '是' : '',
      r.triggerWords,
      Number.isFinite(p.steps) ? p.steps : '',
      Number.isFinite(p.cfgMin) && Number.isFinite(p.cfgMax) ? `${p.cfgMin}~${p.cfgMax}` : '',
      p.sampler,
      p.scheduler,
      p.precision,
      Number.isFinite(p.resMin) && Number.isFinite(p.resMax) ? `${p.resMin}x${p.resMax}` : '',
      Number.isFinite(r.size) ? r.size : '',
      Number.isFinite(r.mtimeMs) ? new Date(r.mtimeMs).toISOString() : '',
      r.note,
      r.id
    ]
    return cells.map(csvEscape).join(',')
  })
  // \uFEFF BOM：Excel 识别 UTF-8
  return `\uFEFF${header}\n${lines.join('\n')}\n`
}
