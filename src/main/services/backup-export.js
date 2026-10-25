import { app, dialog } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
import {
  COVERS_DIR,
  DATA_DIR,
  DATA_FILE,
  flushSettingsSave,
  flushStoreSave,
  getCurrentRoot,
  getLibrarySettings,
  toRelKey,
} from './store'
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  PARTIAL_BACKUP_VERSION,
} from './backup-format'
import { MAX_COVERS_BYTES, writeBackupZipToFile } from './backup-zip'

/**
 * 备份导出流程（O2 拆分）：
 * 将库设置（settings.json，不含激活库/库列表）与当前模型库的关联存储
 * （store.json 与 covers/）打包为 zip；thumbs/ 为可再生产物，不纳入备份。
 * 支持三种范围（FN-08）：full 完整库 / selected 仅选中模型（含其封面）/
 * metadata 全库标注但不含封面（体积小，用于快速迁移/审阅）。
 */

/** 封面读写的有限并发数：比串行快，同时避免数百个文件句柄一次性打开 */
const COVER_IO_CONCURRENCY = 8

/**
 * 有限并发映射（A-01）：固定数量的 worker 抢占式领取任务，
 * 结果按输入下标归位（顺序稳定）。
 * @template T, R
 * @param {T[]} items 输入列表
 * @param {number} limit 最大并发数
 * @param {(item: T, index: number) => Promise<R>} task 单任务执行器
 * @returns {Promise<R[]>} 与输入同序的结果
 */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await task(items[i], i)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  )
  return results
}

/**
 * 组装备份 zip 的各部件（无对话框核心，OPT-07 自动备份复用）：
 * 静止写盘链 → 读库设置与关联存储 → 按范围裁剪，返回 zip 部件与统计。
 * @param {{mode?: 'full'|'selected'|'metadata', ids?: string[]}} [options]
 *   full（默认）：完整库备份；selected：仅选中模型；metadata：全库标注
 *   但不含封面（体积小，用于快速迁移/审阅与自动备份）
 * @returns {Promise<any>} 成功 {parts, models, covers, mode, partial}；
 *   失败 {error}（无可备份标注等）
 */
