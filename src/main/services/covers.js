import { clipboard, dialog } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
import { runWithConcurrency } from '../utils'
import { IMAGE_EXTENSIONS } from './scanner'

/**
 * @typedef {import('electron').BrowserWindow} BrowserWindow
 */
// 直接依赖存储子模块而非聚合门面（services/store.js）：门面的重导出链在
// 模块初始化顺序变化时可能拿到尚未就绪的绑定（A-02 引入 meta-relink 后
// vitest 曾现 getReferencedCovers is not a function）；服务层直连叶子依赖更稳
import { COVERS_DIR, DATA_DIR, getCoversDir, getCurrentRoot, relativizeCover } from './store-paths'
import { getReferencedCovers, wasDataReset } from './store-meta'

/**
 * 封面图片管理：用户在详情页上传的预览图会复制到
 * 模型根目录下的 .modelvault/covers/ 统一保管（关联存储），
 * 避免模型目录被意外修改，且随模型文件夹一起移动。
 */

/** 清理文件名中的非法字符 */
function sanitizeBaseName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'cover'
}

/** 各图片格式的文件头魔数（防伪装扩展名，判定所需字节均在文件头 12 字节内） */
const IMAGE_MAGIC = [
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  // JPEG: FF D8 FF
  (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  // GIF: 'GIF87a' / 'GIF89a'
  (b) => b.toString('latin1', 0, 6) === 'GIF87a' || b.toString('latin1', 0, 6) === 'GIF89a',
  // BMP: 'BM'
  (b) => b.toString('latin1', 0, 2) === 'BM',
  // WEBP: 'RIFF' + 偏移 8-11 'WEBP'
  (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'
]

/**
 * 从已打开的文件句柄读取前 12 字节并匹配图片魔数（读路径统一入口）。
 * @param {import('node:fs/promises').FileHandle} fh 已打开的文件句柄
 * @returns {Promise<boolean>} 文件头匹配已知图片格式时为 true
 */
async function readImageMagic(fh) {
  const buf = Buffer.alloc(12)
  const { bytesRead } = await fh.read(buf, 0, 12, 0)
  if (bytesRead === 0) return false
  // 未读满 12 字节时剩余字节保持 0，不会误匹配任何魔数
  return isImageBuffer(buf)
}

/**
 * 读取文件头校验内容是否为真实图片。
 * 安全作用：importCover 是唯一允许从模型根目录之外复制文件的 IPC 入口，
 * 仅凭扩展名校验可被用于将任意文件复制进封面目录再经 mvimg 协议读出（文件外泄链），
 * 魔数校验将可导入的内容收窄为真实图片。
 * @param {string} filePath 待校验文件路径
 * @returns {Promise<boolean>} 文件头匹配已知图片格式时为 true
 */
export async function hasImageMagic(filePath) {
  const fh = await fs.open(filePath, 'r')
  try {
    return await readImageMagic(fh)
  } finally {
    await fh.close()
  }
}

/**
 * 按文件头魔数校验内存中的字节是否为真实图片（下载内容与文件路径入口共用）。
 * @param {Buffer} buf 文件头字节（12 字节以内即可判定）
 * @returns {boolean}
 */
export function isImageBuffer(buf) {
  if (!buf || buf.length === 0) return false
  return IMAGE_MAGIC.some((test) => test(buf))
}

/**
 * 封面图片大小上限（B5）：对话框/拖拽入口在复制前预检。
 * 扩展名 + 魔数双重校验只保证「是图片」，不限「多大」——合法的大 PNG
 * 可达数 GB，整体拷入 .modelvault 会占满磁盘，并连锁导致元数据原子写
 * 失败（落盘链依赖同一磁盘的可用空间）。
 */
const MAX_COVER_BYTES = 50 * 1024 * 1024

/**
 * 校验并将外部图片文件复制到关联存储的封面目录（对话框选择与拖拽导入共用）。
 * @param {string} source 源图片绝对路径
 * @returns {Promise<any>} 成功 {cover}（绝对路径）；失败 {error}
 */
export async function importCoverFromPath(source) {
  if (typeof source !== 'string' || !source) {
    return { error: '无效的文件路径' }
  }
  const ext = path.extname(source).toLowerCase()
  if (!IMAGE_EXTENSIONS.has(ext)) {
    return { error: '不支持的图片格式，请选择 png/jpg/webp/gif/bmp 图片' }
  }
  try {
    await fs.access(source)
    // 大小预检（B5）：先于内容校验与复制，超限文件零写入
    const stat = await fs.stat(source)
    if (stat.size > MAX_COVER_BYTES) {
      return {
        error: `图片文件过大（上限 ${Math.floor(MAX_COVER_BYTES / 1024 / 1024)}MB），请压缩后再导入`
      }
    }
    // 内容校验：伪装成图片扩展名的非图片文件拒绝导入
    if (!(await hasImageMagic(source))) {
      return { error: '文件内容不是有效的图片，已拒绝导入' }
    }
    await fs.mkdir(getCoversDir(), { recursive: true })
    const baseName = sanitizeBaseName(path.basename(source, ext))
    const fileName = `${Date.now()}-${baseName}${ext}`
    const dest = path.join(getCoversDir(), fileName)
    await fs.copyFile(source, dest)
    logger.info(`封面已保存: ${dest}`)
    return { cover: dest }
  } catch (err) {
    logger.error(`封面保存失败: ${err.message}`)
    return { error: `封面保存失败: ${err.message}` }
  }
}

/**
 * 将内存中的图片字节保存到关联存储的封面目录（Civitai 示例图导入入口）。
 * 扩展名 + 魔数 + 大小三重校验，与 importCoverFromPath 同一安全标准。
 * @param {Buffer} buf 图片字节
 * @param {string} ext 文件扩展名（含点，如 '.jpg'，须在 IMAGE_EXTENSIONS 内）
 * @returns {Promise<any>} 成功 {cover}（绝对路径）；失败 {error}
 */
export async function saveCoverBuffer(buf, ext) {
  const normalizedExt = typeof ext === 'string' ? ext.toLowerCase() : ''
  if (!buf || !Buffer.isBuffer(buf) || buf.length === 0) {
    return { error: '无效的图片内容' }
  }
  if (!IMAGE_EXTENSIONS.has(normalizedExt)) {
    return { error: '不支持的图片格式' }
  }
  if (buf.length > MAX_COVER_BYTES) {
    return {
      error: `图片文件过大（上限 ${Math.floor(MAX_COVER_BYTES / 1024 / 1024)}MB）`
    }
  }
  if (!isImageBuffer(buf)) {
    return { error: '文件内容不是有效的图片，已拒绝导入' }
  }
  try {
    await fs.mkdir(getCoversDir(), { recursive: true })
    const dest = path.join(getCoversDir(), `${Date.now()}-civitai${normalizedExt}`)
    await fs.writeFile(dest, buf)
    logger.info(`Civitai 示例图已保存: ${dest}`)
    return { cover: dest }
  } catch (err) {
    logger.error(`Civitai 示例图保存失败: ${err.message}`)
    return { error: `示例图保存失败: ${err.message}` }
  }
}

/**
 * 弹出图片选择对话框，并将选中的图片复制到关联存储的封面目录。
 * @param {BrowserWindow} parentWin 父窗口
 * @returns {Promise<any>} 成功 {cover}；取消 {canceled:true}；失败 {error}
 */
export async function pickAndSaveCover(parentWin) {
  const result = await dialog.showOpenDialog(parentWin, {
    title: '选择模型预览图',
    properties: ['openFile'],
    filters: [
      { name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }
    ]
  })
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true }
  }
  return importCoverFromPath(result.filePaths[0])
}

