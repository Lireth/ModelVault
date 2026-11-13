import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import logger from '../../logger'
import { relativeWithin } from '../../utils'
import { getCurrentRoot } from '../../services/store'
import {
  MODEL_EXTENSION_NAMES,
  MODEL_EXTENSION_SET,
} from '../../../shared/model-extensions'
import { SIDECAR_PREVIEW_EXTS, sidecarBaseOf } from '../../services/scanner'
import { withMaintenanceLock, wrapHandler } from '../handler'
import { errorCode, errorMessage, errorName } from '../../../shared/error-text'

/**
 * 外部模型导入链路（F2，O-2 自 files.js 按域拆出）：
 * - 原生文件选择（多选）或拖拽来源路径（F-4）+ 目标目录选择
 *   （必须位于当前模型库内）；
 * - 逐文件复制/移动，自动搬运同名 `.txt` / `.civitai.info` / 预览图 sidecar；
 * - 目标同名冲突自动追加 ` (n)`，不覆盖库内已有文件；
 * - 源文件已在库内时拒绝（避免绕过库内移动的元数据键迁移）；
 * - 成功后渲染层对目标子树执行局部扫描，新模型即时入列。
 */

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
      if (errorCode(err) !== 'EXDEV') throw err
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
 * 选择导入来源：显式拖拽路径优先，否则打开原生多选对话框。
 * @param {{mode: 'copy'|'move', win: any, paths?: string[]}} options
 * @returns {Promise<{sourcePaths: string[], canceled?: undefined, error?: undefined} | {canceled: true, sourcePaths?: undefined, error?: undefined} | {error: string, sourcePaths?: undefined, canceled?: undefined}>}
 *   三属性互斥：成功仅 sourcePaths，取消仅 canceled，失败仅 error
 */
async function pickImportSources({ mode, win, paths }) {
  if (Array.isArray(paths)) {
    if (paths.length === 0) return { error: '未选择模型文件' }
    return { sourcePaths: paths }
  }
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
  return { sourcePaths: picked.filePaths }
}

/**
 * 绝对路径校验与去重（F-4 拖拽路径防御）：仅接受非空绝对路径；
 * 无有效项返回 null（调用方转换为统一错误文案）。
 * @param {string[]} sourcePaths 原始来源路径
 * @returns {string[]|null} 去重后的绝对路径列表
 */
function normalizeImportSources(sourcePaths) {
  const uniqueSources = []
  const seen = new Set()
  for (const sourceRaw of sourcePaths) {
    if (typeof sourceRaw !== 'string' || !path.isAbsolute(sourceRaw)) continue
    const source = path.resolve(sourceRaw)
    if (seen.has(source)) continue
    seen.add(source)
    uniqueSources.push(source)
  }
  return uniqueSources.length > 0 ? uniqueSources : null
}

/**
 * 选择导入目标目录并校验归属（库内 + 非关联存储 + realpath 非越界）。
 * @param {{win: any, root: string}} options 窗口与当前库根
 * @returns {Promise<{targetDir: string, targetRelDir: string, canceled?: undefined,
 *   error?: undefined} | {canceled: true, targetDir?: undefined, targetRelDir?: undefined,
 *   error?: undefined} | {error: string, targetDir?: undefined, targetRelDir?: undefined,
 *   canceled?: undefined}>}
 *   互斥三态：成功 targetDir+targetRelDir，取消 canceled，失败 error
 */
async function resolveImportTarget({ win, root }) {
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
    return { error: `目标文件夹不可访问: ${errorMessage(err)}` }
  }
  return { targetDir, targetRelDir }
}

/**
 * 磁盘预检：按「实际需要写入目标卷的字节」汇总（同卷移动为 rename 不占
 * 额外空间；跨卷 move/copy 计入模型与 sidecar）。statfs 不可用时跳过，
 * 真正写入仍由 ENOSPC 反馈。
 * @param {{uniqueSources: string[], mode: 'copy'|'move', root: string,
 *   targetDir: string, aborted: () => boolean}} options 预检参数
 * @returns {Promise<{totalBytes: number, copyBytes: number,
 *   canceled: boolean}>}
 */
