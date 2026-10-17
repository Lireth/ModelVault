import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import logger from '../../logger'
import { getCurrentRoot, renameModelMeta, toRelKey } from '../../services/store'
import { sidecarFilesFor } from './misc'
import { LORA_TAG_DEFS, LORA_TAG_KEYS } from '../../../shared/model-categories'
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
 * - models:organizeByTags：一键移动文件（自动标签整理）：在模型库根目录
 *   创建 7 个分类标签文件夹（已存在的不动），把已分配标签的模型移动到
 *   对应文件夹，元数据键即时迁移（与 moveModelTo 同一机制）。
 */

/**
 * 移动文件的目标文件夹名（与分类标签 label 一致，保证移动后重扫的
 * 文件夹自动标签与元数据标签一致，形成闭环）
 */
const TAG_FOLDER_NAMES = LORA_TAG_DEFS.map((d) => d.label)

/**
 * 计算一键移动的计划（纯函数，便于单测）：
 * 校验标签合法性，按「根目录/标签文件夹/原文件名」生成目标路径；
 * 已在目标位置的模型计入 skipped（same-dir），不再重复移动。
 * @param {{id: string, subCategory: string}[]} moves 待移动项
 * @param {string} root 模型库根目录
 * @returns {{planned: {id: string, newPath: string}[], skipped: {id: string, reason: string}[]}}
 */
export function planOrganizeMoves(moves, root) {
  const planned = []
  const skipped = []
  for (const item of moves || []) {
    if (!item || typeof item.id !== 'string' || !item.id) continue
    if (!LORA_TAG_KEYS.has(item.subCategory)) {
      skipped.push({ id: item.id, reason: 'invalid-tag' })
      continue
    }
    const label = LORA_TAG_DEFS.find((d) => d.key === item.subCategory)?.label || ''
    if (!label) {
      skipped.push({ id: item.id, reason: 'invalid-tag' })
      continue
    }
    const newPath = path.join(root, label, path.basename(item.id))
    if (path.resolve(newPath) === path.resolve(item.id)) {
      skipped.push({ id: item.id, reason: 'same-dir' })
      continue
    }
    planned.push({ id: item.id, newPath })
  }
  return { planned, skipped }
}

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

  // 一键移动文件（自动标签整理）：根目录创建 7 个标签文件夹（已存在不动），
  // 把已分配标签的模型移入对应文件夹；元数据键即时迁移，watcher 触发局部重扫。
  // 单个失败（同名冲突等）不中断整批，结果按模型反馈。
  wrapHandler('models:organizeByTags', async (event, { moves } = {}) => {
    if (!Array.isArray(moves) || moves.length === 0) {
      return { error: '没有需要移动的模型' }
    }
    if (moves.length > 10000) {
      return { error: '单次最多移动 10000 个模型' }
    }
    const root = getCurrentRoot()
    if (!root) return { error: '未选择模型库根目录' }
    // 逐项校验归属：非法项跳过而非整体失败（批量场景保持其余项可用）
    const valid = []
    const skipped = []
    for (const item of moves) {
      if (!item || typeof item.id !== 'string') continue
      if (checkModelIdInRoot(item.id)) {
        skipped.push({ id: item.id, reason: 'out-of-root' })
        continue
      }
      valid.push(item)
    }
    const { planned, skipped: planSkipped } = planOrganizeMoves(valid, root)
    skipped.push(...planSkipped)
    if (planned.length === 0) {
      return { moved: 0, failed: [], skipped }
    }
    // 创建 7 个标签文件夹（recursive：已存在时静默保持原样）
    try {
      for (const folder of TAG_FOLDER_NAMES) {
        await fs.mkdir(path.join(root, folder), { recursive: true })
      }
    } catch (err) {
      return { error: `创建分类文件夹失败: ${err.message}` }
    }
    let moved = 0
    const failed = []
    for (const { id, newPath } of planned) {
      try {
        await fs.access(newPath)
        failed.push({ id, error: '目标位置已存在同名文件' })
        continue
      } catch {
        /* 不存在，可移动 */
      }
      try {
        await fs.rename(id, newPath)
      } catch (err) {
        logger.warn(`一键移动失败: ${id} ${err.message}`)
        failed.push({ id, error: err.message })
        continue
      }
      // 同名 sidecar（预览图/说明文本）一并移动，与 moveModelTo 同一约定
      for (const f of sidecarFilesFor(id)) {
        await fs.rename(f, path.join(path.dirname(newPath), path.basename(f))).catch(() => {})
      }
      renameModelMeta(id, newPath)
      moved += 1
    }
    logger.info(`一键移动文件完成: 移动 ${moved}，失败 ${failed.length}，跳过 ${skipped.length}`)
    return { moved, failed, skipped }
  }, { errorPrefix: '一键移动文件失败' })
}
