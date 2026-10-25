import { protocol, net, app } from 'electron'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import logger from './logger'
import { relativeWithin } from './utils'
import { isValidImageFile, isImageBuffer } from './services/covers'
import { getCurrentRoot, getSettings } from './services/store'
import {
  CIVITAI_DISABLED_ERROR,
  isAllowedCivitaiImageUrl,
  fetchCivitaiImage,
  fetchCivitaiVideo,
  readCivitaiImageBody,
} from './services/civitai'
import {
  civCacheContentType,
  getCivImageFromCache,
  removeCivImageCache,
  saveCivImageCache,
} from './services/civ-cache'

/**
 * 自定义图片协议 mvimg://
 * 用于在渲染进程中安全显示本地磁盘图片（封面/预览图），
 * 兼容开发（http://localhost）与生产（file://）两种页面来源，
 * 且无需放宽 CSP 或开启 Node 能力。
 * 用法：mvimg://local/<encodeURIComponent(绝对路径)>
 *
 * 自定义图片协议 civimg://
 * 用于在渲染进程中显示 Civitai 示例图（远程 CDN 图片）：渲染进程直连
 * image.civitai.com 受 CSP/系统代理/Cloudflare 反爬等多重因素影响易失败，
 * 统一经主进程 net.fetch 代理（与识别/下载同一网络栈），并强制
 * 「https + 官方 CDN 域名白名单」校验。用法：
 * civimg://remote/<encodeURIComponent(图片 https URL)>
 */

const SCHEME = 'mvimg'
const CIV_SCHEME = 'civimg'

/** 必须在 app ready 之前调用 */
export function registerImageScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
    {
      scheme: CIV_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ])
}

/**
 * 放行目录 realpath 缓存（B1）：首页网格数百张封面时，每张图片请求
 * 省去 2 次 realpath 系统调用。键为目录字面量，容量有界；
 * 根目录切换时整体失效（见 isAllowedPath 中的 lastSeenRoot 检查）。
 */
const realpathCache = new Map()
const REALPATH_CACHE_MAX = 8
/**
 * 不可变资产（.modelvault/covers|thumbs）的单文件请求缓存（OP-04）：
 * 每张卡片图片此前都要 realpath + stat 两次系统调用；大库滚动时放大明显。
 * 这两类文件由应用生成且文件名含时间戳/mtime（内容不可变），可短 TTL 缓存
 * realpath 与「存在且为图片」的校验结果。TTL 同时限定异常场景（文件被外部
 * 替换为 junction/非图片）的暴露窗口；根目录切换时整体清空。
 */
const immutableAssetCache = new Map()
const IMMUTABLE_ASSET_CACHE_MAX = 512
const IMMUTABLE_ASSET_TTL_MS = 30_000
/** 上一次所见根目录（检测切换以失效 realpath 缓存） */
let lastSeenRoot

/** realpath 带缓存：不存在/不可达的目录缓存为 null（放行时跳过） */
async function realpathCached(dir) {
  let real = realpathCache.get(dir)
  if (real === undefined) {
    try {
      real = await fs.promises.realpath(dir)
    } catch {
      real = null
    }
    if (realpathCache.size >= REALPATH_CACHE_MAX) {
      realpathCache.delete(realpathCache.keys().next().value)
    }
    realpathCache.set(dir, real)
  }
  return real
}

/**
 * 校验请求的真实路径是否允许访问：仅限当前模型根目录（含关联存储）与旧版封面目录。
 * 入参必须是已 fs.realpath 解析后的路径：根目录内的符号链接/junction
 * 若指向根目录外，字面前缀校验可被绕过，必须以解析后的真实路径判断（B8）。
 * 归属判定（含 Windows 大小写不敏感兜底）统一收敛在 utils.relativeWithin（O-1）。
 */
