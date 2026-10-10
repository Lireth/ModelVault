import { app, dialog } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { strToU8, unzipSync, zipSync } from 'fflate'
import logger from '../logger'
import {
  COVERS_DIR,
  DATA_DIR,
  DATA_FILE,
  getCurrentRoot,
  getSettings,
  updateSettings
} from './store'

/**
 * 数据备份与恢复（FEAT-3）：
 * - 导出：应用设置（settings.json）+ 当前模型库的关联存储（store.json 与
 *   covers/）打包为 zip；thumbs/ 为可再生产物，不纳入备份；
 * - 恢复：选择备份文件 → 恢复设置 → 如含库数据则选择目标模型文件夹
 *   （已存在关联数据时经原生确认框覆盖，旧数据留 .bak）→ 落盘生效。
 *
 * 备份文件结构：
 *   manifest.json       格式标识与内容清单（app/version/createdAt/library）
 *   settings.json       应用设置快照
 *   library/store.json  目标库元数据（按相对路径关联模型）
 *   library/covers/*    封面文件
 */

/** 备份格式标识（manifest.app 必须匹配才接受恢复） */
export const BACKUP_FORMAT = 'modelvault-backup'
/** 备份格式版本（大于当前版本的备份拒绝恢复，提示升级应用） */
export const BACKUP_VERSION = 1

/** 封面总字节上限：fflate 为内存打包，超大封面集会挤占主进程堆，超限引导手动复制 */
const MAX_COVERS_BYTES = 1024 * 1024 * 1024

/** 库数据在 zip 内的前缀 */
const LIB_PREFIX = 'library/'
const LIB_COVERS_PREFIX = 'library/covers/'

/**
 * 校验并解析备份清单（纯函数）。
 * @param {Uint8Array|null|undefined} bytes manifest.json 的内容字节
 * @returns {{ok: true, manifest: object} | {ok: false, error: string}}
 */
export function parseBackupManifest(bytes) {
  if (!bytes || bytes.byteLength === 0) {
    return { ok: false, error: '备份文件缺少 manifest.json' }
  }
  let manifest
  try {
    manifest = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return { ok: false, error: '备份文件的 manifest.json 损坏' }
  }
  if (manifest?.app !== BACKUP_FORMAT) {
    return { ok: false, error: '不是有效的 ModelVault 备份文件' }
  }
  if (!Number.isFinite(manifest.version) || manifest.version > BACKUP_VERSION) {
    return { ok: false, error: '备份文件版本过新，请升级应用后重试' }
  }
  return { ok: true, manifest }
}

/**
 * 校验 zip 条目名是否为安全的封面文件名（纯函数）：
 * 拒绝路径穿越（..）、绝对/驱动器路径与任何子目录结构——
 * 备份 zip 可能来自不可信来源，条目名不得参与拼接近路。
 * @param {string} entryName zip 内的完整条目名
 * @returns {string} 安全的文件名；不合法返回 ''
 */
export function safeCoverName(entryName) {
  if (typeof entryName !== 'string' || !entryName.startsWith(LIB_COVERS_PREFIX)) return ''
  const base = entryName.slice(LIB_COVERS_PREFIX.length)
  if (!base || base === '.' || base === '..') return ''
  if (base.includes('/') || base.includes('\\')) return ''
  // 驱动器相对路径（如 C:x.png）在 Windows 上会改变解析基准
  if (/^[a-zA-Z]:/.test(base)) return ''
  return base
}

/** 路径存在性判断（不区分文件/目录） */
async function pathExists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * 导出备份：弹保存对话框，将设置与当前库关联存储打包为 zip。
 * @param {import('electron').BrowserWindow} win 父窗口
 * @returns {Promise<{path: string, sizeBytes: number, library: boolean, models: number, covers: number}
 *   | {canceled: true} | {error: string}>}
 */
