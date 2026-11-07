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
import {
  maintenanceBusyMessage,
  releaseMaintenance,
  tryAcquireMaintenance,
} from '../../services/maintenance-lock'
import { wrapHandler } from '../handler'

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
  const explicitPaths = Array.isArray(paths)
  let sourcePaths
  if (explicitPaths) {
    if (paths.length === 0) return { error: '未选择模型文件' }
    sourcePaths = paths
  } else {
    const picked = await dialog.showOpenDialog(win, {
      title:
        mode === 'move'
          ? '选择要移动入台的模型文件'
          : '选择要复制入台的模型文件',
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
    sourcePaths = picked.filePaths
  }

  const uniqueSources = []
  const seen = new Set()
  for (const sourceRaw of sourcePaths) {
    // F-4 拖拽路径防御：仅接受非空绝对路径（渲染层 webUtils 产出必为绝对路径；
    // 结构门禁已限制类型/长度/数量，这里拦住相对路径与空白项）
    if (typeof sourceRaw !== 'string' || !path.isAbsolute(sourceRaw)) continue
    const source = path.resolve(sourceRaw)
    if (seen.has(source)) continue
    seen.add(source)
    uniqueSources.push(source)
  }
  if (uniqueSources.length === 0) {
    return { error: '未选择有效的模型文件' }
  }

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
