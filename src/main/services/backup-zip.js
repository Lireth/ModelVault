import { createReadStream, createWriteStream } from 'node:fs'
import {
  strToU8,
  Unzip,
  UnzipInflate,
  unzip,
  zip,
  Zip,
  ZipDeflate,
  ZipPassThrough,
} from 'fflate'
import { DATA_FILE } from './store'
import { LIB_COVERS_PREFIX, LIB_PREFIX, safeCoverName } from './backup-format'

/**
 * 备份 zip 流式编解码层（O2 拆分）：
 * 封装 fflate 的异步压缩/解压原语与备份包专用的流式读写，并集中实施
 * 不可信 zip 的解压限制（B-04）。不包含任何备份业务语义——调用方
 * （backup-export / backup-restore）只提供条目与回调。
 *
 * 流式设计动机（A-01/OPT-10）：
 * - 压缩/解压按分片让出事件循环，GB 级备份期间 IPC 与窗口交互不冻结；
 * - 封面逐个流经压缩流/直接落盘回调，内存峰值与封面总量解耦。
 */

/** 备份压缩级别（与历史 zipSync 一致） */
const ZIP_LEVEL = 6

/** 封面总字节上限：fflate 为内存打包，超大封面集会挤占主进程堆，超限引导手动复制 */
export const MAX_COVERS_BYTES = 1024 * 1024 * 1024

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

/**
 * 流式写出备份 zip（OPT-10）：封面逐个读取并直接写入压缩流，不再把所有
 * 封面字节聚合进内存后再整体压缩；内存峰值从「全部封面」降为「单个读块」。
 * JSON 使用 deflate，封面通常已是压缩格式，使用 pass-through 避免无意义 CPU。
 * @param {string} filePath 输出 zip 路径
 * @param {{settingsText: string, storeText?: string, manifestText: string,
 *   covers?: Array<{name: string, path: string}>}} contents
 * @returns {Promise<void>} 写入完成
 */
export function writeBackupZipToFile(filePath, contents) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(filePath)
    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      out.destroy()
      reject(err)
    }
    out.on('error', fail)
    out.on('finish', () => {
      if (settled) return
      settled = true
      resolve()
    })

    const archive = new Zip((err, data, final) => {
      if (err) return fail(err)
      if (data && data.length > 0) out.write(Buffer.from(data))
      if (final) out.end()
    })

    const addText = (name, text) => {
      const file = new ZipDeflate(name, { level: ZIP_LEVEL })
      archive.add(file)
      file.push(strToU8(text), true)
    }

    /** 逐个封面流式写入：只保留当前读块
     * @param {{name: string, path: string}} cover 封面文件（名称 + 绝对路径）
     * @returns {Promise<void>} 写入完成（含流结束）后 resolve
     */
    const addCover = (cover) =>
      new Promise((resolveCover, rejectCover) => {
        const file = new ZipPassThrough(`${LIB_COVERS_PREFIX}${cover.name}`)
        archive.add(file)
        const stream = createReadStream(cover.path, {
          highWaterMark: UNZIP_CHUNK_SIZE,
        })
        // 读块为 Buffer（未设编码）；显式收窄以满足 fflate push 的 Uint8Array 形参
        stream.on('data', (chunk) =>
          file.push(new Uint8Array(/** @type {Buffer} */ (chunk))),
        )
        stream.on('end', () => {
          file.push(new Uint8Array(0), true)
          resolveCover()
        })
        stream.on('error', rejectCover)
      })

    try {
      addText('settings.json', contents.settingsText)
      if (contents.storeText)
        addText(`${LIB_PREFIX}${DATA_FILE}`, contents.storeText)
      ;(async () => {
        for (const cover of contents.covers || []) await addCover(cover)
        // manifest 放在最后：前面的条目均已成功加入后，清单才声明完整内容
        addText('manifest.json', contents.manifestText)
        archive.end()
      })().catch(fail)
    } catch (err) {
      fail(err)
    }
  })
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
 * @param {{manifestOnly?: boolean, stats?: {skippedCovers: number},
 *   coverWriter?: ((name: string, data: Uint8Array) => Promise<void>) | null,
 *   skipCovers?: boolean}} [options]
 *   manifestOnly 仅解出 manifest.json；stats 用于回传被跳过的非法封面条目数；
 *   coverWriter 在封面条目解压完成时直接交给调用方落盘（OPT-10：不在内存
 *   聚合全部封面）；skipCovers 连封面解压也跳过（仅设置恢复场景）
 * @returns {Promise<Record<string, Uint8Array>>} 非封面条目名 → 内容
 */
export async function streamBackupZip(
  filePath,
  {
    manifestOnly = false,
    stats = null,
    coverWriter = null,
    skipCovers = false,
  } = {},
) {
  // 无原型对象：条目名来自不可信 zip，避免任何特殊键影响查找语义
  const entries = Object.create(null)
  const seen = new Set()
  const coverWrites = []
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
    const isCover = file.name.startsWith(LIB_COVERS_PREFIX)
    if (isCover && skipCovers) {
      if (stats) stats.skippedCovers += 1
      return
    }
    const limit = manifestOnly
      ? file.name === 'manifest.json'
        ? MAX_MANIFEST_BYTES
        : 0
      : backupEntryLimit(file.name)
    // 不认识的条目（含路径穿越的封面名）不解压，直接跳过
    if (!limit) {
      if (!manifestOnly && stats && isCover) {
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
      fail(
        new Error(
          `备份条目 ${file.name} 解压后超过 ${formatLimit(limit)} 上限`,
        ),
      )
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
          fail(
            new Error(
              `备份条目 ${file.name} 解压后超过 ${formatLimit(limit)} 上限`,
            ),
          )
          file.terminate?.()
          return
        }
        if (totalBytes > MAX_UNZIP_BYTES) {
          fail(
            new Error(`备份解压总量超过 ${formatLimit(MAX_UNZIP_BYTES)} 上限`),
          )
          file.terminate?.()
          return
        }
        chunks.push(chunk)
      }
      if (!final) return
      const data = concatBytes(chunks, received)
      if (isCover && coverWriter) {
        // 封面在解压完成时立即交给调用方落盘；chunks 引用随条目结束释放，
        // 不会像旧实现那样把全部封面留在 entries 中直到恢复结束
        const name = safeCoverName(file.name)
        coverWrites.push(
          Promise.resolve()
            .then(() => coverWriter(name, data))
            .catch((writeErr) => {
              fail(writeErr)
            }),
        )
        return
      }
      entries[file.name] = data
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
    // 结束流：触发剩余条目收尾（空条目在 final 时写入 entries/封面落盘）。
    // 即使中途已记录失败，也先等待已开始的封面写盘结束，再由调用方清理临时目录，
    // 避免删除目录时仍有写入在途。
    if (!failure) unzipper.push(new Uint8Array(0), true)
    if (coverWrites.length > 0) await Promise.all(coverWrites)
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
export async function readBackupManifest(filePath) {
  const entries = await streamBackupZip(filePath, { manifestOnly: true })
  return entries['manifest.json'] || null
}

/**
 * 第二遍：解出恢复所需的设置/元数据/封面（带逐条与总量上限）。
 * @param {string} filePath zip 文件路径
 * @returns {Promise<{files: Record<string, Uint8Array>, skippedCovers: number}>}
 */
export async function unzipBackupEntries(filePath, options = {}) {
  const stats = { skippedCovers: 0 }
  const files = await streamBackupZip(filePath, {
    stats,
    coverWriter: options.coverWriter || null,
    skipCovers: options.skipCovers === true,
  })
  return { files, skippedCovers: stats.skippedCovers }
}
