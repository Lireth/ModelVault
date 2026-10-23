import fs from 'node:fs/promises'
import { BrowserWindow, Menu, clipboard, dialog, shell } from 'electron'
import logger from '../../logger'
import { atomicWriteFile } from '../../services/atomic-write'
import { getCurrentRoot, getModelMeta, removeModelMeta } from '../../services/store'
import { updateLibraryIndex } from '../../services/library-index'
import { checkLibraryHealth, repairLibraryHealth } from '../../services/library-health'
import {
  forgetDeletedModel,
  listDeletedModels,
  recordModelDeletion,
  restoreDeletedModel
} from '../../services/trash-log'
import { sidecarFilesFor } from '../../services/scanner'
import {
  wrapHandler,
  checkModelIdInRootReal,
  getRealRootPath
} from '../handler'
import { isPathRealWithin } from '../../utils'

/**
 * 其他模型操作链路：删除模型（回收站 + sidecar 清理）、
 * 右键上下文菜单、资源管理器定位。
 */

// sidecarFilesFor 实现位于 services/scanner（F-3 跨库传输共用）；
// 此处 re-export 维持 misc 的既有导入路径（tests/modelsStore.test.js 等）
export { sidecarFilesFor }

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
    // O6：破坏性操作按 realpath 校验归属，拦截库内 junction 指向库外的删除
    const invalid = await checkModelIdInRootReal(id, {
      message: '模型不在当前根目录内，无法删除'
    })
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
    // F-2 回收站桥接：快照元数据并记录原路径（须在 removeModelMeta 之前），
    // 供「最近删除」一键恢复；失败仅告警，不阻塞删除主流程
    await recordModelDeletion(id, sidecarFilesFor(id))
    removeModelMeta(id)
    // O8：即时从本地索引移除，切库秒开不再回放已删除模型
    await updateLibraryIndex(getCurrentRoot(), { removeIds: [id] })
    logger.info(`模型已移入回收站: ${id}`)
    return { ok: true }
  }, { errorPrefix: '删除失败' })

  // 卡片/详情右键菜单：主进程构建原生菜单，动作经 menuAction 事件回传渲染进程
  wrapHandler('models:popupMenu', async (event, { id } = {}) => {
    const invalid = await checkModelIdInRootReal(id)
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
      // 跨库移动/复制（F-3）：选择层在渲染进程弹出
      { label: '移动/复制到其他库…', click: () => send('transferToLibrary') },
      { type: 'separator' },
      { label: meta.favorite ? '取消收藏' : '收藏', click: () => send('toggleFavorite') },
      { label: '移入回收站', click: () => send('deleteModel') }
    )
    Menu.buildFromTemplate(items).popup({ window: win })
    return { ok: true }
  }, { errorPrefix: '打开菜单失败' })

  // 在资源管理器中显示模型文件（仅限当前模型根目录内的路径，C6：
  // 与 deleteModel/popupMenu 的越界校验一致，防止任意路径探测）
  wrapHandler('models:reveal', async (event, { path: targetPath } = {}) => {
    // O6：真实路径归属校验；根目录自身也允许（设置页「打开模型文件夹」）
    const rootReal = await getRealRootPath()
    if (
      typeof targetPath !== 'string' ||
      !targetPath ||
      !rootReal ||
      !(await isPathRealWithin(targetPath, rootReal))
    ) {
      return { error: '无效的路径' }
    }
    shell.showItemInFolder(targetPath)
    return { ok: true }
  }, { errorPrefix: '定位文件失败' })

  // 模型库体检（V-07）：只读报告，不修改任何文件/元数据
  wrapHandler('models:checkHealth', () => checkLibraryHealth(), {
    errorPrefix: '模型库检查失败'
  })

  // 一键修复（V-07）：修复前备份 store.json，孤儿封面移入 .modelvault/trash
  wrapHandler('models:repairHealth', () => repairLibraryHealth(), {
    errorPrefix: '模型库修复失败'
  })

  // F-2 回收站桥接：最近删除记录查看 / 一键恢复 / 忽略。
  // 恢复安全门禁在服务层（isInRoot 限定当前库、原位置占用即拒绝），此处透传
  wrapHandler('models:listDeleted', () => listDeletedModels())
  wrapHandler('models:restoreDeleted', (event, { absPath } = {}) => restoreDeletedModel(absPath), {
    errorPrefix: '恢复失败'
  })
  wrapHandler('models:forgetDeleted', (event, { absPath } = {}) => forgetDeletedModel(absPath))

  // 模型清单导出（FN-04）：渲染层已按当前筛选结果生成文本，主进程只负责
  // 原生保存对话框与原子落盘；不接受渲染层传入路径，避免任意文件写入。
  wrapHandler('models:exportModelList', async (event, { format, content } = {}) => {
    const specs = {
      csv: { ext: 'csv', label: 'CSV 文件' },
      markdown: { ext: 'md', label: 'Markdown 文件' },
      json: { ext: 'json', label: 'JSON 文件' }
    }
    const spec = Object.hasOwn(specs, format) ? specs[format] : null
    if (!spec) return { error: '不支持的导出格式' }
    if (typeof content !== 'string') return { error: '导出内容无效' }
    // 字符上限由 schema 前置把关，这里再按 UTF-8 字节兜底（中文 3 字节/字）
    if (Buffer.byteLength(content, 'utf-8') > 32 * 1024 * 1024) {
      return { error: '导出内容过大（上限 32MB）' }
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const date = new Date().toISOString().slice(0, 10)
    const result = await dialog.showSaveDialog(win, {
      title: '导出模型清单',
      defaultPath: `modelvault-models-${date}.${spec.ext}`,
      filters: [{ name: spec.label, extensions: [spec.ext] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true }
    try {
      await atomicWriteFile(result.filePath, content)
      const stat = await fs.stat(result.filePath)
      logger.info(`模型清单已导出: ${result.filePath}（${stat.size} 字节）`)
      return { ok: true, path: result.filePath, sizeBytes: stat.size }
    } catch (err) {
      logger.warn(`模型清单导出失败: ${err.message}`)
      return { error: `模型清单导出失败: ${err.message}` }
    }
  }, { errorPrefix: '模型清单导出失败' })
}
