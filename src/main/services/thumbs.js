import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
// 直连存储叶子模块而非聚合门面（与 covers.js 同理：避免门面重导出链
// 在模块初始化顺序变化时拿到未就绪绑定）
import { getCurrentRoot } from './store-paths'
import { runWithConcurrency } from '../utils'
import { renderThumbFromPath } from './thumb-renderer'
import { toImageUrl } from '../protocol'

/**
 * 封面缩略图缓存：
 * - 网格卡片只需小图，直接加载原图（大分辨率 WebP/PNG）会带来
 *   高内存占用与解码卡顿；此处将封面缩放为固定宽度的 JPEG 缓存；
 * - 缩略图保存在模型根目录的 .modelvault/thumbs/ 内（关联存储，
 *   随模型文件夹一起移动），文件名为「路径哈希-源图修改时间」，
 *   源图变化自动失效并重新生成；
 * - 生成失败（不支持的格式、损坏文件等）时回退使用原图，不影响功能；
 * - 解码/缩放/编码经隐藏渲染进程执行（thumb-renderer，P2 主进程非阻塞
 *   改造），主进程仅承担 stat/读盘/落盘。
 */

const THUMBS_DIR = 'thumbs'
/** 缩略图目标宽度（px），兼顾网格清晰度与详情页预览 */
const THUMB_WIDTH = 640
/** 仅当原图宽度超过该值时才生成缩略图，小图直接使用原图 */
const MIN_SOURCE_WIDTH = 720
const JPEG_QUALITY = 82
/**
 * 源图字节数上限（B2）：超过则跳过缩略图生成（回退原图显示）。
 * generateThumb 需整图读入内存再传输渲染进程解码，批量处理数十 MB 的
 * 超大型 PNG 时瞬时内存峰值可达数百 MB；这类超大图直接用原图。
 */
const MAX_SOURCE_BYTES = 64 * 1024 * 1024
/**
 * 后台生成并发数（O-6）：generateThumb 单图瞬时内存 = 源图字节 + 解码位图，
 * 并发 4 时峰值约为批处理模型（16）的 1/4，且缩略图是后台锦上添花任务，
 * 低并发不构成体验瓶颈（网格卡片在生成完成前回退原图）。
 */
const THUMB_GEN_CONCURRENCY = 4

/**
 * 命中结果 TTL 缓存（PERF-5，与 protocol.js OP-04 同款手法）：
 * 缩略图文件名内嵌源图 mtime，命中判定链必须先 stat 源图（拿 mtime 算文件名）
 * 再 access 缓存文件——两次系统调用无法合并为一次。改为把「stat + access」的
 * 结论缓存短 TTL：扫描装饰对同一封面在重复扫描/重复装饰中反复走该链路，
 * 命中缓存在 TTL 内零系统调用直接返回。
 * 一致性边界：TTL 内源图被替换会短暂返回旧 mtime 的缩略图路径（与既有
 * 「按 mtime 失效」语义的偏差窗口 ≤ TTL），由下次扫描的 pruneThumbs 纠正；
 * 未命中同样缓存（免系统调用重新登记后台任务），生成成功后就地升级为命中。
 */
const THUMB_HIT_TTL_MS = 30_000
const THUMB_HIT_CACHE_MAX = 4096
/** @type {Map<string, {hit: boolean, thumbPath: string, mtimeMs: number, expiresAt: number}>} */
const hitCache = new Map()

/** 写入命中缓存（key 为源图小写路径；超限按插入序淘汰最旧） */
function putThumbHitCache(key, entry) {
  if (hitCache.size >= THUMB_HIT_CACHE_MAX) {
    hitCache.delete(hitCache.keys().next().value)
  }
  hitCache.set(key, { ...entry, expiresAt: Date.now() + THUMB_HIT_TTL_MS })
}

/** 缩略图缓存目录（位于模型根目录内） */
function getThumbsDir() {
  return path.join(getCurrentRoot(), '.modelvault', THUMBS_DIR)
}

/** 缩略图文件名：源图路径哈希（小写化，兼容 Windows 大小写）+ mtime */
function thumbFileName(absCover, mtimeMs) {
  const hash = crypto
    .createHash('md5')
    .update(absCover.toLowerCase())
    .digest('hex')
    .slice(0, 16)
  return `${hash}-${Math.round(mtimeMs)}.jpg`
}