/**
 * 校验路径是否为真实图片文件（扩展名 + 文件头魔数）。
 * mvimg 协议与扫描装饰共用此入口：仅凭扩展名会把任意文件当作可展示图片，
 * 与导入链路的魔数标准不一致（伪装扩展名可在协议层读出非图片内容）。
 * 同一句柄内完成常规文件判定与文件头读取，避免额外的 path stat。
 * @param {string} p 待校验文件路径
 * @returns {Promise<boolean>} 真实图片返回 true
 */
export async function isValidImageFile(p) {
  if (typeof p !== 'string' || !p) return false
  if (!IMAGE_EXTENSIONS.has(path.extname(p).toLowerCase())) return false
  let fh = null
  try {
    fh = await fs.open(p, 'r')
    if (!(await fh.stat()).isFile()) return false
    return await readImageMagic(fh)
  } catch {
    return false
  } finally {
    if (fh) await fh.close().catch(() => {})
  }
}

/**
 * 读取系统剪贴板中的图片并保存到关联存储的封面目录。
 * Electron 44 起 clipboard 对齐 W3C Clipboard API：readImage 已移除，
 * 改用 clipboard.read() 返回 ClipboardItem[]，按 MIME 类型取图片 Blob。
 * @returns {Promise<any>} 成功 {cover}（绝对路径）；失败 {error}
 */