async function preflightImportBudget({
  uniqueSources,
  mode,
  root,
  targetDir,
  aborted,
}) {
  let totalBytes = 0
  let copyBytes = 0
  let canceled = false
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
  return { totalBytes, copyBytes, canceled }
}

/**
 * 目标卷容量校验：空间不足返回错误响应，充足返回 null。
 * @param {string} targetDir 目标目录
 * @param {number} copyBytes 需写入字节
 * @returns {Promise<object|null>} 错误响应或 null
 */
async function checkImportCapacity(targetDir, copyBytes) {
  if (copyBytes <= 0) return null
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
  return null
}

/**
 * 搬运单个来源（模型 + 同名 sidecar），返回导入/取消/失败状态。
 * @param {string} source 来源绝对路径
 * @param {{mode: 'copy'|'move', root: string, targetDir: string,
 *   signal?: AbortSignal|null, aborted: () => boolean,
 *   onBytes: (bytes: number) => void}} ctx 搬运上下文
 * @returns {Promise<{imported: boolean, renamed?: boolean, canceled?: boolean,
 *   failedError?: string, warnings?: string[]}>}
 */
async function importOneSource(source, ctx) {
  const sourceName = path.basename(source)
  const failed = (error) => ({ imported: false, failedError: error })
  if (!isImportableModelFile(sourceName)) {
    return failed('不支持的模型文件类型')
  }
  if (isInsideDir(ctx.root, source)) {
    return failed('源文件已在当前模型库内，请使用库内移动')
  }
  let sourceStat
  try {
    sourceStat = await fs.lstat(source)
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      return failed('仅支持导入普通文件')
    }
  } catch (err) {
    return failed(`无法读取源文件: ${errorMessage(err)}`)
  }

  let plan
  try {
    plan = await planImportTarget(ctx.targetDir, sourceName)
  } catch (err) {
    return failed(errorMessage(err))
  }
  const targetModel = path.join(ctx.targetDir, plan.fileName)
  try {
    await transferFile(source, targetModel, ctx.mode, {
      size: sourceStat.size,
      signal: ctx.signal,
      onProgress: ctx.onBytes,
    })
  } catch (err) {
    if (errorName(err) === 'AbortError')
      return { imported: false, canceled: true }
    return failed(`导入失败: ${errorMessage(err)}`)
  }

  const renamed = plan.fileName !== sourceName
  const warnings = []
  // sidecar 同批搬运（失败只告警，不撤销已成功导入的模型）
  const sourceBase = splitModelFileName(sourceName).base
  for (const suffix of IMPORT_SIDECAR_SUFFIXES) {
    if (ctx.aborted()) {
      return { imported: true, renamed, canceled: true, warnings }
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
    const sidecarTarget = path.join(ctx.targetDir, `${plan.base}${suffix}`)
    try {
      await transferFile(sidecarSource, sidecarTarget, ctx.mode, {
        size: sidecarStat.size,
        signal: ctx.signal,
        onProgress: ctx.onBytes,
      })
    } catch (err) {
      if (errorName(err) === 'AbortError') {
        return { imported: true, renamed, canceled: true, warnings }
      }
      warnings.push(`${path.basename(sidecarSource)}: ${errorMessage(err)}`)
    }
  }
  return { imported: true, renamed, warnings }
}

/**
 * 逐项搬运并汇总进度/失败/警告（取消在条目间隙与复制分块中生效）。
 * @param {{uniqueSources: string[], mode: 'copy'|'move', root: string,
 *   targetDir: string, win: any, signal?: AbortSignal|null,
 *   totalBytes: number}} options 搬运参数
 * @returns {Promise<{imported: number, renamed: number, failed: object[],
 *   warnings: string[], canceled: boolean}>}
 */