/**
 * 生成缩略图核心逻辑：读取源图、经隐藏渲染进程缩放编码并写入缓存文件。
 * 解码/缩放/JPEG 编码运行在独立渲染进程（P2 改造）：此前 nativeImage 的
 * createFromBuffer/resize/toJPEG 为同步 API，大封面图会阻塞主进程事件循环
 * （B5），扫描后台补齐缩略图期间所有 IPC 处理会随之停摆。
 * @returns {Promise<string>} 成功返回缩略图路径；源图过小/损坏返回 ''（回退原图）
 */
async function generateThumb(absCover, thumbPath) {
  // 大文件跳过（B2）：先 stat 校验字节数，避免超大图整读入内存
  const sourceStat = await fs.stat(absCover)
  if (sourceStat.size > MAX_SOURCE_BYTES) return ''
  // OP-03：只传源图地址，由隐藏渲染进程经 mvimg:// 自行读取。主进程不再
  // 读入整图并经 IPC 结构化克隆（单图可达 64MB，4 并发时峰值成倍放大）。
  const result = await renderThumbFromPath(toImageUrl(absCover), {
    thumbWidth: THUMB_WIDTH,
    minSourceWidth: MIN_SOURCE_WIDTH,
    quality: JPEG_QUALITY / 100,
  })
  if ('small' in result) return ''
  await fs.mkdir(getThumbsDir(), { recursive: true })
  await fs.writeFile(thumbPath, result.jpeg)
  return thumbPath
}

/* ---------------- 后台延迟生成（扫描装饰阶段专用） ---------------- */

/** 后台延迟生成队列：key 为缩略图路径，避免同一源图重复登记 */
const deferredJobs = new Map()

/**
 * 请求封面缩略图（延迟生成模式，供扫描装饰阶段使用）：
 * - 缓存命中：立即返回缩略图路径；
 * - 缓存未命中：登记后台生成任务并返回 ''（调用方回退原图，
 *   扫描响应不再被大量缩略图生成阻塞，完成后经 drain 通知更新）。
 * @param {string} absCover 封面图片绝对路径
 * @returns {Promise<string>} 缩略图绝对路径，未命中/失败返回 ''
 */
export async function getThumbPathDeferred(absCover) {
  if (!absCover || typeof absCover !== 'string' || !getCurrentRoot()) return ''
  const key = absCover.toLowerCase()
  const cached = hitCache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.hit) return cached.thumbPath
    // 未命中缓存：免系统调用直接重新登记后台任务（生成成功后缓存升级为命中）
    deferredJobs.set(cached.thumbPath, {
      absCover,
      mtimeMs: cached.mtimeMs,
    })
    return ''
  }
  try {
    const stat = await fs.stat(absCover)
    const thumbPath = path.join(
      getThumbsDir(),
      thumbFileName(absCover, stat.mtimeMs),
    )
    let hit = false
    try {
      await fs.access(thumbPath)
      hit = true
    } catch {
      /* 缓存未命中，登记后台生成 */
    }
    putThumbHitCache(key, { hit, thumbPath, mtimeMs: stat.mtimeMs })
    if (hit) return thumbPath
    deferredJobs.set(thumbPath, { absCover, mtimeMs: stat.mtimeMs })
    return ''
  } catch (err) {
    // 源图 stat 失败（被删/离线）不缓存：可能是瞬时状态，下轮请求重新探测
    logger.warn(`缩略图预检失败（回退原图）: ${err.message}`)
    return ''
  }
}

/**
 * 清空延迟生成队列（切换模型根目录时调用）。
 * 残留的旧根条目会被下一轮 drain 以「新根」的 thumbs 目录生成缩略图，
 * 造成跨根目录写文件并向渲染进程推送无效更新（C5，与 B10 同类）。
 */
export function clearDeferredJobs() {
  deferredJobs.clear()
  // PERF-5：命中缓存一并清空——切库后 thumbPath 依赖当前根目录，
  // 虽然缓存 key 含绝对路径本就跨根安全，清空可避免旧根条目占位
  hitCache.clear()
}

