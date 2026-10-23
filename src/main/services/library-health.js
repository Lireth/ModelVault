import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
import { runWithConcurrency } from '../utils'
import { runMaintenance } from './maintenance-lock'
import {
  COVERS_DIR,
  DATA_DIR,
  getCoversDir,
  getCurrentRoot,
  getDataDir,
  getDataFilePath,
  resolveCover,
  toRelKey
} from './store-paths'
import {
  flushStoreSave,
  getMetaMapByAbsPath,
  getModelMeta,
  getReferencedCovers,
  removeModelMeta,
  setModelMeta,
  wasDataReset
} from './store-meta'

/**
 * 模型库体检与修复（V-07）：
 * 面向「用户手动删文件 / 外部工具改名 / 备份只恢复一半」后的不一致状态，
 * 复用元数据、封面与路径模块生成只读报告，并提供分级、可回退的修复：
 * - 元数据指向的模型文件已缺失 → 移除幽灵标注；
 * - 封面引用失效（文件缺失/路径非法）→ 清掉死引用并回退默认封面；
 * - 封面目录中无人引用的孤儿文件 → 移入 .modelvault/trash/（不直接删除）；
 * - 重复哈希 → 仅报告，不自动处理（避免误删用户文件）。
 * 修复前把 store.json 复制到 .modelvault/backups/，最多保留 10 份。
 * 所有操作在全局维护锁内执行，与扫描/切库/备份恢复互斥。
 */

/** 体检/修复时的文件 stat 并发上限（访问本地磁盘，避免一次性打开过多句柄） */
const HEALTH_IO_CONCURRENCY = 24
/** 保留的历史元数据备份份数 */
const MAX_HEALTH_BACKUPS = 10

/** stat 并返回结果；区分「确实不存在」与「无法访问」（后者绝不能触发自动清理） */
async function statOutcome(target) {
  try {
    return { stat: await fs.stat(target), code: '' }
  } catch (err) {
    return { stat: null, code: err?.code || 'UNKNOWN' }
  }
}

