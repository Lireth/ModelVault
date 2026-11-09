import { protocol } from 'electron'
import logger from '../logger'
import { getSettings } from '../services/store'
import {
  CIVITAI_DISABLED_ERROR,
  isAllowedCivitaiImageUrl,
  fetchCivitaiImage,
  fetchCivitaiVideo,
  readCivitaiImageBody,
} from '../services/civitai'
import {
  civCacheContentType,
  getCivImageFromCache,
  removeCivImageCache,
  saveCivImageCache,
} from '../services/civ-cache'
import { isImageBuffer } from '../services/covers'
import { proxyMediaHeaders, toBodyView } from './http-cache'
import { errorMessage } from '../../shared/error-text'

/**
 * civimg:// 远程图片/视频代理（自 protocol.js 拆出）：
 * 域名白名单、并发槽、在途去重、磁盘缓存与失败负缓存。协议注册与本地
 * 图片处理见 protocol.js / protocol/local-image.js。
 */

/** civimg 协议 scheme（registerImageScheme 与处理器共用） */
export const CIV_SCHEME = 'civimg'

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
 * civimg 上游失败负缓存（OPT-7）：URL → retryAt。
 * 已失效/已删除的 CDN 图（404/403）与网络故障在画廊滚动时会随每次 <img>
 * 请求反复回源（域名校验 + fetch + 30s 超时，30 张失效图即 30 次全等待）。
 * 短 TTL 记录失败结果：静默期内同 URL 直接返回失败状态（零回源零读盘），
 * 到期惰性删除恢复重试（网络恢复/图重新上架的自愈通道）；成功回源即清除。
 * 仅覆盖图片路径：视频流式代理失败不落缓存（头部阶段失败本就轻量）。
 */
const CIVIMG_FAIL_TTL_MS = 60_000
/** 负缓存容量上限（病态防御，超过丢弃最旧记录） */
const CIVIMG_FAIL_MAX_ENTRIES = 2048
const civimgFailures = new Map()

/**
 * 静默期内同 URL 的缓存失败状态（无记录/已到期返回 0）。
 * 到期即惰性删除，下一次请求正常回源。
 * @param {string} target 图片 URL
 * @returns {number} 失败状态码（0 = 不在负缓存）
 */
function peekCivimgFailure(target) {
  const retryAt = civimgFailures.get(target)
  if (retryAt === undefined) return 0
  if (Date.now() >= retryAt) {
    civimgFailures.delete(target)
    return 0
  }
  return 502
}

/**
 * 记录一次 civimg 上游失败（OPT-7）：容量超限时丢弃最旧记录（Map 插入序）。
 * @param {string} target 图片 URL
 */
function recordCivimgFailure(target) {
  if (
    !civimgFailures.has(target) &&
    civimgFailures.size >= CIVIMG_FAIL_MAX_ENTRIES
  ) {
    const oldest = civimgFailures.keys().next().value
    if (oldest !== undefined) civimgFailures.delete(oldest)
  }
  civimgFailures.set(target, Date.now() + CIVIMG_FAIL_TTL_MS)
}

/**
 * 图片共享回源（OPT-05 去重 + 并发约束；OPT-7 失败记入负缓存）：
 * 图片路径整体读入 Buffer，各调用方从共享结果自建 Response——上游拉取、
 * 体积上限校验与磁盘缓存写入对同 URL 并发请求只发生一次；失败同样共享
 * （并统一记入负缓存：HTTP 非成功、内容读取失败与网络层异常三条路径，
 * 静默期内同 URL 零回源）。
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
        recordCivimgFailure(target)
        return { errorStatus: 502 }
      }
      // 整体读入后回写磁盘缓存（best-effort，失败不影响返回）；仅缓存
      // 真实图片内容——魔数不符的字节（上游异常页等）不入缓存。
      // 读取受 50MB 上限约束（V-06），避免异常大响应打爆主进程堆
      let buf
      try {
        buf = await readCivitaiImageBody(upstream)
      } catch (err) {
        logger.warn(`civimg 上游内容读取失败: ${errorMessage(err)}`)
        recordCivimgFailure(target)
        return { errorStatus: 502 }
      }
      // OPT-7：成功回源即清除失败记录（失效图重新上架的自愈即刻生效）
      civimgFailures.delete(target)
      if (isImageBuffer(buf)) {
        await saveCivImageCache(target, buf)
      }
      return { buf, upstream }
    } catch (err) {
      // 网络层失败（离线/超时/连接重置）同样记入负缓存：离线滚动画廊
      // 不再逐图等待完整超时（记录后由调用方统一按 502 语义返回）
      recordCivimgFailure(target)
      throw err
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

/** 注册 civimg:// 处理器（app ready 之后调用） */
export function registerCivimgHandler() {
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
      // OPT-7 负缓存：近期上游失败的 URL 静默期内直接返回失败状态——
      // 画廊滚动对已失效图零回源零读盘（记录只在缓存未命中时产生，
      // 命中的 URL 不可能与负缓存共存，置于磁盘缓存读取之前可一并省去读盘）
      const failStatus = peekCivimgFailure(target)
      if (failStatus) {
        return new Response('Upstream Error', { status: failStatus })
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
          // Buffer → Uint8Array 零拷贝视图（OPT-22）：new Uint8Array(buf) 是
          // 逐字节复制——画廊滚动 30 张 5MB 图即 ~300MB 瞬时分配；视图只暴露
          // buffer 的 [byteOffset, byteOffset+byteLength) 区间，对 Buffer 池
          // 分配同样安全，BodyInit 接受 ArrayBufferView 类型
          return new Response(toBodyView(cached), { status: 200, headers })
        }
        await removeCivImageCache(target)
      }
      // 回源（在途去重 + 并发上限，OPT-05）；网络层失败统一按上游错误
      // 语义返回 502（OPT-7 起同时已记入负缓存，静默期内同 URL 零回源）
      let shared
      try {
        shared = await fetchCivImageShared(target)
      } catch (err) {
        logger.warn(`civimg 回源网络失败: ${errorMessage(err)}`)
        return new Response('Upstream Error', { status: 502 })
      }
      if (shared.errorStatus) {
        return new Response('Upstream Error', { status: shared.errorStatus })
      }
      // 远程图内容一般不可变，按天缓存减轻 CDN 与代理压力。
      // 响应头按白名单重建（不透传上游 Set-Cookie 等）；响应体为完整
      // Buffer（经零拷贝视图满足 BodyInit 类型，与缓存命中路径一致；
      // 在途去重的并发请求共享同一不可变 Buffer 的各自视图，内容只读），
      // 长度由 Response 自动计算，不继承上游可能失真的 Content-Length
      const headers = proxyMediaHeaders(shared.upstream)
      headers.set('Cache-Control', 'public, max-age=86400')
      return new Response(toBodyView(shared.buf), {
        status: shared.upstream.status,
        statusText: shared.upstream.statusText,
        headers,
      })
    } catch (err) {
      logger.error(`civimg 协议处理失败: ${errorMessage(err)}`)
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
    logger.warn(`civimg 视频代理失败: ${errorMessage(err)}`)
    return new Response('Upstream Error', { status: 502 })
  } finally {
    release?.()
  }
}