export async function saveClipboardImage() {
  try {
    const MIME_EXT = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'image/bmp': '.bmp'
    }
    const items = await clipboard.read()
    const item = items.find((it) => it.types.some((t) => t in MIME_EXT))
    if (!item) {
      return { error: '剪贴板中没有图片内容' }
    }
    const mime = item.types.find((t) => t in MIME_EXT)
    // ClipboardItem.getType 返回 Blob（运行时保证），显式收窄类型供类型检查
    const blob = /** @type {Blob} */ (await item.getType(mime))
    // 大小预检（B5，与 importCoverFromPath 同一阈值）：剪贴板是唯一不经文件
    // 对话框的图片入口，合法的超大位图无上限落盘会占满磁盘并连锁导致原子写失败。
    // 先判 arrayBuffer 字节数，超限零写入（不创建封面目录）
    const arrayBuffer = await blob.arrayBuffer()
    if (arrayBuffer.byteLength > MAX_COVER_BYTES) {
      return {
        error: `图片文件过大（上限 ${Math.floor(MAX_COVER_BYTES / 1024 / 1024)}MB），请压缩后再导入`
      }
    }
    await fs.mkdir(getCoversDir(), { recursive: true })
    const dest = path.join(getCoversDir(), `${Date.now()}-clipboard${MIME_EXT[mime]}`)
    await fs.writeFile(dest, Buffer.from(arrayBuffer))
    logger.info(`剪贴板图片已保存: ${dest}`)
    return { cover: dest }
  } catch (err) {
    logger.error(`剪贴板图片保存失败: ${err.message}`)
    return { error: `剪贴板图片保存失败: ${err.message}` }
  }
}

/**
 * 删除封面物理文件（仅允许删除关联存储封面目录内的文件）。
 * @param {string} absCover 封面绝对路径
 * @returns {Promise<boolean>} 是否删除成功（路径越界或删除失败返回 false）
 */
export async function deleteCoverFile(absCover) {
  if (!absCover || typeof absCover !== 'string') return false
  if (!relativizeCover(absCover)) return false
  try {
    await fs.rm(absCover, { force: true })
    return true
  } catch (err) {
    logger.warn(`封面文件删除失败: ${err.message}`)
    return false
  }
}

/**
 * 清理封面目录中不再被任何元数据引用的孤儿文件
 * （元数据被手动删除/损坏修复后遗留的失效封面）。
 * 元数据因损坏被重置时跳过清理，避免把仍有价值的封面误删。
 */
export async function pruneOrphanCovers() {
  try {
    if (wasDataReset()) {
      logger.warn('元数据曾损坏重置，跳过孤儿封面清理以避免误删')
      return
    }
    const dir = getCoversDir()
    const root = getCurrentRoot()
    const entries = await fs.readdir(dir)
    // 引用快照必须在 readdir 之后取（B4 修复）：封面导入链路中「文件落盘可见」
    // 与「appendCoverMeta 引用登记」处于同一同步块（copyFile 的 await 返回后
    // 紧跟同步登记，无事件循环让位）。若快照取在 readdir 之前，快照与 readdir
    // 之间恰好完成一次上传时，新文件已出现在 entries 中却不被旧快照引用，
    // 会被误判孤儿删掉（用户上传丢失且留下死引用）。快照后移后，删除决策与
    // 最新引用状态处于同一同步段：登记先完成则快照含引用；登记未完成则
    // 文件尚未落盘、不在 entries 中——两种交错均安全
    const referenced = getReferencedCovers()
    // V-02 防御：清理期间根目录被切换时，引用集合属于旧根，继续删除会误伤新根
    if (getCurrentRoot() !== root) {
      logger.warn('孤儿封面清理期间模型库已切换，已跳过本次清理')
      return
    }
    const prefix = `${DATA_DIR}/${COVERS_DIR}/`
    const stale = entries.filter((n) => !referenced.has(`${prefix}${n}`))
    if (stale.length === 0) return
    // OPT-09：孤儿封面批量删除统一有界并发，避免瞬时耗尽文件句柄
    await runWithConcurrency(
      stale,
      (n) => fs.rm(path.join(dir, n), { force: true }),
      16
    )
    logger.info(`已清理 ${stale.length} 个孤儿封面文件`)
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`孤儿封面清理失败: ${err.message}`)
  }
}