export async function exportBackup(win) {
  const settings = getSettings()
  const root = getCurrentRoot()
  /** @type {Record<string, Uint8Array>} */
  const files = {}
  const manifest = {
    app: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    settings: true
  }
  files['settings.json'] = strToU8(JSON.stringify(settings, null, 2))

  let models = 0
  let covers = 0
  if (root) {
    const storeFile = path.join(root, DATA_DIR, DATA_FILE)
    const coversDir = path.join(root, DATA_DIR, COVERS_DIR)
    let storeText = ''
    try {
      storeText = await fs.readFile(storeFile, 'utf-8')
      models = Object.keys(JSON.parse(storeText)?.models || {}).length
    } catch (err) {
      if (err.code !== 'ENOENT') {
        return { error: `读取关联存储失败: ${err.message}` }
      }
      // 该库尚未生成过关联数据：仅备份应用设置
    }
    if (storeText) {
      // 封面整体纳入前先统计总字节，超限拒绝（内存打包的保护阀）
      let totalBytes = 0
      const coverNames = await fs.readdir(coversDir).catch(() => [])
      for (const name of coverNames) {
        const stat = await fs.stat(path.join(coversDir, name)).catch(() => null)
        if (stat?.isFile()) totalBytes += stat.size
      }
      if (totalBytes > MAX_COVERS_BYTES) {
        return {
          error: `封面数据总量超过 ${Math.floor(MAX_COVERS_BYTES / 1024 / 1024)}MB，为避免内存占用过高已停止备份；请手动复制 .modelvault 文件夹`
        }
      }
      files[`${LIB_PREFIX}${DATA_FILE}`] = strToU8(storeText)
      manifest.library = { root, models }
      for (const name of coverNames) {
        const buf = await fs.readFile(path.join(coversDir, name)).catch(() => null)
        if (!buf) continue
        files[`${LIB_COVERS_PREFIX}${name}`] = new Uint8Array(buf)
        covers += 1
      }
      manifest.library.covers = covers
    }
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))

  const date = new Date().toISOString().slice(0, 10)
  const result = await dialog.showSaveDialog(win, {
    title: '导出备份',
    defaultPath: `modelvault-backup-${date}.zip`,
    filters: [{ name: '备份文件', extensions: ['zip'] }]
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  try {
    const zipped = zipSync(files, { level: 6 })
    await fs.writeFile(result.filePath, zipped)
    logger.info(`备份已导出: ${result.filePath}（${models} 模型 / ${covers} 封面）`)
    return {
      path: result.filePath,
      sizeBytes: zipped.byteLength,
      library: Boolean(manifest.library),
      models,
      covers
    }
  } catch (err) {
    logger.warn(`备份导出失败: ${err.message}`)
    return { error: `备份写入失败: ${err.message}` }
  }
}

/**
 * 将库数据还原到目标根目录：先解出到临时目录，校验无误后与既有目录交换
 * （既有数据留 .bak 而非直接删除，恢复中断可回滚）。
 * @returns {Promise<{root: string, models: number, covers: number, skipped: number}>}
 */
async function restoreLibrary(root, unzipped) {
  const decoder = new TextDecoder()
  const storeText = decoder.decode(unzipped[`${LIB_PREFIX}${DATA_FILE}`])
  // 落盘前先校验 JSON：损坏的备份不应触发任何目录交换
  const parsed = JSON.parse(storeText)

  const dataDir = path.join(root, DATA_DIR)
  const stamp = Date.now()
  const tmpDir = `${dataDir}.restore-${stamp}`
  await fs.rm(tmpDir, { recursive: true, force: true })
  await fs.mkdir(path.join(tmpDir, COVERS_DIR), { recursive: true })
  await fs.writeFile(path.join(tmpDir, DATA_FILE), storeText)

  let covers = 0
  let skipped = 0
  for (const [entryName, data] of Object.entries(unzipped)) {
    if (!entryName.startsWith(LIB_COVERS_PREFIX)) continue
    const name = safeCoverName(entryName)
    if (!name) {
      skipped += 1
      logger.warn(`恢复时跳过不安全的备份条目: ${entryName}`)
      continue
    }
    await fs.writeFile(path.join(tmpDir, COVERS_DIR, name), data)
    covers += 1
  }

  // 交换：既有目录让位到 .bak，临时目录上位；上位失败则回滚，目标目录不留半成品
  if (await pathExists(dataDir)) {
    const bakDir = `${dataDir}.bak-${stamp}`
    await fs.rename(dataDir, bakDir)
    try {
      await fs.rename(tmpDir, dataDir)
    } catch (err) {
      await fs.rename(bakDir, dataDir)
      throw err
    }
  } else {
    await fs.rename(tmpDir, dataDir)
  }
  return { root, models: Object.keys(parsed?.models || {}).length, covers, skipped }
}

/**
 * 从备份恢复：依次经原生对话框完成「选备份文件 →（含库数据时）选目标文件夹
 * → 覆盖确认」，全流程在主进程完成，渲染进程一次调用即可。
 * @param {import('electron').BrowserWindow} win 父窗口
 * @returns {Promise<{settingsRestored: boolean, libraryRestored?: object, skipped?: number}
 *   | {canceled: true} | {error: string}>}
 */
export async function importBackup(win) {
  const pick = await dialog.showOpenDialog(win, {
    title: '选择备份文件',
    properties: ['openFile'],
    filters: [{ name: 'ModelVault 备份', extensions: ['zip'] }]
  })
  if (pick.canceled || !pick.filePaths[0]) return { canceled: true }
  const filePath = pick.filePaths[0]

  let unzipped
  try {
    unzipped = unzipSync(new Uint8Array(await fs.readFile(filePath)))
  } catch (err) {
    return { error: `备份文件读取失败: ${err.message}` }
  }
  const parsedManifest = parseBackupManifest(unzipped['manifest.json'])
  if (!parsedManifest.ok) return { error: parsedManifest.error }
  const manifest = parsedManifest.manifest

  // 设置恢复（规范化与落盘走既有 updateSettings 管线）
  let settingsRestored = false
  if (manifest.settings && unzipped['settings.json']) {
    try {
      const settings = JSON.parse(new TextDecoder().decode(unzipped['settings.json']))
      await updateSettings(settings)
      settingsRestored = true
    } catch (err) {
      return { error: `备份中的设置数据损坏: ${err.message}` }
    }
  }

  // 库数据恢复：需要用户指定目标模型文件夹
  if (manifest.library && unzipped[`${LIB_PREFIX}${DATA_FILE}`]) {
    const target = await dialog.showOpenDialog(win, {
      title: '选择要恢复到的模型文件夹',
      properties: ['openDirectory']
    })
    if (target.canceled || !target.filePaths[0]) {
      return {
        error: '已取消选择目标文件夹（应用设置已恢复，库数据未恢复）',
        settingsRestored,
        partial: true
      }
    }
    const root = target.filePaths[0]
    if (await pathExists(path.join(root, DATA_DIR))) {
      const choice = await dialog.showMessageBox(win, {
        type: 'warning',
        title: '覆盖确认',
        message: '目标文件夹已存在关联数据（.modelvault）',
        detail:
          '恢复将覆盖其中的标注与封面。现有数据会先备份为 .modelvault.bak-<时间戳>，确认无误后可手动删除。',
        buttons: ['取消', '覆盖恢复'],
        defaultId: 0,
        cancelId: 0
      })
      if (choice.response !== 1) {
        return {
          error: '已取消覆盖恢复（应用设置已恢复，库数据未恢复）',
          settingsRestored,
          partial: true
        }
      }
    }
    try {
      const libraryRestored = await restoreLibrary(root, unzipped)
      logger.info(
        `备份已恢复: ${filePath} → ${root}（${libraryRestored.models} 模型 / ${libraryRestored.covers} 封面）`
      )
      return { settingsRestored, libraryRestored, skipped: libraryRestored.skipped }
    } catch (err) {
      logger.warn(`备份恢复失败: ${err.message}`)
      return { error: `库数据恢复失败: ${err.message}`, settingsRestored, partial: true }
    }
  }

  return { settingsRestored }
}