async function transferImportFiles({
  uniqueSources,
  mode,
  root,
  targetDir,
  win,
  signal,
  totalBytes,
}) {
  const failed = []
  const warnings = []
  let imported = 0
  let renamed = 0
  let canceled = false
  const aborted = () => signal?.aborted === true
  const total = uniqueSources.length

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
    currentFile = path.basename(source)
    reportProgress(true)
    const result = await importOneSource(source, {
      mode,
      root,
      targetDir,
      signal,
      aborted,
      onBytes,
    })
    if (result.warnings?.length) warnings.push(...result.warnings)
    if (result.imported) {
      imported += 1
      if (result.renamed) renamed += 1
    }
    if (result.failedError) {
      failed.push({ source, error: result.failedError })
    }
    if (result.canceled && !result.imported) {
      canceled = true
      break
    }
    processed += 1
    reportProgress()
    if (result.canceled) {
      canceled = true
      break
    }
  }
  currentFile = ''
  reportProgress(true)
  return { imported, renamed, failed, warnings, canceled }
}

/**
 * 导入外部模型文件（复制/移动入台，F2）。
 * @param {{mode?: string, win?: any, signal?: AbortSignal|null,
 *   paths?: string[]}} [options]
 *   导入方式、来源窗口、取消信号（OPT-02：models:cancelOp 在文件间隙/
 *   分块复制中途中止；已完成条目保留，未完成目标清理）与拖拽来源路径
 *   （F-4：提供时跳过来源选择框，路径仍走扩展名/普通文件/库内位置校验）
 * @returns {Promise<object>}
 */
async function importModels({ mode, win, signal, paths } = {}) {
  if (mode !== 'copy' && mode !== 'move') return { error: '无效的导入方式' }
  const root = getCurrentRoot()
  if (!root) return { error: '尚未选择模型库' }

  const picked = await pickImportSources({ mode, win, paths })
  if (picked.canceled) return { canceled: true }
  if (picked.error) return { error: picked.error }
  // 三态互斥契约：canceled/error 均已提前返回，余下必为成功分支
  const uniqueSources = normalizeImportSources(
    /** @type {string[]} */ (picked.sourcePaths),
  )
  if (!uniqueSources) return { error: '未选择有效的模型文件' }

  const target = await resolveImportTarget({ win, root })
  if (target.canceled) return { canceled: true }
  if (target.error) return { error: target.error }
  // 同上：成功分支必有 targetDir + targetRelDir
  const targetDir = /** @type {string} */ (target.targetDir)
  const targetRelDir = /** @type {string} */ (target.targetRelDir)

  if (signal?.aborted) return { canceled: true }
  return withMaintenanceLock('import', root, async () => {
    try {
      await fs.mkdir(targetDir, { recursive: true })
      const aborted = () => signal?.aborted === true
      const budget = await preflightImportBudget({
        uniqueSources,
        mode,
        root,
        targetDir,
        aborted,
      })
      if (budget.canceled) {
        logger.info(`模型导入已取消（预检阶段） → ${targetDir}`)
        return {
          root,
          targetDir,
          targetRelDir,
          imported: 0,
          renamed: 0,
          failed: [],
          warnings: [],
          canceled: true,
        }
      }
      const capacityError = await checkImportCapacity(
        targetDir,
        budget.copyBytes,
      )
      if (capacityError) return capacityError

      const result = await transferImportFiles({
        uniqueSources,
        mode,
        root,
        targetDir,
        win,
        signal,
        totalBytes: budget.totalBytes,
      })
      logger.info(
        `模型导入${result.canceled ? '已取消' : '完成'}（${mode}）：成功 ${result.imported}，重命名 ${result.renamed}，失败 ${result.failed.length} → ${targetDir}`,
      )
      return {
        root,
        targetDir,
        targetRelDir,
        imported: result.imported,
        renamed: result.renamed,
        failed: result.failed,
        warnings: result.warnings,
        ...(result.canceled ? { canceled: true } : {}),
      }
    } catch (err) {
      logger.warn(`模型导入失败: ${errorMessage(err)}`)
      return { error: `模型导入失败: ${errorMessage(err)}` }
    }
  })
}

/** 注册外部模型导入的 IPC 处理器（O-2 自 files.js 按域拆出） */
export function registerImportModelsHandler() {
  wrapHandler(
    'models:importModels',
    (event, { mode, paths } = {}, { signal } = {}) =>
      importModels({
        mode,
        paths,
        win: BrowserWindow.fromWebContents(event.sender),
        signal,
      }),
    { errorPrefix: '模型导入失败' },
  )
}
