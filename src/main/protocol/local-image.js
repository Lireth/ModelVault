import path from 'node:path'
import fs from 'node:fs'
import { Readable } from 'node:stream'
import { protocol, app } from 'electron'
import logger from '../logger'
import { relativeWithin } from '../utils'
import { isValidImageFile } from '../services/covers'
import { getCurrentRoot } from '../services/store'
import { IMAGE_URL_SCHEME as SCHEME } from '../../shared/image-url'
import {
  etagForStat,
  imageMimeType,
  isConditionalHit,
  isImmutableAssetPath,
  notModifiedResponse,
  withCacheHeaders,
} from './http-cache'

/**
 * mvimg:// 本地受控图片协议处理器（自 protocol.js 拆出）：
 * 路径归属校验（realpath + 根目录白名单）、不可变资产短 TTL 缓存、
 * 条件请求（304）与流式响应。协议注册与远端代理见 protocol.js /
 * protocol/remote-image.js。
 */

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
 * @param {string} realPath 已 realpath 归一的绝对路径
 * @returns {Promise<boolean>} 允许访问返回 true
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

/** mvimg:// 处理器：本地受控图片 */
export function registerMvimgHandler() {
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
      // PERF-6：net.fetch(file://) 需经一轮 Chromium URL 载入栈，仅为读本地
      // 文件；改为 Node 流式直读（fh.createReadStream → Readable.toWeb），
      // Content-Type/Content-Length/Last-Modified/ETag 由本方下发，响应头
      // 确定化。OPT-7：stat 前置以构造验证器并判定条件请求——命中即 304
      // 短路（跳过全量 body 流；12 字节魔数校验仍保留，sidecar 内容可被
      // 外部替换的既有安全设计不变），未命中才打开文件建流。文件句柄随流
      // autoClose（流结束/出错/取消时关闭）；open 与建流之间的失败显式关闭
      // 句柄。校验到读盘之间文件被删除/替换属瞬态竞态：流中断由渲染层
      // <img> 错误回退原图，与既有失效处理一致。
      const immutable = isImmutableAssetPath(realPath)
      const stat = await fs.promises.stat(realPath)
      const etag = etagForStat(stat)
      const lastModified = new Date(stat.mtimeMs).toUTCString()
      if (isConditionalHit(request, stat)) {
        return notModifiedResponse(immutable, etag, lastModified)
      }
      const fh = await fs.promises.open(realPath, 'r')
      let body
      try {
        body = Readable.toWeb(fh.createReadStream())
      } catch (err) {
        await fh.close().catch(() => {})
        throw err
      }
      return withCacheHeaders(
        new Response(body, {
          status: 200,
          headers: {
            'Content-Type': imageMimeType(realPath),
            'Content-Length': String(stat.size),
            'Last-Modified': lastModified,
            ETag: etag,
          },
        }),
        immutable,
      )
    } catch (err) {
      logger.error(`mvimg 协议处理失败: ${err.message}`)
      return new Response('Internal Error', { status: 500 })
    }
  })
}
