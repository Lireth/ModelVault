import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
import { readLibraryIndex } from './library-index'
import { getCurrentRoot, getDataFilePath } from './store-paths'
import { getSettings } from './store-settings'

/**
 * 跨库存储总览（FN-01）：
 *
 * 重复检测（FEAT-1）只在当前激活库内计算，多库用户无法发现同一模型散落在
 * 不同库中的副本。本模块以**只读**方式汇总各库的本地索引（`.modelvault/
 * index.json`，含 size/mtime/hash）或元数据（`store.json`，仅 hash），
 * 按 SHA256 聚合并输出：
 * - 每个库的模型数/已知容量/哈希覆盖；
 * - 跨库重复组（成员来自 ≥2 个库）与可释放空间；
 * - 库内重复组数量（指引到现有「重复」筛选清理）。
 *
 * 安全与一致性约束：
 * - 不获取维护锁、不切换当前根目录、不修改任何文件——可在任意时刻发起；
 * - 索引只是展示缓存，报告明确标注来源与更新时间；执行清理仍须回到对应库，
 *   由现有扫描/删除链路重新校验文件存在性；
 * - 索引缺失时回退 store.json，此时容量未知（size=0），仅统计副本数量。
 */

/** 索引/元数据文件读取上限（防损坏文件一次性占满内存） */
const MAX_SOURCE_BYTES = 64 * 1024 * 1024

/** 索引超过该时长视为较旧，报告中给出提示（毫秒） */
const STALE_INDEX_MS = 7 * 24 * 60 * 60 * 1000

/** 路径归一化键（Windows 大小写不敏感） */
function rootKeyOf(root) {
  return path.resolve(root).toLowerCase()
}

/** 库显示名：目录名；盘符根（D:\）回退完整路径 */
function libraryName(root) {
  const base = path.basename(root)
  return base || root
}

/**
 * 归一化并去重库根目录（保持原顺序，Windows 大小写不敏感）。
 * @param {string[]} roots
 * @returns {string[]}
 */
export function normalizeLibraryRoots(roots) {
  const seen = new Set()
  const result = []
  for (const root of roots || []) {
    if (typeof root !== 'string' || !root.trim()) continue
    const key = rootKeyOf(root)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(root)
  }
  return result
}

/** 绝对模型路径 → 库内相对路径（POSIX；不在库内时回退文件名） */
function relativePathOf(root, absPath, fallbackName) {
  const rel = path.relative(root, absPath)
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join('/')
  }
  return fallbackName || path.basename(absPath)
}

/** 索引记录 → 聚合条目（只保留统计所需字段，控制内存） */
function indexEntry(root, record) {
  const name = typeof record.name === 'string' ? record.name : ''
  return {
    absPath: record.id,
    relPath: relativePathOf(root, record.id, name),
    name,
    size: Number.isFinite(record.size) ? record.size : 0,
    hash: typeof record.hash === 'string' ? record.hash : ''
  }
}

/** 元数据键 → 聚合条目（store.json 不含 size，容量按未知处理） */
function storeEntry(root, relKey, meta) {
  const normalizedKey = String(relKey).split('\\').join('/')
  return {
    absPath: path.join(root, normalizedKey),
    relPath: normalizedKey,
    name: path.basename(normalizedKey),
    size: 0,
    hash: typeof meta?.hash === 'string' ? meta.hash : ''
  }
}

/**
 * 读取某库的 store.json（索引缺失时的回退）。
 * @returns {Promise<{entries: object[], savedAt: number} | null>} 不可读返回 null
 */
async function readStoreEntries(root) {
  const file = getDataFilePath(root)
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return null
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8'))
    const models = parsed?.models
    if (!models || typeof models !== 'object' || Array.isArray(models)) return null
    const rootLower = rootKeyOf(root)
    // 盘符根（D:\）已自带分隔符，拼接前缀时避免出现双分隔符导致全部误判为越界
    const rootPrefix = rootLower.endsWith(path.sep) ? rootLower : `${rootLower}${path.sep}`
    const entries = []
    for (const [relKey, meta] of Object.entries(models)) {
      if (!relKey || path.isAbsolute(relKey)) continue
      const abs = path.join(root, relKey)
      const absLower = path.resolve(abs).toLowerCase()
      // 防止畸形/恶意键逃逸到库外（仅展示用途，仍按最小信任处理）
      if (absLower !== rootLower && !absLower.startsWith(rootPrefix)) continue
      entries.push(storeEntry(root, relKey, meta))
    }
    return { entries, savedAt: stat.mtimeMs }
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`跨库总览读取元数据失败（${root}）: ${err.message}`)
    return null
  }
}

/**
 * 聚合并输出跨库总览（纯函数，便于单测）。
 * @param {Array<{root: string, name?: string, exists?: boolean, source: string,
 *   savedAt?: number, models: object[]}>} libraries
 * @param {number} [now] 当前时间（测试注入）
 * @returns {object}
 */
