import { app, dialog } from 'electron'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { strToU8, Unzip, UnzipInflate, unzip, zip } from 'fflate'
import logger from '../logger'
import {
  COVERS_DIR,
  DATA_DIR,
  DATA_FILE,
  LIB_SETTINGS_FILE,
  flushSettingsSave,
  flushStoreSave,
  getCurrentRoot,
  getLibrarySettings,
  normalizeLibrarySettings,
  normalizeStoreData,
  saveLibrarySettings
} from './store'

/**
 * 数据备份与恢复（FEAT-3）：
 * - 导出：当前库设置（settings.json，不含激活库/库列表）+ 当前模型库的
 *   关联存储（store.json 与 covers/）打包为 zip；thumbs/ 为可再生产物，
 *   不纳入备份；
 * - 恢复：选择备份文件 → 如含库数据则选择目标模型文件夹（设置随目录交换
 *   写入目标库；已存在关联数据时经原生确认框覆盖，旧数据留 .bak）→ 落盘生效。
 *
 * 备份文件结构：
 *   manifest.json       格式标识与内容清单（app/version/createdAt/library）
 *   settings.json       库设置快照（随模型库走，不含引导字段）
 *   library/store.json  目标库元数据（按相对路径关联模型）
 *   library/covers/*    封面文件
 */

/** 备份格式标识（manifest.app 必须匹配才接受恢复） */
export const BACKUP_FORMAT = 'modelvault-backup'
/** 备份格式版本（大于当前版本的备份拒绝恢复，提示升级应用） */
export const BACKUP_VERSION = 1

/** 封面总字节上限：fflate 为内存打包，超大封面集会挤占主进程堆，超限引导手动复制 */
const MAX_COVERS_BYTES = 1024 * 1024 * 1024

/** 封面读写的有限并发数：比串行快，同时避免数百个文件句柄一次性打开 */
const COVER_IO_CONCURRENCY = 8

/** 备份压缩级别（与历史 zipSync 一致） */
const ZIP_LEVEL = 6

/**
 * 备份文件大小上限（O5/B-04）：压缩包本身仍做上限校验，避免超大文件
 * 长时间占用磁盘/CPU；解压侧另有逐条与总量限制，见下方 UNZIP_* 常量。
 */
const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024

/* ---------------- 不可信 zip 解压限制（B-04） ---------------- */

/** 流式读取压缩包的块大小（1MB：解压分片让出事件循环） */
const UNZIP_CHUNK_SIZE = 1024 * 1024
/** 条目数量上限：防止海量小条目拖垮解压与目录交换 */
const MAX_BACKUP_ENTRIES = 20000
/** 清单文件上限：正常仅数 KB，给足版本演进余量 */
const MAX_MANIFEST_BYTES = 256 * 1024
/** 库设置文件上限 */
const MAX_SETTINGS_BYTES = 8 * 1024 * 1024
/** store.json 上限（万级模型的标注仍远小于此值） */
const MAX_STORE_BYTES = 256 * 1024 * 1024
/** 单张封面上限（与导入封面时的 50MB 预检同量级） */
const MAX_COVER_ENTRY_BYTES = 64 * 1024 * 1024
/**
 * 解压总量上限：封面总量上限 + 元数据/设置/清单上限。
 * 该限制针对“声明大小缺失/伪造”的压缩包，以实际解出字节累计判定。
 */
const MAX_UNZIP_BYTES =
  MAX_COVERS_BYTES + MAX_STORE_BYTES + MAX_SETTINGS_BYTES + MAX_MANIFEST_BYTES

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
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  )
  return results
}

/**
 * 异步压缩备份包（A-01）：fflate 异步 zip 在无 Worker 环境下也按分片执行，
 * 每个分片之间让出事件循环——封面总量可达数百 MB 时，IPC 处理与窗口交互
 * 不再被 deflate 阻塞（同步 zipSync 会冻结整个主进程）。
 * @param {Record<string, Uint8Array>} files 条目名 → 内容字节
 * @returns {Promise<Uint8Array>} zip 字节
 */
export function zipBackupAsync(files) {
  return new Promise((resolve, reject) => {
    // fflate 对 null 入参容忍为空 zip（静默产出无内容备份，掩盖调用方错误），
    // 此处显式收窄契约
    if (!files || typeof files !== 'object') {
      reject(new Error('备份内容无效：缺少待压缩文件'))
      return
    }
    zip(files, { level: ZIP_LEVEL }, (err, data) => {
      if (err) reject(err)
      else resolve(data)
    })
  })
}