async function isAllowedPath(realPath) {
  const root = getCurrentRoot()
  // 根目录切换时缓存整体失效：旧根的 realpath 不再适用于新根的归属判断
  if (root !== lastSeenRoot) {
    realpathCache.clear()
    // OP-04：文件级缓存同样绑定根目录归属，切根必须整体失效
    immutableAssetCache.clear()
    lastSeenRoot = root
  }
  const allowed = []
  if (root) allowed.push(path.normalize(root))
  // 旧版全局封面目录（迁移前的历史数据兼容）
  allowed.push(path.join(app.getPath('userData'), 'covers'))
  for (const dir of allowed) {
    const resolved = await realpathCached(dir)
    if (!resolved) continue
    if (relativeWithin(realPath, resolved) !== null) return true
  }
  return false
}

/**
 * 判断资源是否为「内容不可变」资产（A-05）：
 * - .modelvault/covers/：用户导入封面以「时间戳-文件名」命名，删除即失效，
 *   同名不会被新内容复用；
 * - .modelvault/thumbs/：缩略图文件名含源图路径哈希与 mtime，源图变化必换新名。
 * 两类 URL 本身即内容指纹，可安全下发 immutable 长缓存。
 * 模型目录内的 sidecar 同名预览图（路径不变、内容可被外部替换）不在此列，
 * 须按 no-cache 重验证，避免替换同名图后展示陈旧缓存。
 * @param {string} realPath 已 realpath 归一的绝对路径
 * @returns {boolean}
 */
function isImmutableAssetPath(realPath) {
  if (typeof realPath !== 'string' || !realPath) return false
  const normalized = realPath.replace(/\\/g, '/').toLowerCase()
  return (
    normalized.includes('/.modelvault/covers/') ||
    normalized.includes('/.modelvault/thumbs/')
  )
}

/**
 * 为上游 file:// 响应附加缓存策略头（A-05），保留响应体与其余响应头。
 * 不可变资产长缓存一年（省重复读盘/解码）；其余（sidecar 同名图）no-cache，
 * 每次使用前重验证，防止用户替换同名预览图后看到旧图。
 */
function withCacheHeaders(upstream, immutable) {
  const headers = new Headers(upstream.headers || undefined)
  headers.set(
    'Cache-Control',
    immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  )
  return new Response(upstream.body, {
    status: upstream.status || 200,
    statusText: upstream.statusText,
    headers,
  })
}

/**
 * civimg 代理允许透传给渲染进程的上游响应头白名单（媒体语义所需子集）。
 * 上游（Civitai CDN）响应头不整体透传：Set-Cookie 可能落入 civimg 来源的
 * cookie 存储（standard+secure scheme 下的行为随 Electron 版本演进），
 * Content-Disposition/X-* 等与媒体展示无关——代理响应面确定化。
 * Cache-Control 由本方缓存策略另行下发，不从上游继承。
 */
const PROXY_SAFE_RESPONSE_HEADERS = [
  'Content-Type',
  'Accept-Ranges',
  'Content-Range',
  'ETag',
  'Last-Modified',
]

/**
 * 按白名单重建代理响应头。
 * @param {Response} upstream 上游响应
 * @param {string[]} [extra] 额外放行的头（流式视频需 Content-Length 配合
 *   Content-Range 支撑拖动播放）
 * @returns {Headers} 白名单重建后的新 Headers
 */
function proxyMediaHeaders(upstream, extra = []) {
  const source = upstream.headers || new Headers()
  const headers = new Headers()
  for (const name of [...PROXY_SAFE_RESPONSE_HEADERS, ...extra]) {
    const value = source.get(name)
    if (value) headers.set(name, value)
  }
  return headers
}

/** 在 app ready 之后调用，注册协议处理器（mvimg 本地图 + civimg 远程代理） */
export function registerImageProtocolHandler() {
  registerMvimgHandler()
  registerCivimgHandler()
  logger.info(`自定义协议 ${SCHEME}:// 与 ${CIV_SCHEME}:// 注册完成`)
}

