import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import logger from '../../logger'
import { relativeWithin } from '../../utils'
import { getCurrentRoot, renameModelMeta, toRelKey } from '../../services/store'
import { sidecarFilesFor } from './misc'
import { LORA_TAG_DEFS, LORA_TAG_KEYS } from '../../../shared/model-categories'
import { MODEL_EXTENSION_NAMES, MODEL_EXTENSION_SET } from '../../../shared/model-extensions'
import { SIDECAR_PREVIEW_EXTS } from '../../services/scanner'
import {
  maintenanceBusyMessage,
  releaseMaintenance,
  tryAcquireMaintenance
} from '../../services/maintenance-lock'
import { transferModelsToLibrary } from '../../services/library-transfer'
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
 *   创建 LoRA 文件夹及其下 7 个分类标签子文件夹（已存在的不动），已标注
 *   LoRA 移入 LoRA/<标签>/，未标注 LoRA 移入 LoRA/ 根目录，元数据键即时
 *   迁移（与 moveModelTo 同一机制）。
 */

/**
 * 移动文件的目标目录（LoRA 一级文件夹 + 7 个标签子文件夹名，与分类标签
 * label 一致，保证移动后重扫的文件夹自动标签与元数据标签一致，形成闭环）：
 * 已标注 LoRA → LoRA/<标签>/，未标注 LoRA → LoRA/ 根目录。
 */
const LORA_DIR = 'LoRA'
const TAG_FOLDER_NAMES = LORA_TAG_DEFS.map((d) => d.label)

/**
 * 计算一键移动的计划（纯函数，便于单测）：
 * subCategory 命中 7 类标签时目标为「根目录/LoRA/标签文件夹/原文件名」，
 * subCategory 为空（未标注 LoRA）时目标为「根目录/LoRA/原文件名」；
 * 非法标签跳过（invalid-tag），已在目标位置的模型计入 skipped（same-dir）。
 * @param {{id: string, subCategory: string}[]} moves 待移动项
 * @param {string} root 模型库根目录
 * @returns {{planned: {id: string, newPath: string}[], skipped: {id: string, reason: string}[]}}
 */
export function planOrganizeMoves(moves, root) {
  const planned = []
  const skipped = []
  for (const item of moves || []) {
    if (!item || typeof item.id !== 'string' || !item.id) continue
    let targetDir = LORA_DIR
    if (item.subCategory) {
      if (!LORA_TAG_KEYS.has(item.subCategory)) {
        skipped.push({ id: item.id, reason: 'invalid-tag' })
        continue
      }
      const label = LORA_TAG_DEFS.find((d) => d.key === item.subCategory)?.label || ''
      if (!label) {
        skipped.push({ id: item.id, reason: 'invalid-tag' })
        continue
      }
      targetDir = path.join(LORA_DIR, label)
    }
    const newPath = path.join(root, targetDir, path.basename(item.id))
    if (path.resolve(newPath) === path.resolve(item.id)) {
      skipped.push({ id: item.id, reason: 'same-dir' })
      continue
    }
    planned.push({ id: item.id, newPath })
  }
  return { planned, skipped }
}

/* ---------------- F2：外部模型导入 ---------------- */

/** 导入时随模型一并搬运的 sidecar 后缀（说明/元数据/预览图） */
const IMPORT_SIDECAR_SUFFIXES = ['.txt', '.civitai.info', ...SIDECAR_PREVIEW_EXTS]

/**
 * 拆分模型文件名（兼容 WebUI 的 `.disabled` 双重后缀）。
 * @param {string} fileName 文件名
 * @returns {{base: string, ext: string, disabled: boolean}}
 */
export function splitModelFileName(fileName) {
  let name = String(fileName || '')
  let disabled = false
  if (name.toLowerCase().endsWith('.disabled')) {
    disabled = true
    name = name.slice(0, -'.disabled'.length)
  }
  const ext = path.extname(name)
  return { base: path.basename(name, ext), ext, disabled }
}

/**
 * 是否为可导入的模型文件（扩展名白名单，支持 .disabled）。
 * @param {string} fileName 文件名
 * @returns {boolean}
 */
export function isImportableModelFile(fileName) {
  const { ext } = splitModelFileName(fileName)
  return MODEL_EXTENSION_SET.has(ext.toLowerCase())
}

/** 目录是否位于 root 内（含 root 自身；Windows 大小写不敏感，O-1 单一实现） */
function isInsideDir(root, target) {
  return relativeWithin(target, root) !== null
}

