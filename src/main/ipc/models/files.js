import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import logger from '../../logger'
import { isPathRealWithin, relativeWithin } from '../../utils'
import { getCurrentRoot, renameModelMeta, toRelKey } from '../../services/store'
import { sidecarFilesFor } from './misc'
import {
  LORA_DIR,
  LORA_TAG_DEFS,
  LORA_TAG_KEYS,
} from '../../../shared/model-categories'
import {
  MODEL_EXTENSION_NAMES,
  MODEL_EXTENSION_SET,
} from '../../../shared/model-extensions'
import {
  MAX_ORGANIZE_MOVES,
  MAX_TRANSFER_IDS,
} from '../../../shared/ipc-schema'
import { SIDECAR_PREVIEW_EXTS, sidecarBaseOf } from '../../services/scanner'
import {
  maintenanceBusyMessage,
  releaseMaintenance,
  tryAcquireMaintenance,
} from '../../services/maintenance-lock'
import { transferModelsToLibrary } from '../../services/library-transfer'
import {
  wrapHandler,
  checkModelIdInRootReal,
  getRealRootPath,
} from '../handler'

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
 * LORA_DIR 名称由 shared/model-categories 单一来源提供（渲染层批量整理的
 * 局部扫描子树同样引用）。
 */
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
      const label =
        LORA_TAG_DEFS.find((d) => d.key === item.subCategory)?.label || ''
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
const IMPORT_SIDECAR_SUFFIXES = [
  '.txt',
  '.civitai.info',
  ...SIDECAR_PREVIEW_EXTS,
]

/**
 * 拆分模型文件名（兼容 WebUI 的 `.disabled` 双重后缀）。
 * base 统一委托 scanner.sidecarBaseOf（单一来源），保证导入搬运的
 * sidecar 命名与展示/清理/迁移侧集合一致。
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
  return { base: sidecarBaseOf(name), ext, disabled }
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

/** 导入进度推送节流（ms）：大文件分块复制时避免每 4MB 刷一次 IPC */
const IMPORT_PROGRESS_INTERVAL_MS = 200
/** 分块复制大小：兼顾吞吐与取消/进度响应粒度 */
const IMPORT_COPY_CHUNK_BYTES = 4 * 1024 * 1024

/** 构造与 wrapHandler 约定的 AbortError（统一返回 { canceled: true }） */
function importAbortError() {
  const err = new Error('导入已取消')
  err.name = 'AbortError'
  return err
}

/**
 * 分块复制文件（导入专用）：支持字节进度与中途取消。
 * - 目标以 wx 打开，保持 COPYFILE_EXCL 语义（规划后被外部创建也不覆盖）；
 * - 取消/异常时关闭句柄并删除未完成目标，绝不留下半成品；
 * - 返回前保证源/目标句柄均已关闭，Windows 上可立即 rename/unlink。
 * @param {string} src 源文件
 * @param {string} dst 目标文件
 * @param {{signal?: AbortSignal|null, onProgress?: (bytes: number) => void}} [options]
 */
async function copyFileWithProgress(src, dst, { signal, onProgress } = {}) {
  /** @type {import('node:fs/promises').FileHandle|null} */
  let sourceHandle = null
  /** @type {import('node:fs/promises').FileHandle|null} */
  let targetHandle = null
  // 仅清理「本次由 wx 成功创建」的目标；若 wx 因已存在而失败，
  // 绝不能删除规划后被外部创建的文件（保持 COPYFILE_EXCL 安全语义）
  let createdTarget = false
  try {
    sourceHandle = await fs.open(src, 'r')
    targetHandle = await fs.open(dst, 'wx')
    createdTarget = true
    const buffer = Buffer.alloc(IMPORT_COPY_CHUNK_BYTES)
    while (true) {
      if (signal?.aborted) throw importAbortError()
      const { bytesRead } = await sourceHandle.read(
        buffer,
        0,
        IMPORT_COPY_CHUNK_BYTES,
        null,
      )
      if (bytesRead === 0) break
      let written = 0
      while (written < bytesRead) {
        const { bytesWritten } = await targetHandle.write(
          buffer,
          written,
          bytesRead - written,
        )
        if (bytesWritten <= 0) throw new Error('写入目标文件失败')
        written += bytesWritten
      }
      onProgress?.(bytesRead)
    }
    await targetHandle.close()
    targetHandle = null
    await sourceHandle.close()
    sourceHandle = null
  } catch (err) {
    await targetHandle?.close().catch(() => {})
    await sourceHandle?.close().catch(() => {})
    if (createdTarget) await fs.unlink(dst).catch(() => {})
    throw err
  }
}

