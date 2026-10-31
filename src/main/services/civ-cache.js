import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
// 直连存储叶子模块而非聚合门面（与 thumbs.js/covers.js 同理：避免门面
// 重导出链在模块初始化顺序变化时拿到未就绪绑定）
import { getCurrentRoot } from './store-paths'
import { ensureLibrarySubdir } from './store-meta-persist'

/**
 * civimg:// 远程图磁盘缓存（O-5）：
 * Civitai 示例图经主进程代理（civimg://remote/<url>）展示于详情页画廊与
 * 批量导入选择器，同一张图会被反复浏览。此前每次请求都走 net.fetch，
 * 仅靠响应头的 HTTP 缓存（重启即失效且自定义协议下并不可靠）——离线
 * 环境下已浏览过的图直接不可见。此处增加持久磁盘缓存：
 * - 存放于当前模型库 .modelvault/civcache/（与 thumbs/ 同范式：库内
 *   机器可再生产物。缓存键为全局 URL，跨库浏览同一张图会各自缓存一份，
   接受该冗余以换取「缓存随库、位置可预期」的一致性）；
 * - 文件名为 URL 的 SHA256（+URL 推断的扩展名）：URL 即缓存键，无元数据；
 * - 写入为临时文件 + rename 原子替换：断电/崩溃不产生半写损坏文件；
 * - 命中校验由调用方（protocol.js）做图片魔数检查，损坏条目调用方删除
 *   后重新拉取，缓存自身不做信任假设；
 * - 容量上限 LRU（按 mtime 淘汰）：写入后异步清理，超限删至目标水位；
 * - 全部操作 best-effort：任何失败只记日志，绝不影响图片本身的返回。
 * 备份排除：backup.js 按白名单打包（settings/store/covers），civcache
 * 天然不入备份；恢复时 .modelvault 整体交换会清掉缓存（与 thumbs 同一
 * 既有行为），随浏览自动重建。
 */

const CACHE_DIR_NAME = 'civcache'
/** 缓存总容量上限：触发清理的水位 */
const MAX_CACHE_BYTES = 256 * 1024 * 1024
/** 清理后的目标水位（留出抖动空间，避免每次写入都触发清理） */
const EVICT_TARGET_BYTES = 192 * 1024 * 1024
/** 单文件缓存上限：超过则不入缓存（超大图直接流式返回） */
const MAX_ENTRY_BYTES = 32 * 1024 * 1024

/**
 * 缓存目录（当前模型根目录/.modelvault/civcache）。
 * 未选择模型库时返回 null（缓存不可用：跳过读写，代理链路不受影响）。
 */
function getCacheDir() {
  const root = getCurrentRoot()
  if (!root) return null
  return path.join(root, '.modelvault', CACHE_DIR_NAME)
}

/** 缓存文件名：URL SHA256 + 由 URL 推断的扩展名（读取方不依赖扩展名） */
function cacheFileName(url) {
  const hash = createHash('sha256').update(url).digest('hex')
  const m = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(url)
  return `${hash}${m ? `.${m[1].toLowerCase()}` : '.img'}`
}

/** 由缓存文件扩展名映射响应 Content-Type（渲染层 <img> 实际按内容嗅探） */
const EXT_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
}

/** 缓存条目的响应 Content-Type（未知扩展名留空，交由浏览器嗅探） */
export function civCacheContentType(url) {
  return EXT_MIME[path.extname(cacheFileName(url))] || ''
}

/**
 * 读取 URL 对应的缓存内容；未命中返回 null。
 * 读失败（不存在/IO 错误）一律视为未命中，由调用方走网络拉取。
 * @param {string} url 远程图片 https URL
 * @returns {Promise<Buffer|null>}
 */
export async function getCivImageFromCache(url) {
  const dir = getCacheDir()
  if (!dir) return null
  try {
    return await fs.readFile(path.join(dir, cacheFileName(url)))
  } catch {
    return null
  }
}

/**
 * 写入 URL 对应的缓存条目（原子替换），并异步触发容量清理。
 * @param {string} url 远程图片 https URL
 * @param {Buffer} buf 图片完整字节
 * @returns {Promise<void>} 写入失败仅记日志（缓存是 best-effort）
 */
export async function saveCivImageCache(url, buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0 || buf.length > MAX_ENTRY_BYTES)
    return
  const dir = getCacheDir()
  if (!dir) return
  const file = path.join(dir, cacheFileName(url))
  try {
    // OPT-14：库根离线时跳过缓存写入（此前的递归 mkdir 会把根目录树重建到
    // 失效路径）——缓存是 best-effort，下次请求重新回源
    if (!(await ensureLibrarySubdir(path.dirname(file)))) return
    try {
      await fs.mkdir(path.dirname(file))
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    // 临时文件 + rename：进程内单调序号防同 URL 并发写入互相截断
    const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`
    await fs.writeFile(tmp, buf)
    await fs.rename(tmp, file).catch(async () => {
      // Windows 并发替换竞争：目标被占用时放弃本次写入（下次请求重新拉取）
      await fs.rm(tmp, { force: true }).catch(() => {})
    })
  } catch (err) {
    logger.warn(`civimg 缓存写入失败（不影响返回）: ${err.message}`)
    return
  }
  pruneCivImageCache().catch(() => {})
}

/** 删除 URL 对应的缓存条目（命中校验失败时的自愈入口） */
export async function removeCivImageCache(url) {
  const dir = getCacheDir()
  if (!dir) return
  await fs
    .rm(path.join(dir, cacheFileName(url)), { force: true })
    .catch(() => {})
}

/** 缓存条目文件路径（测试定位用）；未选择模型库时返回空串 */
export function getCivImageCachePath(url) {
  const dir = getCacheDir()
  return dir ? path.join(dir, cacheFileName(url)) : ''
}

let tmpSeq = 0
/** 清理进行中标志（单飞：并发写入触发的清理合并为一次） */
let pruning = false

/**
 * 容量清理：总大小超上限时按 mtime 从旧到新删除至目标水位。
 * 目录规模为缓存条目数（上限约数百条），整表 stat 成本可接受；
 * 任何失败静默忽略——清理不达标只影响磁盘占用，不影响功能。
 */
async function pruneCivImageCache() {
  if (pruning) return
  pruning = true
  try {
    const dir = getCacheDir()
    if (!dir) return
    const names = await fs.readdir(dir).catch(() => [])
    let total = 0
    const files = []
    for (const name of names) {
      const p = path.join(dir, name)
      const st = await fs.stat(p).catch(() => null)
      if (st?.isFile()) {
        total += st.size
        files.push({ p, size: st.size, mtimeMs: st.mtimeMs })
      }
    }
    if (total <= MAX_CACHE_BYTES) return
    files.sort((a, b) => a.mtimeMs - b.mtimeMs)
    let removed = 0
    for (const f of files) {
      if (total <= EVICT_TARGET_BYTES) break
      await fs.rm(f.p, { force: true }).catch(() => {})
      total -= f.size
      removed += 1
    }
    if (removed > 0) {
      logger.info(
        `civimg 缓存清理完成：删除 ${removed} 个最旧条目（超 ${MAX_CACHE_BYTES / 1024 / 1024}MB 水位）`,
      )
    }
  } finally {
    pruning = false
  }
}
