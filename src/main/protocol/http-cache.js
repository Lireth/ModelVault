import path from 'node:path'

/**
 * 图片协议的 HTTP 缓存与响应构造工具（自 protocol.js 拆出）：
 * 不可变资产判定、缓存头、条件请求（ETag/Last-Modified）、MIME 推断、
 * 代理响应头白名单与零拷贝响应体视图。全部为无状态纯函数，便于单测复用。
 */

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
export function isImmutableAssetPath(realPath) {
  if (typeof realPath !== 'string' || !realPath) return false
  const normalized = realPath.replace(/\\/g, '/').toLowerCase()
  return (
    normalized.includes('/.modelvault/covers/') ||
    normalized.includes('/.modelvault/thumbs/')
  )
}

/**
 * 缓存策略值：不可变资产长缓存一年（省重复读盘/解码）；其余（sidecar
 * 同名图）no-cache，每次使用前重验证，防止用户替换同名预览图后看到旧图。
 * @param {boolean} immutable 是否不可变资产
 * @returns {string} Cache-Control 值
 */
function cacheControlValue(immutable) {
  return immutable ? 'public, max-age=31536000, immutable' : 'no-cache'
}

/**
 * 为上游 file:// 响应附加缓存策略头（A-05），保留响应体与其余响应头。
 * 另附 `Access-Control-Allow-Origin: *`：缩略图隐藏窗口（about:blank 不透明
 * 来源）经 <img crossorigin="anonymous"> 读取源图做 OffscreenCanvas 缩放，
 * 无该头时 CORS 校验不通过，画布被污染导致 convertToBlob 抛错（回退原图）。
 * mvimg 响应体本就限定在当前库根目录内的图片文件，放开跨源读不扩大可读范围。
 * @param {Response} upstream 上游响应
 * @param {boolean} immutable 是否不可变资产
 * @returns {Response} 附加缓存头后的响应
 */
export function withCacheHeaders(upstream, immutable) {
  const headers = new Headers(upstream.headers || undefined)
  headers.set('Cache-Control', cacheControlValue(immutable))
  headers.set('Access-Control-Allow-Origin', '*')
  return new Response(upstream.body, {
    status: upstream.status || 200,
    statusText: upstream.statusText,
    headers,
  })
}

/**
 * 由文件 stat 构造弱 ETag（OPT-7 条件请求支持）：
 * mtime+size 即内容指纹——mvimg 资产语义与 Last-Modified 同一假设
 * （mtime 未变时内容未变；sidecar 同名图被替换必改 mtime）。
 * @param {{mtimeMs: number, size: number}} stat 文件 stat 结果
 * @returns {string} 弱 ETag（W/ 前缀，允许语义等价比较）
 */
export function etagForStat(stat) {
  return `W/"${stat.mtimeMs}-${stat.size}"`
}

/**
 * 判定条件请求是否命中（OPT-7）：命中即 304 短路，验证过程零读盘。
 * 渲染层对 no-cache 资产（sidecar 同名图）的每次重验证从「全量重读」
 * 降为「零开销确认」，命中时 Chromium 直接复用本地缓存字节。
 * If-None-Match 优先（RFC 7232：携带 INM 时忽略 IMS）；弱比较剥离 W/
 * 前缀后比较不透明值，`*` 匹配任意现存资源；INM 未命中时返回 false
 * （不降级 IMS 判定），由调用方走 200 全量。
 * @param {Request|undefined} request 协议请求（测试桩可能无 headers）
 * @param {{mtimeMs: number, size: number}} stat 当前文件 stat
 * @returns {boolean}
 */
export function isConditionalHit(request, stat) {
  const headers = request?.headers
  const inm = headers?.get?.('if-none-match')
  if (typeof inm === 'string' && inm) {
    const opaque = etagForStat(stat).replace(/^W\//, '')
    return inm.split(',').some((candidate) => {
      const value = candidate.trim()
      return value === '*' || value.replace(/^W\//, '') === opaque
    })
  }
  const ims = headers?.get?.('if-modified-since')
  if (typeof ims === 'string' && ims) {
    const since = Date.parse(ims)
    if (Number.isFinite(since)) {
      // Last-Modified 与 IMS 均为秒级粒度：毫秒截断后比较
      return stat.mtimeMs - (stat.mtimeMs % 1000) <= since
    }
  }
  return false
}

/** 构造 304 响应：携带缓存策略与验证器（ETag/Last-Modified）供缓存更新元数据 */
export function notModifiedResponse(immutable, etag, lastModified) {
  const headers = new Headers()
  headers.set('Cache-Control', cacheControlValue(immutable))
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('ETag', etag)
  headers.set('Last-Modified', lastModified)
  return new Response(null, { status: 304, headers })
}

/**
 * 图片扩展名 → Content-Type（PERF-6 直读响应自行下发；扩展名集合与
 * scanner.IMAGE_EXTENSIONS 一致，白名单校验未命中的请求到不了这里）。
 */
const IMAGE_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

/**
 * 按扩展名推断图片 MIME（未知扩展名回退 image/png）。
 * @param {string} realPath 图片绝对路径
 * @returns {string} Content-Type
 */
export function imageMimeType(realPath) {
  return IMAGE_MIME_TYPES[path.extname(realPath).toLowerCase()] || 'image/png'
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
 * Buffer → Uint8Array 零拷贝视图（OPT-22）：满足 Response BodyInit 类型
 * 要求的同时消除逐字节复制——`new Uint8Array(buf)` 是复制构造，画廊滚动
 * 的大图会在主进程产生同量级的瞬时分配与 GC 压力；视图只暴露 buffer 自身
 * 的 [byteOffset, byteOffset+byteLength) 区间，对 Buffer 池分配同样安全。
 * 仅用于只读 Buffer（civ 缓存与回源共享 buf 均不可变）。
 * @param {Buffer} buf 只读 Buffer
 * @returns {Uint8Array<ArrayBuffer>} Buffer 的池分配必为普通 ArrayBuffer
 */
export function toBodyView(buf) {
  return /** @type {Uint8Array<ArrayBuffer>} */ (
    new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  )
}

/**
 * 按白名单重建代理响应头。
 * @param {Response} upstream 上游响应
 * @param {string[]} [extra] 额外放行的头（流式视频需 Content-Length 配合
 *   Content-Range 支撑拖动播放）
 * @returns {Headers} 白名单重建后的新 Headers
 */
export function proxyMediaHeaders(upstream, extra = []) {
  const source = upstream.headers || new Headers()
  const headers = new Headers()
  for (const name of [...PROXY_SAFE_RESPONSE_HEADERS, ...extra]) {
    const value = source.get(name)
    if (value) headers.set(name, value)
  }
  return headers
}
