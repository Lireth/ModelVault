import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
import { atomicWriteFile } from './atomic-write'
import { runMaintenance } from './maintenance-lock'
import { sidecarFilesFor } from './scanner'
import { getCurrentRoot, isInRoot, toRelKey } from './store-paths'
import {
  isPathRealWithin,
  resolveRealPath,
  sameResolvedPathIgnoreCase,
} from '../utils'
import { isDeltaBatchName } from './store-meta-journal'
import {
  flushStoreSave,
  getModelMeta,
  normalizeStoreData,
  removeModelMeta,
} from './store-meta'
import { getSettings } from './store-settings'

/**
 * 跨库移动/复制模型（F-3）：把当前库的模型（文件 + 同名 sidecar + 封面 +
 * 元数据）传输到另一个已保存的模型库，保持相对路径与元数据关联。
 *
 * 设计约定：
 * - **相对路径镜像**：目标相对路径 = 源相对路径（含子目录），因此元数据键
 *   与封面引用（`.modelvault/covers/*` 库相对路径）天然兼容、零重写；
 *   目标已存在同相对路径文件时该模型计入 skipped（不编号、不覆盖——迁移是
 *   整理操作，保持结构镜像比强行合并更安全）；
 * - **封面随条目走**：条目元数据引用的封面文件复制到目标库 covers/（不覆盖
 *   已有同名）；源库封面文件保留（可能被其他条目引用，孤儿由源库健康检查
 *   治理——与删除模型不删封面的既有语义一致）；
 * - **move = 复制成功后清理源**：源文件/已复制 sidecar 直接删除（目标已有
 *   完整副本），源元数据移除；先 try rename（同卷瞬时完成），跨卷回退
 *   copy+delete；任一模型文件传输失败仅影响自身，其余继续；
 * - **目标库元数据离线写回**：目标库 store.json 读取 → normalizeStoreData
 *   清洗 → 合并成功项条目 → 一次写回。目标库存在未合并 journal（上次以该库
 *   为激活库的会话异常退出残留 delta）时拒绝迁移——delta 重放会覆盖离线
 *   写入，须先打开一次目标库让加载链路合并日志；
 * - **维护锁互斥**：整个传输在 'import' 维护锁内执行，防止传输期间切库到
 *   目标库造成 store.json 并发读写。
 */

/**
 * 目标库 journal 目录中未合并 delta 的检测（残留即拒绝迁移）。
 * fail-closed：仅「目录不存在」（目标库从未产生增量日志）视为无残留；
 * 其余读失败（EACCES/EBUSY——杀毒/索引器占用目录等）无法证明没有未合并
 * delta，按存在残留拒绝迁移——否则 writeTargetStore 覆盖 store.json 会
 * 静默丢弃目标库尚未合并的增量标注，恰是本检测要防的场景。
 */
async function hasPendingJournal(targetRoot) {
  const journalDir = path.join(targetRoot, '.modelvault', 'journal')
  let names
  try {
    names = await fs.readdir(journalDir)
  } catch (err) {
    if (err.code === 'ENOENT') return false
    logger.warn(
      `目标库增量日志目录不可读，按存在未合并日志处理: ${journalDir} ${err.message}`,
    )
    return true
  }
  return names.some(isDeltaBatchName)
}

/** 读取目标库 store.json 并规范化（不存在时为空库） */
async function readTargetStore(targetRoot) {
  const file = path.join(targetRoot, '.modelvault', 'store.json')
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8'))
    return normalizeStoreData(parsed)
  } catch {
    return { version: 1, models: {} }
  }
}

/** 写回目标库 store.json（目录不存在时创建） */
async function writeTargetStore(targetRoot, store) {
  const dataDir = path.join(targetRoot, '.modelvault')
  await fs.mkdir(dataDir, { recursive: true })
  await atomicWriteFile(
    path.join(dataDir, 'store.json'),
    JSON.stringify(store, null, 2),
    {
      createDirs: false,
    },
  )
}

/**
 * 复制单个文件（目标存在时跳过，返回 false）。
 * @returns {Promise<boolean>} 是否实际复制
 */