/** 目标候选名是否与已有模型/同名 sidecar 冲突 */
async function isImportTargetFree(targetDir, fileName) {
  const modelPath = path.join(targetDir, fileName)
  const candidates = [modelPath]
  const { base } = splitModelFileName(fileName)
  for (const suffix of IMPORT_SIDECAR_SUFFIXES) {
    candidates.push(path.join(targetDir, `${base}${suffix}`))
  }
  for (const candidate of candidates) {
    try {
      await fs.access(candidate)
      return false
    } catch {
      /* 不存在 */
    }
  }
  return true
}

/**
 * 为导入模型选择目标文件名：同名冲突时自动追加 ` (n)`（同时保证
 * 同名 sidecar 不覆盖），返回可用的文件名与拆分信息。
 * @param {string} targetDir 目标目录
 * @param {string} sourceName 源文件名
 * @returns {Promise<{fileName: string, base: string, ext: string, disabled: boolean}>}
 */
export async function planImportTarget(targetDir, sourceName) {
  const { base, ext, disabled } = splitModelFileName(sourceName)
  for (let n = 0; n < 1000; n++) {
    const candidateBase = n === 0 ? base : `${base} (${n})`
    const fileName = `${candidateBase}${ext}${disabled ? '.disabled' : ''}`
    if (await isImportTargetFree(targetDir, fileName)) {
      return { fileName, base: candidateBase, ext, disabled }
    }
  }
  throw new Error(`目标名称冲突过多，无法导入: ${sourceName}`)
}

/** 复制/移动单个文件；跨卷移动退化为复制后删除源 */
async function transferFile(src, dst, mode) {
  if (mode === 'move') {
    try {
      await fs.rename(src, dst)
      return
    } catch (err) {
      if (err.code !== 'EXDEV') throw err
    }
  }
  // COPYFILE_EXCL：规划与落盘之间若目标被外部创建，拒绝覆盖而不是静默替换
  await fs.copyFile(src, dst, fsConstants.COPYFILE_EXCL)
  if (mode === 'move') await fs.unlink(src).catch(() => {})
}

/**
 * 导入外部模型文件（复制/移动入台，F2）：
 * - 原生文件选择（多选）+ 目标目录选择（必须位于当前模型库内）；
 * - 逐文件复制/移动，自动搬运同名 `.txt` / `.civitai.info` / 预览图 sidecar；
 * - 目标同名冲突自动追加 ` (n)`，不覆盖库内已有文件；
 * - 源文件已在库内时拒绝（避免绕过库内移动的元数据键迁移）；
 * - 成功后渲染层对目标子树执行局部扫描，新模型即时入列。
 * @returns {Promise<object>}
 */