/** mvimg:// 处理器：本地受控图片 */
function registerMvimgHandler() {
  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      if (url.host !== 'local') {
        return new Response('Bad Request', { status: 400 })
      }
      // pathname 为 encodeURIComponent 后的绝对路径
      // 畸形编码序列按 400 语义返回（A10），而非落入外层 500
      let filePath
      try {
        filePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      } catch {
        return new Response('Bad Request', { status: 400 })
      }
      // 先解析符号链接/junction 得到真实路径，再校验归属（B8）。
      // OP-04：不可变资产命中短 TTL 缓存时跳过 realpath 与 stat（每张图片
      // 至少两次系统调用）；sidecar 同名图内容可被外部替换，不进入缓存。
      const immutableCandidate = isImmutableAssetPath(filePath)
      const cacheKey = immutableCandidate ? filePath.toLowerCase() : ''
      let realPath = ''
      let cacheHit = false
      if (cacheKey) {
        const cached = immutableAssetCache.get(cacheKey)
        if (cached && cached.expiresAt > Date.now()) {
          realPath = cached.realPath
          cacheHit = true
        }
      }
      if (!realPath) {
        try {
          realPath = await fs.promises.realpath(filePath)
        } catch {
          return new Response('Not Found', { status: 404 })
        }
      }
      if (!(await isAllowedPath(realPath))) {
        logger.warn(`mvimg 协议拒绝访问路径: ${filePath}`)
        return new Response('Forbidden', { status: 403 })
      }
      if (!cacheHit && !(await isValidImageFile(realPath))) {
        return new Response('Not Found', { status: 404 })
      }
      if (cacheKey && !cacheHit) {
        if (immutableAssetCache.size >= IMMUTABLE_ASSET_CACHE_MAX) {
          immutableAssetCache.delete(immutableAssetCache.keys().next().value)
        }
        immutableAssetCache.set(cacheKey, {
          realPath,
          expiresAt: Date.now() + IMMUTABLE_ASSET_TTL_MS,
        })
      }
      const upstream = await net.fetch(pathToFileURL(realPath).toString())
      // 按资产命名稳定性下发缓存策略（A-05）：关联存储封面/缩略图不可变，
      // sidecar 同名图 no-cache
      return withCacheHeaders(upstream, isImmutableAssetPath(realPath))
    } catch (err) {
      logger.error(`mvimg 协议处理失败: ${err.message}`)
      return new Response('Internal Error', { status: 500 })
    }
  })
}

/**
 * civimg:// 处理器：Civitai 示例图远程代理（含持久磁盘缓存，O-5）。
 * 渲染进程 <img> 请求经主进程处理：命中磁盘缓存（civ-cache，URL 哈希命名）
 * 且内容通过图片魔数校验时直接由磁盘服务（离线可回看、重复浏览零网络）；
 * 未命中经 net.fetch 拉取（与识别/下载同一网络栈，自动继承系统代理），
 * 目标 URL 强制命中 CDN 域名白名单，成功拉取的图片内容回写磁盘缓存。
 *
 * OPT-05 回源收敛：
 * - 并发上限——civitai.js 的请求节流只覆盖 API 域，图片/视频 CDN 不受限；
 *   被入侵的渲染进程可一次塞数百个 civimg URL，数百路并发 fetch + 磁盘写
 *   会打满主进程与磁盘。统一以 FIFO 信号量收口（图片全程持槽，视频仅在
 *   头部阶段持槽——body 流式回传由渲染进程驱动，不占并发额度）。
 * - 在途去重——同 URL 并发请求（画廊与批量导入选择器同屏渲染同一图、
 *   快速滚动）共享同一次上游拉取与磁盘缓存写入。
 */

/** civimg 回源并发上限（OPT-05） */
const CIVIMG_MAX_CONCURRENT = 6
/** 在途并发计数与 FIFO 等待队列 */
let civimgActive = 0
const civimgWaitQueue = []

/**
 * 获取一个 civimg 回源槽位（FIFO 公平排队）。
 * @returns {Promise<() => void>} 释放函数（重复调用安全）
 */
