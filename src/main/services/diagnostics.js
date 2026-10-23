import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { app, dialog } from 'electron'
import { zip, strToU8 } from 'fflate'
import logger, { getLogDir } from '../logger'
import { runWithConcurrency } from '../utils'
import { getMaintenanceState } from './maintenance-lock'
import {
  getCoversDir,
  getCurrentRoot,
  getDataDir,
  getDataFilePath,
  getIndexFilePath
} from './store-paths'
import { getMetaMapByAbsPath } from './store-meta'
import { getSettings } from './store-settings'

/**
 * 诊断包导出（FN-05）：
 *
 * 支持反馈场景需要同时具备「版本环境 + 设置 + 库状态 + 缓存体积 + 日志」，
 * 此前用户只能手动打开日志目录与复制版本号，信息经常不完整。本模块以
 * 只读方式聚合这些信息，打包为单个 zip（不修改任何用户数据）：
 * - 不改动关联存储、不触发扫描、不获取维护锁——诊断可在任意时刻发起；
 * - 日志只取最近若干天、每个文件截取尾部，控制诊断包体积；
 * - 目录体积统计设有文件数与深度上限，避免异常缓存目录拖慢导出；
 * - zip 先写临时文件再原子改名，失败不留半成品。
 */

/** 诊断包格式与版本（后续字段变更时递增，便于支持侧识别） */
const DIAGNOSTICS_FORMAT = 'modelvault-diagnostics'
const DIAGNOSTICS_VERSION = 1

/** 日志最多包含最近几天的文件 */
const MAX_LOG_FILES = 3
/** 单个日志文件读取上限（尾部截取，保留最新内容） */
const MAX_LOG_TAIL_BYTES = 1024 * 1024
/** 缓存目录体积统计的文件数上限（防止异常目录拖慢导出） */
const MAX_CACHE_FILES = 20000
/** 缓存目录遍历深度上限 */
const MAX_CACHE_DEPTH = 6
/** 文件 stat 并发上限 */
const CACHE_STAT_CONCURRENCY = 16

/** 截取文件尾部（日志追加写入，最新内容在末尾） */
async function readTail(file, maxBytes) {
  const fh = await fs.open(file, 'r')
  try {
    const stat = await fh.stat()
    const size = stat.size
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    await fh.read(buffer, 0, length, size - length)
    return { text: buffer.toString('utf-8'), bytes: size, truncated: size > maxBytes }
  } finally {
    await fh.close()
  }
}

/** 读取最近若干天日志文件（按文件名日期倒序） */
async function collectLogs() {
  let names
  try {
    names = (await fs.readdir(getLogDir())).filter((name) =>
      /^modelvault-\d{4}-\d{2}-\d{2}\.log$/.test(name)
    )
  } catch {
    return []
  }
  names.sort().reverse()
  const picked = names.slice(0, MAX_LOG_FILES)
  const logs = []
  for (const name of picked) {
    try {
      const tail = await readTail(path.join(getLogDir(), name), MAX_LOG_TAIL_BYTES)
      logs.push({ name, ...tail })
    } catch {
      /* 单个日志不可读不影响其余诊断信息 */
    }
  }
  return logs
}

/** 递归列出目录内文件（深度/数量有界；ENOENT 返回空） */
async function listFiles(dir, maxFiles, maxDepth) {
  const files = []
  const queue = [{ dir, depth: 0 }]
  while (queue.length > 0 && files.length < maxFiles) {
    const current = queue.shift()
    let entries
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break
      const fullPath = path.join(current.dir, entry.name)
      if (entry.isDirectory()) {
        if (current.depth < maxDepth) queue.push({ dir: fullPath, depth: current.depth + 1 })
      } else if (entry.isFile()) {
        files.push(fullPath)
      }
    }
  }
  return { files, truncated: files.length >= maxFiles }
}

/** 目录体积统计（文件数/字节数；目录不存在时 exists=false） */
async function measureDir(dir) {
  const exists = await fs.stat(dir).then((s) => s.isDirectory()).catch(() => false)
  if (!exists) return { exists: false, files: 0, bytes: 0, truncated: false }
  const listed = await listFiles(dir, MAX_CACHE_FILES, MAX_CACHE_DEPTH)
  let bytes = 0
  await runWithConcurrency(
    listed.files,
    async (file) => {
      const stat = await fs.stat(file).catch(() => null)
      if (stat?.isFile()) bytes += stat.size
    },
    CACHE_STAT_CONCURRENCY
  )
  return { exists: true, files: listed.files.length, bytes, truncated: listed.truncated }
}

/** 单个文件信息（不存在或无权限时 exists=false） */
async function fileInfo(file) {
  try {
    const stat = await fs.stat(file)
    return { exists: true, sizeBytes: stat.size, updatedAt: stat.mtimeMs }
  } catch {
    return { exists: false }
  }
}

/**
 * 元数据概要（纯函数，便于单测）：只统计数量，不携带任何模型路径。
 * @param {Record<string, any>} metaMap 绝对路径 → 元数据
 * @returns {{models: number, withCovers: number, withTags: number,
 *   withParams: number, withNote: number, withHash: number}}
 */