async function importModels({ mode, win } = {}) {
  if (mode !== 'copy' && mode !== 'move') return { error: '无效的导入方式' }
  const root = getCurrentRoot()
  if (!root) return { error: '尚未选择模型库' }
  const picked = await dialog.showOpenDialog(win, {
    title: mode === 'move' ? '选择要移动入台的模型文件' : '选择要复制入台的模型文件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: '模型文件',
        // .disabled 是 WebUI 的禁用后缀，需单独加入过滤器才可被选中
        extensions: [...MODEL_EXTENSION_NAMES.map((e) => e.slice(1)), 'disabled']
      }
    ]
  })
  if (picked.canceled || picked.filePaths.length === 0) return { canceled: true }

  const targetPick = await dialog.showOpenDialog(win, {
    title: '选择导入目标文件夹（须在当前模型库内）',
    defaultPath: root,
    properties: ['openDirectory', 'createDirectory']
  })
  if (targetPick.canceled || !targetPick.filePaths[0]) return { canceled: true }
  const targetDir = path.resolve(targetPick.filePaths[0])
  if (!isInsideDir(root, targetDir)) {
    return { error: '目标文件夹不在当前模型库内' }
  }
  const targetRelRaw = path.relative(root, targetDir)
  const targetRelDir = targetRelRaw === '' ? '' : targetRelRaw.split(path.sep).join('/')
  if (targetRelDir === '.modelvault' || targetRelDir.startsWith('.modelvault/')) {
    return { error: '不能导入到关联存储目录' }
  }
  // 真实路径校验：拦截库内 junction/符号链接指向库外
  try {
    const realRoot = await fs.realpath(root)
    const realTarget = await fs.realpath(targetDir)
    if (!isInsideDir(realRoot, realTarget)) {
      return { error: '目标文件夹真实路径不在当前模型库内' }
    }
  } catch (err) {
    return { error: `目标文件夹不可访问: ${err.message}` }
  }

  const token = tryAcquireMaintenance('import', root)
  if (!token) return { error: maintenanceBusyMessage() }
  const failed = []
  const warnings = []
  let imported = 0
  let renamed = 0
  const seen = new Set()
  try {
    await fs.mkdir(targetDir, { recursive: true })
    for (const sourceRaw of picked.filePaths) {
      const source = path.resolve(sourceRaw)
      if (seen.has(source)) continue
      seen.add(source)
      const sourceName = path.basename(source)
      if (!isImportableModelFile(sourceName)) {
        failed.push({ source, error: '不支持的模型文件类型' })
        continue
      }
      if (isInsideDir(root, source)) {
        failed.push({ source, error: '源文件已在当前模型库内，请使用库内移动' })
        continue
      }
      try {
        const stat = await fs.lstat(source)
        if (!stat.isFile() || stat.isSymbolicLink()) {
          failed.push({ source, error: '仅支持导入普通文件' })
          continue
        }
      } catch (err) {
        failed.push({ source, error: `无法读取源文件: ${err.message}` })
        continue
      }

      let plan
      try {
        plan = await planImportTarget(targetDir, sourceName)
      } catch (err) {
        failed.push({ source, error: err.message })
        continue
      }
      const targetModel = path.join(targetDir, plan.fileName)
      try {
        await transferFile(source, targetModel, mode)
      } catch (err) {
        failed.push({ source, error: `导入失败: ${err.message}` })
        continue
      }
      imported += 1
      if (plan.fileName !== sourceName) renamed += 1

      // sidecar 同批搬运（失败只告警，不撤销已成功导入的模型）
      const sourceBase = splitModelFileName(sourceName).base
      for (const suffix of IMPORT_SIDECAR_SUFFIXES) {
        const sidecarSource = path.join(path.dirname(source), `${sourceBase}${suffix}`)
        try {
          const sidecarStat = await fs.lstat(sidecarSource)
          if (!sidecarStat.isFile()) continue
        } catch {
          continue
        }
        const sidecarTarget = path.join(targetDir, `${plan.base}${suffix}`)
        try {
          await transferFile(sidecarSource, sidecarTarget, mode)
        } catch (err) {
          warnings.push(`${path.basename(sidecarSource)}: ${err.message}`)
        }
      }
    }
    logger.info(
      `模型导入完成（${mode}）：成功 ${imported}，重命名 ${renamed}，失败 ${failed.length} → ${targetDir}`
    )
    return {
      root,
      targetDir,
      targetRelDir,
      imported,
      renamed,
      failed,
      warnings
    }
  } catch (err) {
    logger.warn(`模型导入失败: ${err.message}`)
    return { error: `模型导入失败: ${err.message}` }
  } finally {
    releaseMaintenance(token)
  }
}