/**
 * 异步解压备份包（A-01）：与 zipBackupAsync 同理，解压 GB 级 zip 时
 * 分片让出事件循环，避免 importBackup 期间界面冻结。
 * @param {Uint8Array} bytes zip 字节
 * @returns {Promise<Record<string, Uint8Array>>} 条目名 → 内容字节
 */
export function unzipBackupAsync(bytes) {
  return new Promise((resolve, reject) => {
    unzip(bytes, (err, data) => {
      if (err) reject(err)
      else resolve(data)
    })
  })
}

/** 库数据在 zip 内的前缀 */
const LIB_PREFIX = 'library/'
const LIB_COVERS_PREFIX = 'library/covers/'

/** 恢复临时目录前缀（解出校验用，成功即改名，残留即垃圾） */
const RESTORE_TMP_PREFIX = `${DATA_DIR}.restore-`
/** 覆盖恢复时旧数据的留存目录前缀 */
const BACKUP_DIR_PREFIX = `${DATA_DIR}.bak-`

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

/** 人类可读的 MB 文案（错误提示用） */
function formatLimit(bytes) {
  return `${Math.floor(bytes / 1024 / 1024)}MB`
}

/**
 * 备份条目解压上限（B-04）：返回 0 表示不认识该条目，直接跳过不调用
 * start()（fflate 不会为其分配解压缓冲）。
 * @param {string} name zip 内条目名
 * @returns {number} 字节上限
 */
function backupEntryLimit(name) {
  if (name === 'manifest.json') return MAX_MANIFEST_BYTES
  if (name === 'settings.json') return MAX_SETTINGS_BYTES
  if (name === `${LIB_PREFIX}${DATA_FILE}`) return MAX_STORE_BYTES
  if (safeCoverName(name)) return MAX_COVER_ENTRY_BYTES
  return 0
}

