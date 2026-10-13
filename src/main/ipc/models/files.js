import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import logger from '../../logger'
import { renameModelMeta, toRelKey } from '../../services/store'
import { sidecarFilesFor } from './misc'
import { wrapHandler, checkModelIdInRoot } from '../handler'

/**
 * 文件级操作链路（批次 4）：
 * - models:toggleDisabled：加/去 .disabled 后缀（F10，WebUI 生态通行的
 *   「禁用而非删除」）。改名同时主动迁移元数据键——.disabled 使扩展名
 *   变化，relink 的同名/同目录规则均不命中，主动迁移保证标注即时跟随；
 * - models:moveModelTo：库内移动/归档（F11），目标目录经原生对话框选择，
 *   同名 sidecar 一并移动，移动后元数据键即时迁移，watcher 触发局部重扫。
 * 历史说明：整理功能面板曾在精简阶段移除；本模块只做单文件粒度的
 * 最小闭环，不恢复整套整理 UI。
 */

/** 注册文件操作链路的 IPC 处理器 */
export function registerFilesHandlers() {
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
}