async function copyIfMissing(src, dest) {
  try {
    await fs.access(dest)
    return false
  } catch {
    /* 不存在，复制 */
  }
  await fs.copyFile(src, dest)
  return true
}

/**
 * 移动单个文件：先 try rename（同卷瞬时），跨卷（EXDEV）或失败回退 copy+rm。
 * @returns {Promise<void>}
 */
async function moveFile(src, dest) {
  try {
    await fs.rename(src, dest)
    return
  } catch (err) {
    if (err?.code !== 'EXDEV') throw err
  }
  await fs.copyFile(src, dest)
  await fs.rm(src, { force: true })
}

/**
 * 跨库传输模型（IPC 入口）。
 * @param {{ids: string[], targetRoot: string, mode: 'copy'|'move'}} payload
 *   ids 为当前库内模型绝对路径；targetRoot 必须是已保存的其他模型库；
 *   mode='copy' 复制（源不动）/ 'move' 移动（成功后清理源文件与源元数据）
 * @returns {Promise<{transferred: number, mode: string, targetRoot: string,
 *   failed: Array<{id: string, error: string}>, skipped: Array<{id: string, reason: string}>}
 *   | {error: string}>}
 */
export async function transferModelsToLibrary({ ids, targetRoot, mode }) {
  const currentRoot = getCurrentRoot()
  if (!currentRoot) return { error: '尚未设置模型文件夹' }
  if (!Array.isArray(ids) || ids.length === 0)
    return { error: '没有可传输的模型' }
  if (typeof targetRoot !== 'string' || !targetRoot)
    return { error: '无效的目标库' }
  if (sameResolvedPathIgnoreCase(targetRoot, currentRoot)) {
    return { error: '目标库不能是当前模型库' }
  }
  // 目标必须是已保存的模型库（settings.modelsFolders），防止任意目录写入
  const saved = (getSettings().modelsFolders || []).some(
    (f) => typeof f === 'string' && sameResolvedPathIgnoreCase(f, targetRoot),
  )
  if (!saved) {
    return { error: '目标文件夹不是已保存的模型库，请先在侧栏添加该库' }
  }
  const transferMode = mode === 'move' ? 'move' : 'copy'
  // O6：源文件按真实路径校验（库内 junction 指向库外时拒绝传输/删除）
  const sourceReal = await resolveRealPath(currentRoot)
  if (!sourceReal) return { error: '当前模型库目录不可访问' }
  try {
    await fs.access(targetRoot)
  } catch {
    return { error: '目标库文件夹不存在或不可访问' }
  }
  if (await hasPendingJournal(targetRoot)) {
    return {
      error:
        '目标库有未完成的同步（上次会话异常退出），请先打开一次该模型库再试',
    }
  }

  return runMaintenance('import', targetRoot, async () => {
    const failed = []
    const skipped = []
    const planned = []
    for (const id of ids) {
      if (
        typeof id !== 'string' ||
        !isInRoot(id) ||
        !(await isPathRealWithin(id, sourceReal))
      ) {
        failed.push({ id: String(id), error: '模型不在当前库内' })
        continue
      }
      const meta = getModelMeta(id)
      const targetPath = path.join(targetRoot, toRelKey(id))
      try {
        await fs.stat(id)
      } catch {
        failed.push({ id, error: '模型文件不存在' })
        continue
      }
      try {
        await fs.access(targetPath)
        skipped.push({ id, reason: '目标库已存在同名文件' })
        continue
      } catch {
        /* 目标不存在，可传输 */
      }
      planned.push({ id, meta, targetPath, relKey: toRelKey(id) })
    }

    // 先写目标库元数据（一次写回，仅计划内且带元数据的条目；封面文件先复制），
    // 再传输文件——崩溃窗口下最多残留「目标库指向缺失文件的条目」（健康检查
    // 可清），不会出现「源文件已删而标注未迁移」的标注丢失
    let metaWritten = 0
    if (planned.length > 0) {
      const store = await readTargetStore(targetRoot)
      for (const item of planned) {
        if (!item.meta || typeof item.meta !== 'object') continue
        // 封面引用（.modelvault/covers/*）指向的文件复制到目标库（同名不覆盖）
        const coverRefs = [...(item.meta.covers || []), item.meta.cover].filter(
          (rel) => typeof rel === 'string' && rel.startsWith('.modelvault/'),
        )
        for (const rel of coverRefs) {
          try {
            const destCover = path.join(targetRoot, rel)
            await fs.mkdir(path.dirname(destCover), { recursive: true })
            await copyIfMissing(path.join(currentRoot, rel), destCover)
          } catch (err) {
            logger.warn(`封面跨库复制失败（引用保留）: ${rel} ${err.message}`)
          }
        }
        store.models[item.relKey] = item.meta
        metaWritten += 1
      }
      if (metaWritten > 0) {
        try {
          await writeTargetStore(targetRoot, store)
        } catch (err) {
          logger.error(`目标库元数据写入失败: ${err.message}`)
          return { error: `目标库元数据写入失败，已中止传输: ${err.message}` }
        }
      }
    }

    // 逐模型传输文件（主文件 + 存在的 sidecar；目标已存在的 sidecar 跳过不覆盖）
    const transferred = []
    const rollbackKeys = []
    for (const item of planned) {
      const { id, targetPath, relKey } = item
      try {
        // copyFile/rename 不创建父目录：先确保目标相对目录存在（相对路径镜像）
        await fs.mkdir(path.dirname(targetPath), { recursive: true })
        if (transferMode === 'move') {
          await moveFile(id, targetPath)
        } else {
          await fs.copyFile(id, targetPath)
        }
        const copiedSidecars = []
        for (const sidecar of sidecarFilesFor(id)) {
          try {
            await fs.access(sidecar)
          } catch {
            continue // sidecar 不存在，跳过
          }
          const dest = path.join(targetRoot, toRelKey(sidecar))
          try {
            if (transferMode === 'move') {
              await moveFile(sidecar, dest)
            } else {
              await copyIfMissing(sidecar, dest)
            }
            copiedSidecars.push(sidecar)
          } catch (err) {
            // sidecar 传输失败不阻塞模型本体
            logger.warn(
              `sidecar 跨库传输失败（不影响模型）: ${sidecar} ${err.message}`,
            )
          }
        }
        item.copiedSidecars = copiedSidecars
        transferred.push(item)
      } catch (err) {
        failed.push({ id, error: `文件传输失败: ${err.message}` })
        rollbackKeys.push(relKey)
        // move 半途失败（如跨盘拷贝中断）：rename 原子（源仍在）或 copy 已删源
        // （目标半文件），清掉目标半成品
        try {
          await fs.rm(targetPath, { force: true })
        } catch {
          /* 清理失败留待目标库健康检查 */
        }
      }
    }
    // 失败项回滚目标元数据条目（先写后传顺序的配套措施）
    if (rollbackKeys.length > 0 && metaWritten > 0) {
      try {
        const store = await readTargetStore(targetRoot)
        for (const relKey of rollbackKeys) delete store.models[relKey]
        await writeTargetStore(targetRoot, store)
      } catch (err) {
        logger.warn(
          `失败项元数据回滚失败（目标库健康检查可清理无效条目）: ${err.message}`,
        )
      }
    }

    // move 模式：清理源（源元数据 + 已不存在于源位置的文件无需处理）
    if (transferMode === 'move') {
      for (const item of transferred) {
        removeModelMeta(item.id)
      }
      if (transferred.length > 0) {
        try {
          await flushStoreSave()
        } catch (err) {
          logger.warn(`源库元数据落盘失败（防抖链会重试）: ${err.message}`)
        }
      }
    }

    logger.info(
      `跨库${transferMode === 'move' ? '移动' : '复制'}完成: ${transferred.length} 个 → ${targetRoot}` +
        `（跳过 ${skipped.length}，失败 ${failed.length}，元数据迁移 ${metaWritten} 条）`,
    )
    return {
      transferred: transferred.length,
      mode: transferMode,
      targetRoot,
      failed,
      skipped,
    }
  })
}