export function buildLibraryOverview(libraries, now = Date.now()) {
  const libs = (libraries || []).map((lib) => ({
    root: lib.root,
    key: rootKeyOf(lib.root),
    name: lib.name || libraryName(lib.root),
    exists: lib.exists !== false,
    source: lib.source || 'none',
    savedAt: Number.isFinite(lib.savedAt) ? lib.savedAt : 0,
    models: Array.isArray(lib.models) ? lib.models.filter(Boolean) : []
  }))

  // 全库按 hash 聚合；同一库内同一绝对路径只计一次（索引异常时防御）
  const byHash = new Map()
  for (const lib of libs) {
    const seen = new Set()
    for (const model of lib.models) {
      if (!model.hash) continue
      if (seen.has(model.absPath)) continue
      seen.add(model.absPath)
      let group = byHash.get(model.hash)
      if (!group) {
        group = { hash: model.hash, members: [] }
        byHash.set(model.hash, group)
      }
      group.members.push({
        root: lib.root,
        rootKey: lib.key,
        library: lib.name,
        relPath: model.relPath,
        name: model.name,
        size: model.size
      })
    }
  }

  const groups = []
  for (const group of byHash.values()) {
    if (group.members.length < 2) continue
    const roots = new Set(group.members.map((m) => m.rootKey))
    const size = group.members.find((m) => m.size > 0)?.size || 0
    groups.push({
      hash: group.hash,
      sizeBytes: size,
      sizeKnown: size > 0,
      copies: group.members.length,
      libraries: roots.size,
      redundantCopies: group.members.length - 1,
      wastedBytes: size * (group.members.length - 1),
      members: group.members
    })
  }

  // 库内重复组（现有「重复」筛选可处理）：按库统计
  const localGroupCount = new Map()
  for (const group of groups) {
    const counts = new Map()
    for (const member of group.members) {
      counts.set(member.rootKey, (counts.get(member.rootKey) || 0) + 1)
    }
    for (const [key, count] of counts) {
      if (count > 1) localGroupCount.set(key, (localGroupCount.get(key) || 0) + 1)
    }
  }

  const perLibrary = libs.map((lib) => {
    const models = lib.models.length
    let totalBytes = 0
    let sizeKnownModels = 0
    let hashedModels = 0
    for (const model of lib.models) {
      if (model.size > 0) {
        totalBytes += model.size
        sizeKnownModels += 1
      }
      if (model.hash) hashedModels += 1
    }
    return {
      root: lib.root,
      name: lib.name,
      exists: lib.exists,
      source: lib.source,
      savedAt: lib.savedAt,
      staleIndex:
        lib.source === 'index' && lib.savedAt > 0 && now - lib.savedAt > STALE_INDEX_MS,
      models,
      sizeKnownModels,
      totalBytes,
      hashedModels,
      localDuplicateGroups: localGroupCount.get(lib.key) || 0
    }
  })
  perLibrary.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))

  const crossGroups = groups
    .filter((group) => group.libraries > 1)
    .sort(
      (a, b) =>
        b.wastedBytes - a.wastedBytes || b.copies - a.copies || a.hash.localeCompare(b.hash)
    )

  const redundantCopies = crossGroups.reduce((sum, group) => sum + group.redundantCopies, 0)
  const wastedBytes = crossGroups.reduce((sum, group) => sum + group.wastedBytes, 0)
  const unknownSizeGroups = crossGroups.filter((group) => !group.sizeKnown).length

  return {
    generatedAt: now,
    totals: {
      libraries: perLibrary.length,
      availableLibraries: perLibrary.filter((lib) => lib.source !== 'none').length,
      models: perLibrary.reduce((sum, lib) => sum + lib.models, 0),
      knownBytes: perLibrary.reduce((sum, lib) => sum + lib.totalBytes, 0),
      hashedModels: perLibrary.reduce((sum, lib) => sum + lib.hashedModels, 0),
      crossGroups: crossGroups.length,
      redundantCopies,
      wastedBytes,
      unknownSizeGroups
    },
    libraries: perLibrary,
    crossLibraryGroups: crossGroups
  }
}

/**
 * 读取全部库并生成总览报告（IPC 入口）。
 * @returns {Promise<{overview: object, warnings: string[]}>}
 */
export async function collectLibraryOverview() {
  const settings = getSettings()
  const roots = normalizeLibraryRoots([
    ...(Array.isArray(settings.modelsFolders) ? settings.modelsFolders : []),
    ...(getCurrentRoot() ? [getCurrentRoot()] : [])
  ])
  const warnings = []
  const libraries = []

  // 顺序读取：单个索引可达数十 MB，并行读取会让内存峰值随库数量线性放大
  for (const root of roots) {
    const exists = await fs.stat(root).then((s) => s.isDirectory()).catch(() => false)
    let models = []
    let source = 'none'
    let savedAt = 0

    if (!exists) {
      warnings.push(`库目录不可访问，已跳过统计：${root}`)
    } else {
      const index = await readLibraryIndex(root)
      if (index) {
        models = index.models.map((record) => indexEntry(root, record))
        source = 'index'
        savedAt = index.savedAt
      } else {
        const store = await readStoreEntries(root)
        if (store) {
          models = store.entries
          source = 'store'
          savedAt = store.savedAt
          warnings.push(`未找到本地索引，已使用元数据统计（容量未知）：${root}`)
        } else {
          warnings.push(`库内缺少本地索引与元数据，无法统计：${root}`)
        }
      }
    }

    libraries.push({ root, name: libraryName(root), exists, source, savedAt, models })
  }

  const overview = buildLibraryOverview(libraries)
  const stale = overview.libraries.filter((lib) => lib.staleIndex)
  if (stale.length > 0) {
    warnings.push(
      `以下库的本地索引超过 7 天未更新，结果可能滞后：${stale.map((lib) => lib.name).join('、')}`
    )
  }
  if (overview.totals.unknownSizeGroups > 0) {
    warnings.push('部分跨库重复组的容量未知（元数据来源不含文件大小），仅统计副本数量')
  }
  if (overview.totals.crossGroups === 0 && roots.length > 0) {
    warnings.push('未发现跨库重复模型；库内重复请使用当前库的「重复」筛选')
  }

  return { overview, warnings }
}