/** 合并解压分块（空/单块避免额外分配） */
function concatBytes(chunks, size) {
  if (chunks.length === 0) return new Uint8Array(0)
  if (chunks.length === 1) return chunks[0]
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * 流式解压备份 zip（B-04）：
 * - 逐块读取文件，不把整个压缩包读入内存；
 * - 只解压备份格式认识的条目，未知/不安全的封面条目直接跳过；
 * - 逐条与总量都设上限，压缩比再高也会在超限时立即中止；
 * - 重复条目直接拒绝（避免同名条目覆盖产生歧义）。
 *
 * @param {string} filePath zip 文件路径
 * @param {{manifestOnly?: boolean, stats?: {skippedCovers: number}}} [options]
 *   manifestOnly 仅解出 manifest.json；stats 用于回传被跳过的非法封面条目数
 * @returns {Promise<Record<string, Uint8Array>>} 条目名 → 内容
 */
async function streamBackupZip(filePath, { manifestOnly = false, stats = null } = {}) {
  // 无原型对象：条目名来自不可信 zip，避免任何特殊键影响查找语义
  const entries = Object.create(null)
  const seen = new Set()
  let entryCount = 0
  let totalBytes = 0
  let failure = null
  const fail = (err) => {
    if (!failure) failure = err
  }

  const unzipper = new Unzip()
  unzipper.register(UnzipInflate)
  unzipper.onfile = (file) => {
    if (failure) return
    entryCount += 1
    if (entryCount > MAX_BACKUP_ENTRIES) {
      fail(new Error(`备份条目数量超过上限（${MAX_BACKUP_ENTRIES}）`))
      return
    }
    const limit = manifestOnly
      ? file.name === 'manifest.json'
        ? MAX_MANIFEST_BYTES
        : 0
      : backupEntryLimit(file.name)
    // 不认识的条目（含路径穿越的封面名）不解压，直接跳过
    if (!limit) {
      if (!manifestOnly && stats && file.name.startsWith(LIB_COVERS_PREFIX)) {
        stats.skippedCovers += 1
      }
      return
    }
    if (seen.has(file.name)) {
      fail(new Error(`备份包含重复条目: ${file.name}`))
      return
    }
    seen.add(file.name)
    // 头部声明大小可提前拒绝明显的压缩炸弹（缺失时由实际字节上限兜底）
    if (typeof file.originalSize === 'number' && file.originalSize > limit) {
      fail(new Error(`备份条目 ${file.name} 解压后超过 ${formatLimit(limit)} 上限`))
      return
    }

    const chunks = []
    let received = 0
    file.ondata = (err, chunk, final) => {
      if (failure) return
      if (err) {
        fail(err)
        return
      }
      if (chunk && chunk.length > 0) {
        received += chunk.length
        totalBytes += chunk.length
        if (received > limit) {
          fail(new Error(`备份条目 ${file.name} 解压后超过 ${formatLimit(limit)} 上限`))
          file.terminate?.()
          return
        }
        if (totalBytes > MAX_UNZIP_BYTES) {
          fail(new Error(`备份解压总量超过 ${formatLimit(MAX_UNZIP_BYTES)} 上限`))
          file.terminate?.()
          return
        }
        chunks.push(chunk)
      }
      if (final) entries[file.name] = concatBytes(chunks, received)
    }
    try {
      file.start()
    } catch (err) {
      fail(err)
    }
  }

  const stream = createReadStream(filePath, { highWaterMark: UNZIP_CHUNK_SIZE })
  try {
    for await (const chunk of stream) {
      if (failure) break
      try {
        unzipper.push(chunk, false)
      } catch (err) {
        fail(err)
        break
      }
    }
    if (failure) throw failure
    // 结束流：触发剩余条目收尾（空条目在 final 时写入 entries）
    unzipper.push(new Uint8Array(0), true)
    if (failure) throw failure
    return entries
  } finally {
    stream.destroy()
  }
}

/**
 * 第一遍：只读 manifest.json（B-04 manifest-first）。
 * 校验格式/版本通过后再进行完整解压，避免为无效备份付出解压成本。
 * @param {string} filePath zip 文件路径
 * @returns {Promise<Uint8Array|null>} 清单内容；不存在返回 null
 */
async function readBackupManifest(filePath) {
  const entries = await streamBackupZip(filePath, { manifestOnly: true })
  return entries['manifest.json'] || null
}

/**
 * 第二遍：解出恢复所需的设置/元数据/封面（带逐条与总量上限）。
 * @param {string} filePath zip 文件路径
 * @returns {Promise<{files: Record<string, Uint8Array>, skippedCovers: number}>}
 */
async function unzipBackupEntries(filePath) {
  const stats = { skippedCovers: 0 }
  const files = await streamBackupZip(filePath, { stats })
  return { files, skippedCovers: stats.skippedCovers }
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
  // B-02：先静止两路写盘链再读磁盘——标注为 500ms 防抖落盘，
  // 刚修改的备注/标签若不 flush 不会进入备份（用户以为已备份）。
  await Promise.all([flushStoreSave(), flushSettingsSave()])
  // 库设置随模型库走：备份当前库的设置（不含引导字段）——恢复到任意
  // 模型文件夹时配置随包生效，且不会劫持本机的激活库/库列表
  const librarySettings = getLibrarySettings()
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
  files['settings.json'] = strToU8(JSON.stringify(librarySettings, null, 2))

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
      // 封面整体纳入前先统计总字节，超限拒绝（内存打包的保护阀）。
      // O5：统计并发化（复用下方读取的同一并发度）——数百封面下逐个串行
      // await stat 的统计阶段比 8 路并发的读取阶段还慢，成为备份瓶颈
      const coverNames = await fs.readdir(coversDir).catch(() => [])
      const stats = await mapLimit(coverNames, COVER_IO_CONCURRENCY, (name) =>
        fs.stat(path.join(coversDir, name)).catch(() => null)
      )
      let totalBytes = 0
      for (const stat of stats) {
        if (stat?.isFile()) totalBytes += stat.size
      }
      if (totalBytes > MAX_COVERS_BYTES) {
        return {
          error: `封面数据总量超过 ${Math.floor(MAX_COVERS_BYTES / 1024 / 1024)}MB，为避免内存占用过高已停止备份；请手动复制 .modelvault 文件夹`
        }
      }
      files[`${LIB_PREFIX}${DATA_FILE}`] = strToU8(storeText)
      manifest.library = { root, models }
      // 封面有限并发读取（A-01）：串行 await 数百张封面时耗时叠加，
      // 8 路并发显著缩短备份时间，且不会一次性占满文件句柄
      const buffers = await mapLimit(coverNames, COVER_IO_CONCURRENCY, (name) =>
        fs.readFile(path.join(coversDir, name)).catch(() => null)
      )
      for (let i = 0; i < coverNames.length; i++) {
        const buf = buffers[i]
        if (!buf) continue
        files[`${LIB_COVERS_PREFIX}${coverNames[i]}`] = new Uint8Array(buf)
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
    // 异步分片压缩（A-01）：数百 MB 封面期间主进程事件循环保持响应
    const zipped = await zipBackupAsync(files)
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
 * 清理恢复过程的残留目录（OPT-18）：
 * - `.modelvault.restore-*`：解出用临时目录，正常流程结束时应已改名，存在即残留；
 * - `.modelvault.bak-*`：覆盖恢复的旧数据留存，仅保留最新一份（keepBak），
 *   更早的属可重复生成的陈旧副本——不清除会在用户模型目录无限累积
 *   （每份含全部封面，可达数百 MB）。
 * 单项删除失败仅告警，不中断恢复主流程。
 * @param {string} root 目标模型根目录
 * @param {string} keepBakName 本次恢复生成的 .bak 目录名（basename；无既有数据时为空串）
 */
async function pruneRestoreArtifacts(root, keepBakName) {
  let entries
  try {
    entries = await fs.readdir(root)
  } catch {
    return
  }
  for (const name of entries) {
    const isStaleTmp = name.startsWith(RESTORE_TMP_PREFIX)
    const isOldBackup = name.startsWith(BACKUP_DIR_PREFIX) && name !== keepBakName
    if (!isStaleTmp && !isOldBackup) continue
    await fs.rm(path.join(root, name), { recursive: true, force: true }).catch((err) => {
      logger.warn(`清理恢复残留目录失败: ${err.message}`)
    })
  }
}

/**
 * 从备份恢复库数据到目标模型根目录（解出 → 校验 → 目录交换）：
 * 既有数据留 .bak 而非直接删除，恢复中断可回滚；失败即清理本次临时目录，
 * 成功后按「仅保留最新 .bak」治理残留（OPT-18）。
 * @param {string} root 目标模型根目录
 * @param {Record<string, Uint8Array>} unzipped 解压出的备份条目
 * @param {object|null} [libSettings] 随备份恢复的库设置（写入目标库的
 *   .modelvault/settings.json，随目录交换原子生效；空则不写）
 * @param {number} [skippedCovers] 解压阶段跳过的非法封面条目数（B-04）
 * @returns {Promise<{root: string, models: number, covers: number, skipped: number}>}
 */
async function restoreLibrary(root, unzipped, libSettings = null, skippedCovers = 0) {
  const decoder = new TextDecoder()
  const storeText = decoder.decode(unzipped[`${LIB_PREFIX}${DATA_FILE}`])
  // 落盘前先校验 JSON 并规范化（B-04）：备份来自不可信来源，
  // store.json 的键与字段必须按与磁盘加载相同的规则清洗（原型污染/超大字段）
  const parsed = JSON.parse(storeText)
  const sanitized = normalizeStoreData(parsed)
  const sanitizedText = JSON.stringify(sanitized, null, 2)
  const sourceCount =
    parsed && typeof parsed === 'object' && parsed.models && typeof parsed.models === 'object'
      ? Object.keys(parsed.models).length
      : 0
  if (Object.keys(sanitized.models).length !== sourceCount) {
    logger.warn(
      `备份元数据已清洗: ${sourceCount} → ${Object.keys(sanitized.models).length} 条（剔除非法键/字段）`
    )
  }
  // 静止两路写盘链（B1/B-02 修复配套）：在途的防抖/原子写完成于目录交换之后时，
  // 其 rename 会把恢复前的旧数据覆盖到刚恢复的 store.json / settings.json 上。
  // 恢复目标为当前激活根时风险最大；对其他根 flush 只是把当前根待落盘数据
  // 写进其自身文件，无副作用
  await Promise.all([flushStoreSave(), flushSettingsSave()])

  const dataDir = path.join(root, DATA_DIR)
  const stamp = Date.now()
  const tmpDir = `${dataDir}.restore-${stamp}`
  await fs.rm(tmpDir, { recursive: true, force: true })
  try {
    await fs.mkdir(path.join(tmpDir, COVERS_DIR), { recursive: true })
    await fs.writeFile(path.join(tmpDir, DATA_FILE), sanitizedText)
    if (libSettings) {
      // 库设置随备份恢复（设置随模型库走）：写入临时目录，随目录交换原子生效
      await fs.writeFile(
        path.join(tmpDir, LIB_SETTINGS_FILE),
        JSON.stringify(libSettings, null, 2)
      )
    }

    let covers = 0
    let skipped = skippedCovers
    // 封面有限并发写入（A-01）；JS 单线程下计数器在 await 间隙无竞态
    const coverEntries = Object.entries(unzipped).filter(([entryName]) =>
      entryName.startsWith(LIB_COVERS_PREFIX)
    )
    await mapLimit(coverEntries, COVER_IO_CONCURRENCY, async ([entryName, data]) => {
      const name = safeCoverName(entryName)
      if (!name) {
        skipped += 1
        logger.warn(`恢复时跳过不安全的备份条目: ${entryName}`)
        return
      }
      await fs.writeFile(path.join(tmpDir, COVERS_DIR, name), data)
      // 写盘后立即释放该条目（O5）：数百 MB 的解压封面集不再整体驻留到
      // 恢复流程结束，堆峰值随写入推进递减
      unzipped[entryName] = null
      covers += 1
    })

    // 交换：既有目录让位到 .bak，临时目录上位；上位失败则回滚，目标目录不留半成品
    let bakDir = ''
    if (await pathExists(dataDir)) {
      bakDir = `${dataDir}.bak-${stamp}`
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

    // 残留治理（OPT-18）：更早的 .bak 仅保留本次一份；历史 .restore 临时目录清除
    await pruneRestoreArtifacts(root, bakDir ? path.basename(bakDir) : '')
    return { root, models: Object.keys(sanitized.models).length, covers, skipped }
  } catch (err) {
    // 失败兜底：清理本次解出的临时目录，不在用户模型目录留垃圾
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
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

  let manifestBytes
  try {
    // 大小预检（O5）：先于读取——超大压缩包长时间占用磁盘/CPU；
    // 解压侧另有逐条与总量上限（B-04）
    const fileStat = await fs.stat(filePath)
    if (fileStat.size > MAX_BACKUP_BYTES) {
      return {
        error: `备份文件超过 ${Math.floor(MAX_BACKUP_BYTES / 1024 / 1024 / 1024)}GB，为避免内存占用过高已停止恢复；请手动复制 .modelvault 文件夹`
      }
    }
    // 第一遍：流式只读 manifest（B-04）。无效备份不进入完整解压。
    manifestBytes = await readBackupManifest(filePath)
  } catch (err) {
    return { error: `备份文件读取失败: ${err.message}` }
  }
  const parsedManifest = parseBackupManifest(manifestBytes)
  if (!parsedManifest.ok) return { error: parsedManifest.error }
  const manifest = parsedManifest.manifest

  let unpacked
  try {
    // 第二遍：流式解出已知条目，逐条/总量限额，未知条目直接跳过
    unpacked = await unzipBackupEntries(filePath)
  } catch (err) {
    return { error: `备份文件解压失败: ${err.message}` }
  }
  const { files: unzipped, skippedCovers } = unpacked

  // 设置恢复（库设置随模型库走）：先规范化并暂存——含库数据时随目录交换
  // 写入目标库的 .modelvault/settings.json；仅设置的备份（或旧格式 settings-only）
  // 写入当前激活库。引导字段（激活库/库列表）一律剥离：恢复到任意文件夹
  // 不得劫持本机的库列表（兼容旧格式备份中的完整设置快照）
  let settingsPayload = null
  if (manifest.settings && unzipped['settings.json']) {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(unzipped['settings.json']))
      settingsPayload = normalizeLibrarySettings(parsed)
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
        error: '已取消选择目标文件夹（设置与库数据均未恢复）',
        settingsRestored: false,
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
          '恢复将覆盖其中的标注与封面。现有数据会先备份为 .modelvault.bak-<时间戳>（仅保留最新一份，更早的自动清理），确认无误后可手动删除。',
        buttons: ['取消', '覆盖恢复'],
        defaultId: 0,
        cancelId: 0
      })
      if (choice.response !== 1) {
        return {
          error: '已取消覆盖恢复（设置与库数据均未恢复）',
          settingsRestored: false,
          partial: true
        }
      }
    }
    try {
      const libraryRestored = await restoreLibrary(
        root,
        unzipped,
        settingsPayload,
        skippedCovers
      )
      logger.info(
        `备份已恢复: ${filePath} → ${root}（${libraryRestored.models} 模型 / ${libraryRestored.covers} 封面）`
      )
      return {
        settingsRestored: settingsPayload !== null,
        libraryRestored,
        skipped: libraryRestored.skipped
      }
    } catch (err) {
      logger.warn(`备份恢复失败: ${err.message}`)
      return { error: `库数据恢复失败: ${err.message}`, settingsRestored: false, partial: true }
    }
  }

  // 仅设置的备份（无库数据，含旧格式 settings-only）：写入当前激活库随库生效；
  // 尚无激活库时无处落盘，保持未恢复状态
  if (settingsPayload) {
    const root = getCurrentRoot()
    if (root) {
      await saveLibrarySettings(root, settingsPayload)
      logger.info(`备份中的库设置已写入当前模型库: ${root}`)
      return { settingsRestored: true }
    }
    logger.warn('备份含库设置但当前无激活模型库，设置未恢复')
  }
  return { settingsRestored: false }
}