/**
 * 复制/移动单个文件；跨卷移动退化为复制后删除源。
 * 复制走分块流（进度/取消），同卷移动仍是瞬时 rename。
 * @param {string} src
 * @param {string} dst
 * @param {'copy'|'move'} mode
 * @param {{size: number, signal?: AbortSignal|null,
 *   onProgress?: (bytes: number) => void}} options
 */
async function transferFile(src, dst, mode, { size, signal, onProgress }) {
  if (mode === 'move') {
    try {
      await fs.rename(src, dst)
      onProgress?.(size)
      return
    } catch (err) {
      if (err.code !== 'EXDEV') throw err
    }
  }
  await copyFileWithProgress(src, dst, { signal, onProgress })
  if (mode === 'move') await fs.unlink(src).catch(() => {})
}

/** 磁盘空间展示（仅用于预检失败文案） */
function formatImportBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${Math.max(0, Math.round(bytes))} B`
}

/**
 * 目标卷可用空间（字节）；statfs 不可用/目标暂不可访问时返回 null，
 * 预检失败不得阻断导入（随后写入仍会以真实 ENOSPC 错误反馈）。
 * @param {string} targetDir
 * @returns {Promise<number|null>}
 */
async function getTargetFreeBytes(targetDir) {
  try {
    const stat = await fs.statfs(targetDir)
    const free = Number(stat.bavail) * Number(stat.bsize)
    return Number.isFinite(free) ? free : null
  } catch {
    return null
  }
}

/**
 * 导入外部模型文件（复制/移动入台，F2）：
 * - 原生文件选择（多选）+ 目标目录选择（必须位于当前模型库内）；
 * - 逐文件复制/移动，自动搬运同名 `.txt` / `.civitai.info` / 预览图 sidecar；
 * - 目标同名冲突自动追加 ` (n)`，不覆盖库内已有文件；
 * - 源文件已在库内时拒绝（避免绕过库内移动的元数据键迁移）；
 * - 成功后渲染层对目标子树执行局部扫描，新模型即时入列。
 * @param {{mode?: string, win?: any, signal?: AbortSignal|null}} [options]
 *   导入方式、来源窗口与取消信号（OPT-02：models:cancelOp 在文件间隙/
 *   分块复制中途中止；已完成条目保留，未完成目标清理）
 * @returns {Promise<object>}
 */
async function importModels({ mode, win, signal } = {}) {
  if (mode !== 'copy' && mode !== 'move') return { error: '无效的导入方式' }
  const root = getCurrentRoot()
  if (!root) return { error: '尚未选择模型库' }
  const picked = await dialog.showOpenDialog(win, {
    title:
      mode === 'move' ? '选择要移动入台的模型文件' : '选择要复制入台的模型文件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: '模型文件',
        // .disabled 是 WebUI 的禁用后缀，需单独加入过滤器才可被选中
        extensions: [
          ...MODEL_EXTENSION_NAMES.map((e) => e.slice(1)),
          'disabled',
        ],
      },
    ],
  })
  if (picked.canceled || picked.filePaths.length === 0)
    return { canceled: true }

  const targetPick = await dialog.showOpenDialog(win, {
    title: '选择导入目标文件夹（须在当前模型库内）',
    defaultPath: root,
    properties: ['openDirectory', 'createDirectory'],
  })
  if (targetPick.canceled || !targetPick.filePaths[0]) return { canceled: true }
  const targetDir = path.resolve(targetPick.filePaths[0])
  if (!isInsideDir(root, targetDir)) {
    return { error: '目标文件夹不在当前模型库内' }
  }
  const targetRelRaw = path.relative(root, targetDir)
  const targetRelDir =
    targetRelRaw === '' ? '' : targetRelRaw.split(path.sep).join('/')
  if (
    targetRelDir === '.modelvault' ||
    targetRelDir.startsWith('.modelvault/')
  ) {
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

  if (signal?.aborted) return { canceled: true }
  const token = tryAcquireMaintenance('import', root)
  if (!token) return { error: maintenanceBusyMessage() }
  const failed = []
  const warnings = []
  let imported = 0
  let renamed = 0
  let canceled = false
  const aborted = () => signal?.aborted === true
  const uniqueSources = []
  const seen = new Set()
  for (const sourceRaw of picked.filePaths) {
    const source = path.resolve(sourceRaw)
    if (seen.has(source)) continue
    seen.add(source)
    uniqueSources.push(source)
  }
  const total = uniqueSources.length
  let totalBytes = 0
  let copyBytes = 0
  try {
    await fs.mkdir(targetDir, { recursive: true })
    // OPT-02 磁盘预检：按「实际需要写入目标卷的字节」汇总（同卷移动为
    // rename 不占额外空间；跨卷 move/copy 计入模型与 sidecar）。
    // statfs 不可用时跳过，真正写入仍由 ENOSPC 反馈。
    const targetVolume = path.parse(targetDir).root.toLowerCase()
    for (const source of uniqueSources) {
      if (aborted()) {
        canceled = true
        break
      }
      const sourceName = path.basename(source)
      if (!isImportableModelFile(sourceName)) continue
      if (isInsideDir(root, source)) continue
      let stat
      try {
        stat = await fs.lstat(source)
      } catch {
        continue
      }
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      totalBytes += stat.size
      const sameVolume = path.parse(source).root.toLowerCase() === targetVolume
      if (mode === 'copy' || !sameVolume) copyBytes += stat.size
      // sidecar 体积按存在项计入（不存在/目录项忽略；真正搬运时再 stat）
      const sourceBase = splitModelFileName(sourceName).base
      for (const suffix of IMPORT_SIDECAR_SUFFIXES) {
        try {
          const sidecarStat = await fs.lstat(
            path.join(path.dirname(source), `${sourceBase}${suffix}`),
          )
          if (!sidecarStat.isFile()) continue
          totalBytes += sidecarStat.size
          if (mode === 'copy' || !sameVolume) copyBytes += sidecarStat.size
        } catch {
          /* sidecar 不存在 */
        }
      }
    }
    if (canceled) {
      logger.info(`模型导入已取消（预检阶段） → ${targetDir}`)
      return {
        root,
        targetDir,
        targetRelDir,
        imported,
        renamed,
        failed,
        warnings,
        canceled: true,
      }
    }
    if (copyBytes > 0) {
      const freeBytes = await getTargetFreeBytes(targetDir)
      if (freeBytes !== null && copyBytes > freeBytes) {
        logger.warn(
          `模型导入磁盘空间不足：需要 ${copyBytes} 字节，可用 ${freeBytes} 字节`,
        )
        return {
          error: `目标磁盘空间不足：需要 ${formatImportBytes(copyBytes)}，当前可用 ${formatImportBytes(freeBytes)}；请清理空间或更换目标目录后重试`,
          neededBytes: copyBytes,
          freeBytes,
        }
      }
    }

    // OPT-02 进度：done/total 为条目级，bytes/totalBytes 为字节级；
    // 200ms 节流，复制分块与条目切换都会推进，取消请求也会随事件回传
    let lastProgressAt = 0
    let processed = 0
    let transferredBytes = 0
    let currentFile = ''
    const reportProgress = (force = false) => {
      const now = Date.now()
      if (!force && now - lastProgressAt < IMPORT_PROGRESS_INTERVAL_MS) return
      lastProgressAt = now
      if (!win || win.isDestroyed?.()) return
      try {
        win.webContents?.send?.('models:importProgress', {
          done: processed,
          total,
          bytes: transferredBytes,
          totalBytes,
          fileName: currentFile,
          canceled: aborted(),
        })
      } catch {
        /* 窗口销毁/重载：进度推送失败不影响导入主流程 */
      }
    }
    const onBytes = (bytes) => {
      transferredBytes += bytes
      reportProgress()
    }
    reportProgress(true)

    for (const source of uniqueSources) {
      if (aborted()) {
        canceled = true
        break
      }
      const sourceName = path.basename(source)
      currentFile = sourceName
      reportProgress(true)
      if (!isImportableModelFile(sourceName)) {
        failed.push({ source, error: '不支持的模型文件类型' })
        processed += 1
        reportProgress()
        continue
      }
      if (isInsideDir(root, source)) {
        failed.push({ source, error: '源文件已在当前模型库内，请使用库内移动' })
        processed += 1
        reportProgress()
        continue
      }
      let sourceStat
      try {
        sourceStat = await fs.lstat(source)
        if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
          failed.push({ source, error: '仅支持导入普通文件' })
          processed += 1
          reportProgress()
          continue
        }
      } catch (err) {
        failed.push({ source, error: `无法读取源文件: ${err.message}` })
        processed += 1
        reportProgress()
        continue
      }

      let plan
      try {
        plan = await planImportTarget(targetDir, sourceName)
      } catch (err) {
        failed.push({ source, error: err.message })
        processed += 1
        reportProgress()
        continue
      }
      const targetModel = path.join(targetDir, plan.fileName)
      try {
        await transferFile(source, targetModel, mode, {
          size: sourceStat.size,
          signal,
          onProgress: onBytes,
        })
      } catch (err) {
        if (err?.name === 'AbortError') {
          canceled = true
          break
        }
        failed.push({ source, error: `导入失败: ${err.message}` })
        processed += 1
        reportProgress()
        continue
      }
      imported += 1
      if (plan.fileName !== sourceName) renamed += 1

      // sidecar 同批搬运（失败只告警，不撤销已成功导入的模型）
      const sourceBase = splitModelFileName(sourceName).base
      for (const suffix of IMPORT_SIDECAR_SUFFIXES) {
        if (aborted()) {
          canceled = true
          break
        }
        const sidecarSource = path.join(
          path.dirname(source),
          `${sourceBase}${suffix}`,
        )
        let sidecarStat
        try {
          sidecarStat = await fs.lstat(sidecarSource)
          if (!sidecarStat.isFile()) continue
        } catch {
          continue
        }
        const sidecarTarget = path.join(targetDir, `${plan.base}${suffix}`)
        try {
          await transferFile(sidecarSource, sidecarTarget, mode, {
            size: sidecarStat.size,
            signal,
            onProgress: onBytes,
          })
        } catch (err) {
          if (err?.name === 'AbortError') {
            canceled = true
            break
          }
          warnings.push(`${path.basename(sidecarSource)}: ${err.message}`)
        }
      }
      processed += 1
      reportProgress()
      if (canceled) break
    }
    currentFile = ''
    reportProgress(true)
    logger.info(
      `模型导入${canceled ? '已取消' : '完成'}（${mode}）：成功 ${imported}，重命名 ${renamed}，失败 ${failed.length} → ${targetDir}`,
    )
    return {
      root,
      targetDir,
      targetRelDir,
      imported,
      renamed,
      failed,
      warnings,
      ...(canceled ? { canceled: true } : {}),
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
 * @returns {{path?: string, error?: string}}
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
  // 仅大小写变化（my_lora → My_LoRA）属于真实改名：必须返回新路径，否则处理器
  // 会把 plan.path === id 当作「名称未变」直接返回成功而不执行 fs.rename。
  // 大小写不敏感的冲突判定由处理器按 target.toLowerCase() 复核（仅大小写变化
  // 时目标就是源文件本身，须跳过那一步）。
  if (newPath === id) return { path: id }
  return { path: newPath }
}

/** 注册文件操作链路的 IPC 处理器 */
export function registerFilesHandlers() {
  // 加/去 .disabled 后缀（F10）：幂等；目标名已存在时拒绝
  wrapHandler(
    'models:toggleDisabled',
    async (event, { id, disabled } = {}) => {
      const invalid = await checkModelIdInRootReal(id)
      if (invalid) return { error: invalid }
      if (typeof disabled !== 'boolean') return { error: '无效的禁用状态' }
      const isCurrently = id.toLowerCase().endsWith('.disabled')
      if (isCurrently === disabled) return { path: id }
      const newPath = disabled
        ? `${id}.disabled`
        : id.replace(/\.disabled$/i, '')
      // 维护锁（OPT-14）：改名与扫描/备份恢复/跨库传输互斥——扫描 relink
      // 不得绑定到改名中途的路径。file-op 彼此兼容（批量启用为串行调用）
      const token = tryAcquireMaintenance('file-op', getCurrentRoot())
      if (!token) return { error: maintenanceBusyMessage() }
      try {
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
        logger.info(
          `模型已${disabled ? '禁用' : '启用'}: ${path.basename(newPath)}`,
        )
        return { path: newPath }
      } finally {
        releaseMaintenance(token)
      }
    },
    { errorPrefix: '禁用/启用失败' },
  )

  // 模型文件重命名（N1）：仅改当前目录内的文件名，扩展名保持不变；
  // 同名 sidecar 一并改名（目标已存在则跳过不覆盖），元数据键即时迁移
  wrapHandler(
    'models:renameModel',
    async (event, { id, name } = {}) => {
      const invalid = await checkModelIdInRootReal(id)
      if (invalid) return { error: invalid }
      const plan = planRenameTarget(id, name)
      if (plan.error) return { error: plan.error }
      if (plan.path === id) {
        return { path: id, renamedSidecars: 0, sidecarWarnings: [] }
      }
      // 维护锁（OPT-14）：改名 + sidecar 迁移 + 元数据键迁移与扫描 relink、
      // 备份恢复互斥——恢复中途改路径会让恢复结果与元数据指向错位
      const token = tryAcquireMaintenance('file-op', getCurrentRoot())
      if (!token) return { error: maintenanceBusyMessage() }
      try {
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
        logger.info(
          `模型已重命名: ${path.basename(id)} -> ${path.basename(plan.path)}`,
        )
        return { path: plan.path, renamedSidecars, sidecarWarnings }
      } finally {
        releaseMaintenance(token)
      }
    },
    { errorPrefix: '重命名失败' },
  )

  // 库内移动/归档（F11）：目录选择对话框 + 同名 sidecar 一并移动
  wrapHandler(
    'models:moveModelTo',
    async (event, { id } = {}) => {
      const invalid = await checkModelIdInRootReal(id)
      if (invalid) return { error: invalid }
      const win = BrowserWindow.fromWebContents(event.sender)
      const pick = await dialog.showOpenDialog(win, {
        title: '选择目标文件夹（须在当前模型库内）',
        properties: ['openDirectory'],
      })
      if (pick.canceled || !pick.filePaths[0]) return { canceled: true }
      const targetDir = pick.filePaths[0]
      // 目标目录必须在当前库内（以构造文件路径换算相对键判定）
      const newPath = path.join(targetDir, path.basename(id))
      if (!toRelKey(newPath)) {
        return { error: '目标文件夹不在当前模型库内' }
      }
      // O6：真实路径校验——拦截目标目录本身是指向库外的 junction/符号链接
      const rootReal = await getRealRootPath()
      if (!rootReal || !(await isPathRealWithin(targetDir, rootReal))) {
        return { error: '目标文件夹真实路径不在当前模型库内' }
      }
      if (newPath === id)
        return { path: id, targetRelDir: toRelKey(targetDir) ?? '' }
      // 维护锁（OPT-14）：在对话框与校验之后、移动之前取锁——持锁等待用户
      // 选择目录会长时间冻结扫描/恢复等大操作。file-op 彼此兼容
      const token = tryAcquireMaintenance('file-op', getCurrentRoot())
      if (!token) return { error: maintenanceBusyMessage() }
      try {
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
            return {
              error: '不支持跨磁盘移动（目标文件夹须与模型库在同一磁盘）',
            }
          }
          logger.warn(`模型移动失败: ${id} ${err.message}`)
          return { error: `移动失败: ${err.message}` }
        }
        // 同名 sidecar（预览图/说明文本）一并移动：整理场景下说明与模型不应分家
        for (const f of sidecarFilesFor(id)) {
          await fs
            .rename(f, path.join(targetDir, path.basename(f)))
            .catch(() => {})
        }
        renameModelMeta(id, newPath)
        logger.info(`模型已移动: ${id} -> ${newPath}`)
        // targetRelDir：渲染层据此对目标子树做局部扫描（OPT-03）；
        // 目标为库根时 toRelKey 返回 null，映射为 ''（根直属文件子树）
        return { path: newPath, targetRelDir: toRelKey(targetDir) ?? '' }
      } finally {
        releaseMaintenance(token)
      }
    },
    { errorPrefix: '移动失败' },
  )

  // 跨库移动/复制（F-3）：目标必须是已保存的其他模型库；文件/sidecar/封面/
  // 元数据保持相对路径整体迁移，安全校验与维护锁在服务层（library-transfer）。
  // OPT-18：ctx.signal 为 opId 取消信号（渲染层经 models:cancelOp 中止）
  wrapHandler(
    'models:transferToLibrary',
    async (event, { ids, targetRoot, mode } = {}, { signal } = {}) => {
      if (!Array.isArray(ids) || ids.length === 0) {
        return { error: '没有可传输的模型' }
      }
      if (ids.length > MAX_TRANSFER_IDS) {
        return { error: `单次最多传输 ${MAX_TRANSFER_IDS} 个模型` }
      }
      return transferModelsToLibrary({ ids, targetRoot, mode, signal })
    },
    { errorPrefix: '跨库传输失败' },
  )

  // 一键移动文件（自动标签整理）：根目录创建 LoRA 文件夹及其下 7 个标签
  // 子文件夹（已存在不动），已标注 LoRA 移入 LoRA/<标签>/，未标注 LoRA 移入
  // LoRA/ 根目录；元数据键即时迁移，watcher 触发局部重扫。
  // 单个失败（同名冲突等）不中断整批，结果按模型反馈。
  wrapHandler(
    'models:organizeByTags',
    async (event, { moves } = {}, { signal } = {}) => {
      if (!Array.isArray(moves) || moves.length === 0) {
        return { error: '没有需要移动的模型' }
      }
      if (moves.length > MAX_ORGANIZE_MOVES) {
        return { error: `单次最多移动 ${MAX_ORGANIZE_MOVES} 个模型` }
      }
      const root = getCurrentRoot()
      if (!root) return { error: '未选择模型库根目录' }
      const rootReal = await getRealRootPath()
      if (!rootReal) return { error: '模型库根目录不可访问' }
      // OPT-18：ctx.signal 为 opId 取消信号（渲染层经 models:cancelOp 中止）；
      // 取消在条目间隙检查，已完成的移动保留（元数据键已即时迁移，状态一致）
      const aborted = () => signal?.aborted === true
      // 维护锁（OPT-14）：批量移动与扫描 relink/备份恢复互斥；归属校验一并
      // 纳入锁内，保证「校验-移动」与并发大操作的原子边界。file-op 彼此兼容
      const token = tryAcquireMaintenance('file-op', root)
      if (!token) return { error: maintenanceBusyMessage() }
      try {
        // 逐项校验归属（O6：realpath 后仍须在库内）：非法项跳过而非整体失败
        const valid = []
        const skipped = []
        for (const item of moves) {
          if (aborted()) break
          if (!item || typeof item.id !== 'string') continue
          if (await checkModelIdInRootReal(item.id, { realRoot: rootReal })) {
            skipped.push({ id: item.id, reason: 'out-of-root' })
            continue
          }
          valid.push(item)
        }
        const { planned, skipped: planSkipped } = planOrganizeMoves(valid, root)
        skipped.push(...planSkipped)
        if (planned.length === 0 || aborted()) {
          return {
            moved: 0,
            failed: [],
            skipped,
            ...(aborted() ? { canceled: true } : {}),
          }
        }
        // 创建 LoRA 一级目录与 7 个标签子文件夹（recursive：已存在时静默保持原样）。
        // O6：已存在的 LoRA 目录若是指向库外的 junction，拒绝整理（避免 mkdir 跟随到库外）
        const loraDir = path.join(root, LORA_DIR)
        let loraExists = true
        try {
          await fs.access(loraDir)
        } catch {
          loraExists = false
        }
        if (loraExists && !(await isPathRealWithin(loraDir, rootReal))) {
          return { error: 'LoRA 文件夹真实路径不在当前模型库内' }
        }
        try {
          await fs.mkdir(loraDir, { recursive: true })
          for (const folder of TAG_FOLDER_NAMES) {
            await fs.mkdir(path.join(loraDir, folder), { recursive: true })
          }
        } catch (err) {
          return { error: `创建分类文件夹失败: ${err.message}` }
        }
        let moved = 0
        let canceled = false
        const failed = []
        // OPT-22/P4：目标标签子文件夹的真实路径校验按目录缓存——候选目标
        // 目录只有 8 个（LoRA 根 + 7 标签），万级批次此前逐项重复 realpath；
        // 目录级 realpath 一次解析后按小写路径缓存判定结果
        const targetDirOkCache = new Map()
        for (const { id, newPath } of planned) {
          if (aborted()) {
            canceled = true
            break
          }
          // 目标标签子文件夹同样做真实路径校验（已存在指库外的 junction 时拒绝）
          const targetDir = path.dirname(newPath)
          const dirKey = targetDir.toLowerCase()
          let dirOk = targetDirOkCache.get(dirKey)
          if (dirOk === undefined) {
            dirOk = await isPathRealWithin(targetDir, rootReal)
            targetDirOkCache.set(dirKey, dirOk)
          }
          if (!dirOk) {
            failed.push({ id, error: '目标文件夹真实路径不在当前模型库内' })
            continue
          }
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
            await fs
              .rename(f, path.join(path.dirname(newPath), path.basename(f)))
              .catch(() => {})
          }
          renameModelMeta(id, newPath)
          moved += 1
        }
        logger.info(
          `一键移动文件${canceled ? '已取消' : '完成'}: 移动 ${moved}，失败 ${failed.length}，跳过 ${skipped.length}`,
        )
        return {
          moved,
          failed,
          skipped,
          ...(canceled ? { canceled: true } : {}),
        }
      } finally {
        releaseMaintenance(token)
      }
    },
    { errorPrefix: '一键移动文件失败' },
  )

  // F2：外部模型导入（复制/移动入台）
  wrapHandler(
    'models:importModels',
    (event, { mode } = {}, { signal } = {}) =>
      importModels({
        mode,
        win: BrowserWindow.fromWebContents(event.sender),
        signal,
      }),
    { errorPrefix: '模型导入失败' },
  )
}
