import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, Menu, clipboard, dialog, shell } from 'electron'
import logger from '../../logger'
import { isInRoot, getModelMeta, removeModelMeta } from '../../services/store'
import { SIDECAR_PREVIEW_EXTS } from '../../services/scanner'
import { wrapHandler, checkModelId, checkModelIdInRoot } from '../handler'

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

/** 路径是否为 .disabled 后缀的禁用模型（F10，大小写不敏感） */
export function isDisabledPath(p) {
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

  // 导出模型列表（E2）：渲染进程传当前列表行，主进程弹保存对话框并写文件。
  // 复用已装饰的模型数据（备注/参数/收藏等随行携带），CSV 带 BOM 便于 Excel 打开
  wrapHandler('models:exportList', async (event, { format, rows } = {}) => {
    if (format !== 'csv') {
      return { error: '不支持的导出格式' }
    }
    if (!Array.isArray(rows)) {
      return { error: '无效的导出数据' }
    }
    if (rows.length > 100000) {
      return { error: '导出数据量过大' }
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
  }, { errorPrefix: '导出失败' })
}

/** CSV 导出的列定义（E2）：顺序即文件列顺序 */
const EXPORT_COLUMNS = [
  ['name', '名称'],
  ['alias', '备注名'],
  ['type', '分类'],
  ['subCategory', '分类标签'],
  ['baseModel', '基底模型'],
  ['author', '作者'],
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
  ['covers', '封面数'],
  ['note', '备注'],
  ['relDir', '所在目录'],
  ['path', '文件路径']
]

/**
 * CSV 公式注入防护（O7）：模型名/备注等字段可能来自不可信的下载来源，
 * Excel 打开 CSV 时以 = + - @ 等开头的单元格会被解析执行为公式
 *（=cmd 系可执行 DDE，=WEBSERVICE 可外泄数据）。危险前缀字段前置
 * 单引号使其成为纯文本（Excel 惯例转义，数据中的引号在读取方可见）。
 */
const FORMULA_PREFIX_RE = /^[=+\-@\t\r]/

/** CSV 字段转义：含分隔符/引号/换行的字段包裹双引号，内部引号翻倍；
 *  危险公式前缀先加单引号防注入；null/undefined 输出空串 */
function csvEscape(value) {
  let s = value == null ? '' : String(value)
  if (FORMULA_PREFIX_RE.test(s)) {
    s = `'${s}`
  }
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
      r.autoInfo?.baseModel || '',
      r.autoInfo?.author || '',
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
      Array.isArray(r.covers) ? r.covers.length : 0,
      r.note,
      r.relDir || '',
      r.id
    ]
    return cells.map(csvEscape).join(',')
  })
  // \uFEFF BOM：Excel 识别 UTF-8
  return `\uFEFF${header}\n${lines.join('\n')}\n`
}