/**
 * 依次处理后台延迟生成队列（O-6：固定并发 worker 池，替代「批内并发 16、
 * 批间串行」的批处理模型）：
 * - 内存峰值有界：generateThumb 需整图读入内存解码（上限 64MB/张），并发
 *   峰值 = 并发数 × 单图峰值；此前批内 16 张大图同时解码，瞬时内存可达
 *   数百 MB 并挤占主进程事件循环；
 * - 消除批尾延迟：批处理模型需等整批（含最慢一张）完成才进入下一批，
 *   单张慢图拖住 15 张已完成任务的推送；worker 池流式取任务，完成即回调。
 * 每成功生成一个缩略图，调用 onGenerated(源图路径, 缩略图路径)
 * 通知调用方（用于推送渲染进程更新卡片封面）。
 * @param {(absCover: string, thumbPath: string) => void} onGenerated 生成成功回调
 * @param {number} [concurrency] 并发 worker 数
 */
export async function drainDeferredThumbs(
  onGenerated,
  concurrency = THUMB_GEN_CONCURRENCY,
) {
  const jobs = [...deferredJobs.values()]
  deferredJobs.clear()
  await runWithConcurrency(
    jobs,
    async ({ absCover, mtimeMs }) => {
      const thumbPath = path.join(
        getThumbsDir(),
        thumbFileName(absCover, mtimeMs),
      )
      try {
        const generated = await generateThumb(absCover, thumbPath)
        if (generated) {
          // PERF-5：生成成功，命中缓存由未命中就地升级（下轮请求零系统调用）
          putThumbHitCache(absCover.toLowerCase(), {
            hit: true,
            thumbPath,
            mtimeMs,
          })
          onGenerated(absCover, generated)
        }
      } catch (err) {
        logger.warn(`后台缩略图生成失败（回退原图）: ${err.message}`)
      }
    },
    concurrency,
  )
}

/**
 * 清理缩略图目录中不在保留名单内的旧文件
 * （源图被修改/删除、封面被移除后遗留的失效缓存）。
 * @param {Set<string>} keepNames 本次扫描中仍在使用的缩略图文件名
 */
export async function pruneThumbs(keepNames) {
  try {
    const root = getCurrentRoot()
    const dir = getThumbsDir()
    const entries = await fs.readdir(dir)
    // V-02 防御：清理期间根目录被切换时，keepNames 属于旧根，继续删除会误伤新根
    if (getCurrentRoot() !== root) {
      logger.warn('缩略图清理期间模型库已切换，已跳过本次清理')
      return
    }
    const stale = entries.filter((n) => !keepNames.has(n))
    if (stale.length === 0) return
    // OPT-09：失效缩略图可能数千个，统一有界并发，避免瞬时耗尽文件句柄
    await runWithConcurrency(
      stale,
      (n) => fs.rm(path.join(dir, n), { force: true }),
      16,
    )
    logger.info(`已清理 ${stale.length} 个失效缩略图`)
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`缩略图清理失败: ${err.message}`)
  }
}

/**
 * 立即删除指定源图对应的全部缩略图（按路径哈希前缀匹配，覆盖 mtime 变体）。
 * 供「移除全部示例图」链路同步清理失效缓存，无需等待下次全量扫描的
 * pruneThumbs 兜底；仅命中传入源图的缩略图，sidecar 预览图等仍在使用的
 * 缩略图不受影响。
 * @param {string[]} absCovers 已删除的封面源图绝对路径
 */
export async function removeThumbsForSources(absCovers) {
  const list = (Array.isArray(absCovers) ? absCovers : []).filter(
    (p) => typeof p === 'string' && p,
  )
  if (list.length === 0 || !getCurrentRoot()) return
  try {
    const dir = getThumbsDir()
    const prefixes = new Set(
      list.map((p) =>
        crypto
          .createHash('md5')
          .update(p.toLowerCase())
          .digest('hex')
          .slice(0, 16),
      ),
    )
    const entries = await fs.readdir(dir)
    // 缩略图文件名为「<16 位路径哈希>-<mtime>.jpg」，前缀匹配即命中同一源图
    const stale = entries.filter((n) => prefixes.has(n.slice(0, 16)))
    if (stale.length === 0) return
    await runWithConcurrency(
      stale,
      (n) => fs.rm(path.join(dir, n), { force: true }),
      16,
    )
    logger.info(`已清理 ${stale.length} 个移除封面对应的缩略图`)
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`缩略图清理失败: ${err.message}`)
  }
}