function acquireCivimgSlot() {
  return new Promise((resolve) => {
    const run = () => {
      civimgActive += 1
      let released = false
      resolve(() => {
        if (released) return
        released = true
        civimgActive -= 1
        civimgWaitQueue.shift()?.()
      })
    }
    if (civimgActive < CIVIMG_MAX_CONCURRENT) run()
    else civimgWaitQueue.push(run)
  })
}

/** 图片回源在途表：URL → 共享拉取 Promise（同 URL 只回源一次） */
const civimgInflight = new Map()

/**
 * 图片共享回源（OPT-05 去重 + 并发约束）：
 * 图片路径整体读入 Buffer，各调用方从共享结果自建 Response——上游拉取、
 * 体积上限校验与磁盘缓存写入对同 URL 并发请求只发生一次；失败同样共享
 * （缓存未写入，下一个请求自然重新回源）。
 * @param {string} target 已通过白名单校验的图片 URL
 * @returns {Promise<{buf?: Buffer, upstream?: Response, errorStatus?: number}>}
 */
function fetchCivImageShared(target) {
  const existing = civimgInflight.get(target)
  if (existing) return existing
  const promise = (async () => {
    const release = await acquireCivimgSlot()
    try {
      const upstream = await fetchCivitaiImage(target)
      if (!upstream.ok) {
        logger.warn(
          `civimg 上游响应异常（HTTP ${upstream.status}）: ${target.slice(0, 200)}`,
        )
        return { errorStatus: 502 }
      }
      // 整体读入后回写磁盘缓存（best-effort，失败不影响返回）；仅缓存
      // 真实图片内容——魔数不符的字节（上游异常页等）不入缓存。
      // 读取受 50MB 上限约束（V-06），避免异常大响应打爆主进程堆
      let buf
      try {
        buf = await readCivitaiImageBody(upstream)
      } catch (err) {
        logger.warn(`civimg 上游内容读取失败: ${err.message}`)
        return { errorStatus: 502 }
      }
      if (isImageBuffer(buf)) {
        await saveCivImageCache(target, buf)
      }
      return { buf, upstream }
    } finally {
      release()
    }
  })()
  civimgInflight.set(target, promise)
  // 清理链自身吞掉拒绝（网络层拒绝由各 await 方的处理层 catch 兜底），
  // 防止后台清理派生的 promise 成为 unhandledRejection
  promise
    .finally(() => {
      if (civimgInflight.get(target) === promise) civimgInflight.delete(target)
    })
    .catch(() => {})
  return promise
}