export async function buildBackupParts(options = {}) {
  // B-02：先静止两路写盘链再读磁盘——标注为 500ms 防抖落盘，
  // 刚修改的备注/标签若不 flush 不会进入备份（用户以为已备份）。
  await Promise.all([flushStoreSave(), flushSettingsSave()])
  // 库设置随模型库走：备份当前库的设置（不含引导字段）——恢复到任意
  // 模型文件夹时配置随包生效，且不会劫持本机的激活库/库列表
  const librarySettings = getLibrarySettings()
  const root = getCurrentRoot()
  const mode =
    options.mode === 'selected' || options.mode === 'metadata'
      ? options.mode
      : 'full'
  const partial = mode !== 'full'
  const settingsText = JSON.stringify(librarySettings, null, 2)
  const manifest = {
    app: BACKUP_FORMAT,
    // 部分备份使用更高版本号：旧应用不认识 partial，需显式拒绝而非按全量恢复
    version: partial ? PARTIAL_BACKUP_VERSION : BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    settings: true,
    mode,
    partial,
  }

  let models = 0
  let covers = 0
  let storeText = ''
  const coverFiles = []
  if (root) {
    const storeFile = path.join(root, DATA_DIR, DATA_FILE)
    const coversDir = path.join(root, DATA_DIR, COVERS_DIR)
    let parsedStore = null
    try {
      storeText = await fs.readFile(storeFile, 'utf-8')
      parsedStore = JSON.parse(storeText)
      models = Object.keys(parsedStore?.models || {}).length
    } catch (err) {
      if (err.code !== 'ENOENT') {
        return { error: `读取关联存储失败: ${err.message}` }
      }
      // 该库尚未生成过关联数据：仅备份应用设置
    }

    // FN-08：选择性/元数据模式没有标注可导出时明确失败，避免产出空备份
    if (mode !== 'full' && !storeText) {
      return { error: '当前模型库没有可备份的模型标注' }
    }

    // FN-08：选择性/元数据模式在内存中裁剪 store.json（不修改磁盘数据）
    let keepModels = null
    if (storeText && mode !== 'full') {
      const modelMap =
        parsedStore?.models && typeof parsedStore.models === 'object'
          ? parsedStore.models
          : {}
      if (mode === 'selected') {
        const wanted = new Set(
          (Array.isArray(options.ids) ? options.ids : [])
            .map((id) => toRelKey(id))
            .filter(Boolean),
        )
        keepModels = Object.keys(modelMap).filter((key) => wanted.has(key))
        if (keepModels.length === 0) {
          return { error: '当前筛选结果没有可备份的模型标注' }
        }
      } else {
        keepModels = Object.keys(modelMap)
      }
      const filtered = {}
      for (const key of keepModels) filtered[key] = modelMap[key]
      // metadata 模式同样不携带封面
      storeText = JSON.stringify({ ...parsedStore, models: filtered }, null, 2)
      models = keepModels.length
    }

    if (storeText) {
      // 封面写入前先统计总字节，超限拒绝。
      // O5：统计并发化（复用下方读取的同一并发度）——数百封面下逐个串行
      // await stat 的统计阶段比 8 路并发的读取阶段还慢，成为备份瓶颈
      let coverNames = await fs.readdir(coversDir).catch(() => [])
      if (mode === 'selected' && parsedStore?.models) {
        // 只保留选中模型引用的封面文件（文件名即 covers 内的 basename）
        const referenced = new Set()
        for (const key of keepModels || []) {
          const meta = parsedStore.models[key] || {}
          for (const rel of [...(meta.covers || []), meta.cover]) {
            if (typeof rel === 'string' && rel)
              referenced.add(path.basename(rel))
          }
        }
        coverNames = coverNames.filter((name) => referenced.has(name))
      } else if (mode === 'metadata') {
        coverNames = []
      }
      const stats = await mapLimit(coverNames, COVER_IO_CONCURRENCY, (name) =>
        fs.stat(path.join(coversDir, name)).catch(() => null),
      )
      let totalBytes = 0
      for (let i = 0; i < coverNames.length; i++) {
        const stat = stats[i]
        if (!stat?.isFile()) continue
        totalBytes += stat.size
        coverFiles.push({
          name: coverNames[i],
          path: path.join(coversDir, coverNames[i]),
        })
      }
      if (totalBytes > MAX_COVERS_BYTES) {
        return {
          error: `封面数据总量超过 ${Math.floor(MAX_COVERS_BYTES / 1024 / 1024)}MB，为避免内存占用过高已停止备份；请手动复制 .modelvault 文件夹`,
        }
      }
      covers = coverFiles.length
      manifest.library = { root, models, covers }
    }
  }
  return {
    parts: {
      settingsText,
      storeText,
      manifestText: JSON.stringify(manifest, null, 2),
      covers: coverFiles,
    },
    models,
    covers,
    mode,
    partial,
  }
}

/**
 * 导出备份：弹保存对话框，将设置与当前库关联存储打包为 zip。
 * @param {import('electron').BrowserWindow} win 父窗口
 * @param {{mode?: 'full'|'selected'|'metadata', ids?: string[]}} [options]
 *   full（默认）：完整库备份；selected：仅当前筛选的模型标注与封面；
 *   metadata：全库标注但不含封面（体积小，用于快速迁移/审阅）
 * @returns {Promise<any>} 成功 {path,sizeBytes,library,models,covers,mode,partial}；
 *   取消 {canceled:true}；失败 {error}（handler 逐字段消费）
 */
export async function exportBackup(win, options = {}) {
  const built = await buildBackupParts(options)
  if (built.error) return { error: built.error }
  const { parts, models, covers, mode, partial } = built

  const date = new Date().toISOString().slice(0, 10)
  const result = await dialog.showSaveDialog(win, {
    title: '导出备份',
    defaultPath: `modelvault-backup-${date}.zip`,
    filters: [{ name: '备份文件', extensions: ['zip'] }],
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  try {
    // OPT-10：封面逐个读入压缩流，不再把所有封面缓冲进内存。
    // 压缩期间主进程仅保留当前读块，内存峰值与封面总量解耦。
    await writeBackupZipToFile(result.filePath, parts)
    const outStat = await fs.stat(result.filePath)
    logger.info(
      `备份已导出: ${result.filePath}（${models} 模型 / ${covers} 封面）`,
    )
    return {
      path: result.filePath,
      sizeBytes: outStat.size,
      library: Boolean(parts.storeText),
      models,
      covers,
      mode,
      partial,
    }
  } catch (err) {
    // 失败时清理半成品，避免用户误以为备份可用
    await fs.rm(result.filePath, { force: true }).catch(() => {})
    logger.warn(`备份导出失败: ${err.message}`)
    return { error: `备份写入失败: ${err.message}` }
  }
}