export function summarizeMetadata(metaMap) {
  const summary = {
    models: 0,
    withCovers: 0,
    withTags: 0,
    withParams: 0,
    withNote: 0,
    withHash: 0
  }
  for (const meta of Object.values(metaMap || {})) {
    if (!meta || typeof meta !== 'object') continue
    summary.models += 1
    if (Array.isArray(meta.covers) && meta.covers.length > 0) summary.withCovers += 1
    if (Array.isArray(meta.tags) && meta.tags.length > 0) summary.withTags += 1
    if (meta.params && typeof meta.params === 'object') summary.withParams += 1
    if (typeof meta.note === 'string' && meta.note.trim()) summary.withNote += 1
    if (typeof meta.hash === 'string' && meta.hash) summary.withHash += 1
  }
  return summary
}

/** 归一化并去重库列表（Windows 大小写不敏感） */
export function normalizeLibraryRoots(roots) {
  const seen = new Set()
  const result = []
  for (const root of roots || []) {
    if (typeof root !== 'string' || !root.trim()) continue
    const key = path.resolve(root).toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(root)
  }
  return result
}

/** 库的基础信息（只读 stat，不读取索引内容） */
async function collectLibraryInfo(root) {
  const index = await fileInfo(getIndexFilePath(root))
  const store = await fileInfo(getDataFilePath(root))
  return {
    root,
    exists: await fs.stat(root).then((s) => s.isDirectory()).catch(() => false),
    index,
    store
  }
}

/**
 * 构建诊断报告对象（不含日志正文）。
 * @returns {Promise<object>}
 */
export async function collectDiagnosticsReport() {
  const settings = getSettings()
  const activeRoot = getCurrentRoot()
  const roots = normalizeLibraryRoots([
    ...(Array.isArray(settings.modelsFolders) ? settings.modelsFolders : []),
    ...(activeRoot ? [activeRoot] : [])
  ])
  const libraries = await Promise.all(roots.map((root) => collectLibraryInfo(root)))
  const metaMap = getMetaMapByAbsPath()

  // 缓存目录仅统计当前激活库（诊断目标通常就是当前库）
  const caches = {}
  if (activeRoot) {
    const dataDir = getDataDir(activeRoot)
    caches.covers = await measureDir(getCoversDir())
    caches.thumbs = await measureDir(path.join(dataDir, 'thumbs'))
    caches.civcache = await measureDir(path.join(dataDir, 'civcache'))
    caches.journal = await measureDir(path.join(dataDir, 'journal'))
    caches.storeFile = await fileInfo(getDataFilePath(activeRoot))
    caches.indexFile = await fileInfo(getIndexFilePath(activeRoot))
  }

  return {
    format: DIAGNOSTICS_FORMAT,
    version: DIAGNOSTICS_VERSION,
    createdAt: new Date().toISOString(),
    app: {
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron || '',
      chrome: process.versions.chrome || '',
      node: process.versions.node || '',
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      locale: app.getLocale?.() || 'unknown'
    },
    activeLibrary: activeRoot || '',
    libraries,
    settings,
    metadata: summarizeMetadata(metaMap),
    caches,
    maintenance: getMaintenanceState(),
    privacy: {
      note:
        '诊断包含本机路径、模型数量/体积与最近日志；分享前请确认接受范围。' +
        '不包含模型文件内容与封面图片。'
    }
  }
}

/** 以 Promise 包装 fflate 异步 zip（避免同步压缩阻塞主进程） */
function zipFiles(files) {
  return new Promise((resolve, reject) => {
    zip(files, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data)))
  })
}

/** 诊断包内报告文件名（测试与支持文档共用） */
export const DIAGNOSTICS_JSON_ENTRY = 'diagnostics.json'

/**
 * 导出诊断包：弹出保存对话框，聚合报告与最近日志打包为 zip。
 * @param {import('electron').BrowserWindow | null} win 父窗口
 * @returns {Promise<{ok: true, path: string, sizeBytes: number, logs: number}
 *   | {canceled: true} | {error: string}>}
 */
export async function exportDiagnostics(win) {
  let report
  let logs
  try {
    report = await collectDiagnosticsReport()
    logs = await collectLogs()
  } catch (err) {
    logger.warn(`诊断信息收集失败: ${err.message}`)
    return { error: `诊断信息收集失败: ${err.message}` }
  }

  const date = new Date().toISOString().slice(0, 10)
  const result = await dialog.showSaveDialog(win, {
    title: '导出诊断包',
    defaultPath: `modelvault-diagnostics-${date}.zip`,
    filters: [{ name: '诊断包', extensions: ['zip'] }]
  })
  if (result.canceled || !result.filePath) return { canceled: true }

  const files = {
    [DIAGNOSTICS_JSON_ENTRY]: strToU8(JSON.stringify(report, null, 2))
  }
  for (const log of logs) {
    files[`logs/${log.name}`] = strToU8(log.text)
  }

  const target = result.filePath
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  try {
    const bytes = await zipFiles(files)
    await fs.writeFile(tmp, Buffer.from(bytes))
    await fs.rm(target, { force: true }).catch(() => {})
    await fs.rename(tmp, target)
    const stat = await fs.stat(target)
    logger.info(`诊断包已导出: ${target}（${logs.length} 个日志 / ${stat.size} 字节）`)
    return { ok: true, path: target, sizeBytes: stat.size, logs: logs.length }
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    logger.warn(`诊断包导出失败: ${err.message}`)
    return { error: `诊断包导出失败: ${err.message}` }
  }
}