/** 文件名非法字符（Windows 全盘禁用字符；控制字符另行按码点判定） */
const INVALID_FILE_NAME_RE = /[\\/:*?"<>|]/

/**
 * 计算模型重命名目标路径（纯函数，N1）：
 * - 仅允许同目录改名，扩展名保持不变（重命名不承担移动/改类型职责）；
 * - 允许用户粘贴带原扩展名的完整文件名，自动剥离避免双重扩展名；
 * - 禁用中的模型（.disabled）拒绝：sidecar 基名规则不同，先启用再改名。
 * @param {string} id 当前模型绝对路径
 * @param {string} name 新文件名（不含扩展名）
 * @returns {{path: string} | {error: string}}
 */
export function planRenameTarget(id, name) {
  if (typeof id !== 'string' || !id) return { error: '无效的模型标识' }
  if (typeof name !== 'string') return { error: '请输入新的文件名' }
  const ext = path.extname(id)
  if (!ext) return { error: '模型文件缺少扩展名' }
  if (id.toLowerCase().endsWith('.disabled')) {
    return { error: '禁用中的模型请先启用后再重命名' }
  }
  let base = name.trim()
  if (base.toLowerCase().endsWith(ext.toLowerCase())) {
    base = base.slice(0, -ext.length).trim()
  }
  if (!base) return { error: '文件名不能为空' }
  if (base.length > 120) return { error: '文件名过长（最多 120 个字符）' }
  if (
    INVALID_FILE_NAME_RE.test(base) ||
    [...base].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)
  ) {
    return { error: '文件名包含非法字符' }
  }
  if (base === '.' || base === '..') return { error: '文件名不能为 . 或 ..' }
  const newPath = path.join(path.dirname(id), `${base}${ext}`)
  if (newPath.toLowerCase() === id.toLowerCase()) return { path: id }
  return { path: newPath }
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

  // 模型文件重命名（N1）：仅改当前目录内的文件名，扩展名保持不变；
  // 同名 sidecar 一并改名（目标已存在则跳过不覆盖），元数据键即时迁移
  wrapHandler('models:renameModel', async (event, { id, name } = {}) => {
    const invalid = checkModelIdInRoot(id)
    if (invalid) return { error: invalid }
    const plan = planRenameTarget(id, name)
    if (plan.error) return { error: plan.error }
    if (plan.path === id) {
      return { path: id, renamedSidecars: 0, sidecarWarnings: [] }
    }
    // 目标存在则拒绝；仅大小写变化的改名（Windows 大小写不敏感）跳过存在性检查
    if (plan.path.toLowerCase() !== id.toLowerCase()) {
      try {
        await fs.access(plan.path)
        return { error: '目标文件名已存在' }
      } catch {
        /* 不存在，可改名 */
      }
    }
    try {
      await fs.rename(id, plan.path)
    } catch (err) {
      if (err.code === 'EXDEV') {
        return { error: '不支持跨磁盘重命名（目标须与模型在同一磁盘）' }
      }
      logger.warn(`模型重命名失败: ${id} ${err.message}`)
      return { error: `重命名失败: ${err.message}` }
    }
    const dir = path.dirname(id)
    const oldBase = path.basename(id, path.extname(id))
    const newBase = path.basename(plan.path, path.extname(plan.path))
    let renamedSidecars = 0
    const sidecarWarnings = []
    for (const f of sidecarFilesFor(id)) {
      const suffix = path.basename(f).slice(oldBase.length)
      const target = path.join(dir, `${newBase}${suffix}`)
      // 仅大小写变化时目标即源文件本身（Windows 大小写不敏感），不做事前冲突检查
      if (target.toLowerCase() !== f.toLowerCase()) {
        try {
          await fs.access(target)
          sidecarWarnings.push(`${path.basename(f)} 的目标已存在，已跳过`)
          continue
        } catch {
          /* 目标不存在，可改名 */
        }
      }
      try {
        await fs.rename(f, target)
        renamedSidecars += 1
      } catch (err) {
        if (err.code !== 'ENOENT') {
          sidecarWarnings.push(`${path.basename(f)}: ${err.message}`)
        }
      }
    }
    renameModelMeta(id, plan.path)
    logger.info(`模型已重命名: ${path.basename(id)} -> ${path.basename(plan.path)}`)
    return { path: plan.path, renamedSidecars, sidecarWarnings }
  }, { errorPrefix: '重命名失败' })

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

  // 跨库移动/复制（F-3）：目标必须是已保存的其他模型库；文件/sidecar/封面/
  // 元数据保持相对路径整体迁移，安全校验与维护锁在服务层（library-transfer）
  wrapHandler('models:transferToLibrary', async (event, { ids, targetRoot, mode } = {}) => {
    if (!Array.isArray(ids) || ids.length === 0) {
      return { error: '没有可传输的模型' }
    }
    if (ids.length > 500) {
      return { error: '单次最多传输 500 个模型' }
    }
    return transferModelsToLibrary({ ids, targetRoot, mode })
  }, { errorPrefix: '跨库传输失败' })

  // 一键移动文件（自动标签整理）：根目录创建 LoRA 文件夹及其下 7 个标签
  // 子文件夹（已存在不动），已标注 LoRA 移入 LoRA/<标签>/，未标注 LoRA 移入
  // LoRA/ 根目录；元数据键即时迁移，watcher 触发局部重扫。
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
    // 创建 LoRA 一级目录与 7 个标签子文件夹（recursive：已存在时静默保持原样）
    try {
      await fs.mkdir(path.join(root, LORA_DIR), { recursive: true })
      for (const folder of TAG_FOLDER_NAMES) {
        await fs.mkdir(path.join(root, LORA_DIR, folder), { recursive: true })
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

  // F2：外部模型导入（复制/移动入台）
  wrapHandler(
    'models:importModels',
    (event, { mode } = {}) =>
      importModels({ mode, win: BrowserWindow.fromWebContents(event.sender) }),
    { errorPrefix: '模型导入失败' }
  )
}