function registerCivimgHandler() {
  protocol.handle(CIV_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      if (url.host !== 'remote') {
        return new Response('Bad Request', { status: 400 })
      }
      // 隐私门禁（OPT-03）：设置关闭时连磁盘缓存也不服务，统一下线 Civitai 内容
      if (getSettings().civitaiEnabled === false) {
        logger.warn(`civimg 协议拒绝：${CIVITAI_DISABLED_ERROR}`)
        return new Response('Forbidden', { status: 403 })
      }
      let target
      try {
        target = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      } catch {
        return new Response('Bad Request', { status: 400 })
      }
      if (!isAllowedCivitaiImageUrl(target)) {
        logger.warn(`civimg 协议拒绝非白名单图片地址: ${target.slice(0, 200)}`)
        return new Response('Forbidden', { status: 403 })
      }
      // FN-02：示例视频走流式代理（Range 透传），不进入图片磁盘缓存
      if (isCivitaiVideoUrl(target)) {
        return proxyCivitaiVideo(target, request, acquireCivimgSlot)
      }
      // 缓存命中路径：魔数校验失败（半写/损坏/被篡改）时删除条目自愈并回源
      const cached = await getCivImageFromCache(target)
      if (cached) {
        if (isImageBuffer(cached)) {
          const headers = new Headers()
          const mime = civCacheContentType(target)
          if (mime) headers.set('Content-Type', mime)
          // 内容来自本地缓存且 URL 即键，与远程回源路径同等下发按天缓存
          headers.set('Cache-Control', 'public, max-age=86400')
          // Buffer → Uint8Array 拷贝视图：满足 Response BodyInit 类型要求
          return new Response(new Uint8Array(cached), { status: 200, headers })
        }
        await removeCivImageCache(target)
      }
      // 回源（在途去重 + 并发上限，OPT-05）
      const shared = await fetchCivImageShared(target)
      if (shared.errorStatus) {
        return new Response('Upstream Error', { status: shared.errorStatus })
      }
      // 远程图内容一般不可变，按天缓存减轻 CDN 与代理压力。
      // 响应头按白名单重建（不透传上游 Set-Cookie 等）；响应体为完整
      // Buffer（经 Uint8Array 视图满足 BodyInit 类型，与缓存命中路径一致），
      // 长度由 Response 自动计算，不继承上游可能失真的 Content-Length
      const headers = proxyMediaHeaders(shared.upstream)
      headers.set('Cache-Control', 'public, max-age=86400')
      return new Response(new Uint8Array(shared.buf), {
        status: shared.upstream.status,
        statusText: shared.upstream.statusText,
        headers,
      })
    } catch (err) {
      logger.error(`civimg 协议处理失败: ${err.message}`)
      return new Response('Internal Error', { status: 500 })
    }
  })
}

/** 视频扩展名（Civitai 示例视频，FN-02）：走流式代理而非磁盘图片缓存 */
const VIDEO_URL_RE = /\.(mp4|webm|mov|m4v)(?:$|[?#])/i

/**
 * 是否为示例视频地址（纯函数，便于单测）。
 * @param {unknown} url CDN 地址
 * @returns {boolean}
 */
export function isCivitaiVideoUrl(url) {
  return typeof url === 'string' && VIDEO_URL_RE.test(url)
}

/**
 * 示例视频流式代理（FN-02）：
 * 透传渲染进程的 Range 请求头（拖动播放/分段加载），响应体直接流回，
 * 不在主进程聚合（视频可达数百 MB）；不写磁盘缓存，仅下发按天缓存头。
 * 域名白名单与图片代理一致（调用方已校验，fetchCivitaiVideo 内部再校验）。
 * OPT-05 并发收口：acquireSlot 提供时仅在「头部阶段」持槽——响应头到达
 * 即释放（body 流式回传由渲染进程驱动，不占并发额度，避免长播放饿死
 * 图片回源）。
 * @param {string} target 白名单内的视频 URL
 * @param {Request} request 原始协议请求（读取 Range）
 * @param {() => Promise<() => void>} [acquireSlot] 并发槽位获取器
 * @returns {Promise<Response>}
 */
async function proxyCivitaiVideo(target, request, acquireSlot) {
  const release = acquireSlot ? await acquireSlot() : null
  try {
    const range = request?.headers?.get?.('range') || ''
    const upstream = await fetchCivitaiVideo(target, range)
    if (!upstream.ok && upstream.status !== 206) {
      logger.warn(
        `civimg 视频上游响应异常（HTTP ${upstream.status}）: ${target.slice(0, 200)}`,
      )
      return new Response('Upstream Error', { status: 502 })
    }
    // 流式响应保留上游 Content-Length/Content-Range（拖动播放语义所需），
    // 其余响应头同样按白名单重建
    const headers = proxyMediaHeaders(upstream, ['Content-Length'])
    headers.set('Cache-Control', 'public, max-age=86400')
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    })
  } catch (err) {
    logger.warn(`civimg 视频代理失败: ${err.message}`)
    return new Response('Upstream Error', { status: 502 })
  } finally {
    release?.()
  }
}

/** 由本地图片绝对路径构造渲染进程可用的 mvimg URL */
export function toImageUrl(filePath) {
  if (!filePath) return ''
  return `${SCHEME}://local/${encodeURIComponent(filePath)}`
}