/** 不存在类错误：可安全判定为文件缺失；权限/占用等错误不在此列 */
function isMissingCode(code) {
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * 封面引用是否落在受管的 .modelvault/covers 目录内。
 * 旧数据或手工编辑可能留下越界/绝对路径，体检应标记为无效而不是访问它。
 * @param {string} coverRel 元数据中的封面相对路径
 * @returns {boolean}
 */
function isManagedCoverRel(coverRel) {
  const abs = resolveCover(coverRel)
  const rel = abs ? toRelKey(abs) : null
  return Boolean(rel && rel.startsWith(`${DATA_DIR}/${COVERS_DIR}/`))
}

/** 元数据条目 → 稳定排序的相对路径键 */
function relOf(abs) {
  return toRelKey(abs) || path.basename(abs)
}

/** 重复哈希分组（仅统计文件仍存在的模型，避免幽灵记录制造假重复） */
function groupDuplicates(existingHashes) {
  const byHash = new Map()
  for (const { rel, hash } of existingHashes) {
    if (!hash) continue
    if (!byHash.has(hash)) byHash.set(hash, [])
    byHash.get(hash).push(rel)
  }
  return [...byHash.entries()]
    .filter(([, models]) => models.length > 1)
    .map(([hash, models]) => ({ hash, models: models.sort() }))
    .sort((a, b) => a.models[0].localeCompare(b.models[0]))
}

/**
 * 收集当前库的体检报告（只读）。
 * @param {string} root 当前模型根目录
 * @returns {Promise<object>} 报告
 */
async function collectHealth(root) {
  const entries = Object.entries(getMetaMapByAbsPath())
  const missingFiles = []
  const brokenCovers = []
  const inaccessibleFiles = []
  const inaccessibleCovers = []
  const existingHashes = []
  let totalCoverRefs = 0

  await runWithConcurrency(
    entries,
    async ([abs, meta]) => {
      const rel = relOf(abs)
      const { stat, code } = await statOutcome(abs)
      if (!stat || !stat.isFile()) {
        if (!stat && !isMissingCode(code)) {
          // 权限/占用/磁盘离线：无法确认文件是否真的消失，绝不进入自动修复
          inaccessibleFiles.push({ rel, code })
        } else {
          missingFiles.push({ rel })
        }
        return
      }
      existingHashes.push({
        rel,
        // 文件 mtime 与缓存不一致时哈希可能已过期，不参与重复判定
        hash:
          meta.hash && (!meta.hashMtime || Math.abs(stat.mtimeMs - meta.hashMtime) < 2000)
            ? meta.hash
            : ''
      })

      const refs = [...new Set([...(meta.covers || []), meta.cover].filter(Boolean))]
      for (const coverRel of refs) {
        totalCoverRefs += 1
        if (!isManagedCoverRel(coverRel)) {
          brokenCovers.push({ model: rel, cover: coverRel, reason: 'invalid-path' })
          continue
        }
        const absCover = resolveCover(coverRel)
        const outcome = await statOutcome(absCover)
        if (outcome.stat) continue
        if (isMissingCode(outcome.code)) {
          brokenCovers.push({ model: rel, cover: coverRel, reason: 'missing-file' })
        } else {
          inaccessibleCovers.push({ model: rel, cover: coverRel, code: outcome.code })
        }
      }
    },
    HEALTH_IO_CONCURRENCY
  )

  missingFiles.sort((a, b) => a.rel.localeCompare(b.rel))
  inaccessibleFiles.sort((a, b) => a.rel.localeCompare(b.rel))
  brokenCovers.sort(
    (a, b) => a.model.localeCompare(b.model) || a.cover.localeCompare(b.cover)
  )
  inaccessibleCovers.sort(
    (a, b) => a.model.localeCompare(b.model) || a.cover.localeCompare(b.cover)
  )

  // 孤儿封面：文件存在但没有任何元数据引用
  const coversDir = getCoversDir()
  let coverEntries = []
  try {
    coverEntries = (await fs.readdir(coversDir, { withFileTypes: true })).filter((e) =>
      e.isFile()
    )
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  const referenced = getReferencedCovers()
  const orphanCovers = []
  for (const entry of coverEntries) {
    const rel = `${DATA_DIR}/${COVERS_DIR}/${entry.name}`
    if (referenced.has(rel)) continue
    const { stat } = await statOutcome(path.join(coversDir, entry.name))
    orphanCovers.push({ name: entry.name, sizeBytes: stat?.size || 0 })
  }
  orphanCovers.sort((a, b) => a.name.localeCompare(b.name))

  const duplicateHashes = groupDuplicates(existingHashes)
  const dataReset = wasDataReset()

  return {
    root,
    checkedAt: Date.now(),
    totalModels: entries.length,
    totalCoverRefs,
    missingFiles,
    brokenCovers,
    inaccessibleFiles,
    inaccessibleCovers,
    orphanCovers,
    duplicateHashes,
    dataReset,
    summary: {
      missingFiles: missingFiles.length,
      brokenCovers: brokenCovers.length,
      orphanCovers: orphanCovers.length,
      duplicateHashes: duplicateHashes.length,
      inaccessible: inaccessibleFiles.length + inaccessibleCovers.length,
      // 元数据曾被损坏重置时，孤儿封面清理跳过（沿用既有安全策略）
      repairable:
        missingFiles.length + brokenCovers.length + (dataReset ? 0 : orphanCovers.length)
    }
  }
}

/** 备份 store.json 到 .modelvault/backups/，并清理超过上限的旧备份 */
async function backupStoreFile(root) {
  const source = getDataFilePath(root)
  if (!(await statOutcome(source)).stat) return ''
  const dir = path.join(getDataDir(root), 'backups')
  await fs.mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(dir, `store-health-${stamp}.json`)
  await fs.copyFile(source, dest)
  const backups = (await fs.readdir(dir))
    .filter((name) => name.startsWith('store-health-'))
    .sort()
  for (const old of backups.slice(0, Math.max(0, backups.length - MAX_HEALTH_BACKUPS))) {
    await fs.rm(path.join(dir, old), { force: true }).catch(() => {})
  }
  return dest
}

/** 把孤儿封面移入 .modelvault/trash/，保留用户可恢复性 */
async function moveOrphansToTrash(root, names) {
  if (names.length === 0) return 0
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const trashDir = path.join(getDataDir(root), 'trash', `health-${stamp}`)
  await fs.mkdir(trashDir, { recursive: true })
  let moved = 0
  for (const name of names) {
    try {
      await fs.rename(path.join(getCoversDir(), name), path.join(trashDir, name))
      moved += 1
    } catch (err) {
      logger.warn(`孤儿封面移入回收目录失败（${name}）: ${err.message}`)
    }
  }
  return moved
}

/** 清理失效封面引用，返回修正的模型数与移除的引用数 */
async function repairBrokenCovers(root, brokenCovers) {
  const byModel = new Map()
  for (const item of brokenCovers) {
    if (!byModel.has(item.model)) byModel.set(item.model, [])
    byModel.get(item.model).push(item.cover)
  }
  let fixedModels = 0
  let removedRefs = 0
  for (const [rel, broken] of byModel) {
    const abs = path.join(root, rel)
    const meta = getModelMeta(abs)
    if (!meta) continue
    const brokenSet = new Set(broken)
    const keep = []
    for (const coverRel of meta.covers || []) {
      if (brokenSet.has(coverRel)) {
        removedRefs += 1
        continue
      }
      if (!keep.includes(coverRel)) keep.push(coverRel)
    }
    const cover =
      meta.cover && !brokenSet.has(meta.cover) && keep.includes(meta.cover)
        ? meta.cover
        : keep[0] || ''
    if (cover === meta.cover && keep.length === (meta.covers || []).length) continue
    setModelMeta(abs, { ...meta, covers: keep, cover })
    fixedModels += 1
  }
  return { fixedModels, removedRefs }
}

/**
 * 体检当前模型库（IPC 入口）。
 * @returns {Promise<{report: object} | {error: string}>}
 */
export async function checkLibraryHealth() {
  const root = getCurrentRoot()
  if (!root) return { error: '尚未设置模型文件夹' }
  try {
    return await runMaintenance('health', root, async () => ({
      report: await collectHealth(root)
    }))
  } catch (err) {
    if (err?.code === 'EBUSY') return { error: err.message }
    throw err
  }
}

/**
 * 一键修复当前模型库（IPC 入口）：
 * 只处理可确定安全修复的问题；重复哈希仅保留在报告中。
 * @returns {Promise<object>}
 */
export async function repairLibraryHealth() {
  const root = getCurrentRoot()
  if (!root) return { error: '尚未设置模型文件夹' }
  try {
    return await runMaintenance('repair', root, async () => {
      // 先静止写盘链，确保备份与后续内存修改基于同一份磁盘状态
      await flushStoreSave()
      const report = await collectHealth(root)
      if (report.summary.repairable === 0) {
        return {
          report,
          repaired: {
            removedMetadata: 0,
            fixedCoverModels: 0,
            removedCoverRefs: 0,
            movedOrphanCovers: 0
          },
          backupPath: '',
          dataResetSkipped: report.dataReset
        }
      }

      const backupPath = await backupStoreFile(root)

      let removedMetadata = 0
      for (const item of report.missingFiles) {
        if (removeModelMeta(path.join(root, item.rel))) removedMetadata += 1
      }

      const coverResult = await repairBrokenCovers(root, report.brokenCovers)

      let movedOrphanCovers = 0
      const dataResetSkipped = report.dataReset
      if (!dataResetSkipped) {
        // 元数据清理后重新计算引用集合，再移动孤儿封面
        const referenced = getReferencedCovers()
        const coversDir = getCoversDir()
        let entries = []
        try {
          entries = (await fs.readdir(coversDir)).filter((name) =>
            !referenced.has(`${DATA_DIR}/${COVERS_DIR}/${name}`)
          )
        } catch (err) {
          if (err.code !== 'ENOENT') throw err
        }
        movedOrphanCovers = await moveOrphansToTrash(root, entries)
      } else {
        logger.warn('元数据曾损坏重置，本次跳过孤儿封面清理')
      }

      await flushStoreSave()
      const repaired = {
        removedMetadata,
        fixedCoverModels: coverResult.fixedModels,
        removedCoverRefs: coverResult.removedRefs,
        movedOrphanCovers
      }
      logger.info(
        `模型库体检修复完成: 移除元数据 ${removedMetadata} / 修正封面 ${coverResult.fixedModels} / 移动孤儿封面 ${movedOrphanCovers}`
      )
      return { report, repaired, backupPath, dataResetSkipped }
    })
  } catch (err) {
    if (err?.code === 'EBUSY') return { error: err.message }
    throw err
  }
}
