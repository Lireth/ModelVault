import { protocol, net, app } from 'electron'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import logger from './logger'
import { isValidImageFile } from './services/covers'
import { getCurrentRoot } from './services/store'

/**
 * 自定义图片协议 mvimg://
 * 用于在渲染进程中安全显示本地磁盘图片（封面/预览图），
 * 兼容开发（http://localhost）与生产（file://）两种页面来源，
 * 且无需放宽 CSP 或开启 Node 能力。
 * 用法：mvimg://local/<encodeURIComponent(绝对路径)>
 */

const SCHEME = 'mvimg'

/** 必须在 app ready 之前调用 */
export function registerImageScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

/**
 * 放行目录 realpath 缓存（B1）：首页网格数百张封面时，每张图片请求
 * 省去 2 次 realpath 系统调用。键为目录字面量，容量有界；
 * 根目录切换时整体失效（见 isAllowedPath 中的 lastSeenRoot 检查）。
 */
const realpathCache = new Map()
const REALPATH_CACHE_MAX = 8
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
 * 放行目录本身也做 realpath 归一（root 可能位于 junction 之下），
 * Windows 上按大小写不敏感比较（与路径关联存储的兜底策略一致）。
 */
async function isAllowedPath(realPath) {
  const root = getCurrentRoot()
  // 根目录切换时缓存整体失效：旧根的 realpath 不再适用于新根的归属判断
  if (root !== lastSeenRoot) {
    realpathCache.clear()
    lastSeenRoot = root
  }
  const allowed = []
  if (root) allowed.push(path.normalize(root))
  // 旧版全局封面目录（迁移前的历史数据兼容）
  allowed.push(path.join(app.getPath('userData'), 'covers'))
  const lower = process.platform === 'win32'
  const target = lower ? realPath.toLowerCase() : realPath
  for (const dir of allowed) {
    const resolved = await realpathCached(dir)
    if (!resolved) continue
    const base = lower ? resolved.toLowerCase() : resolved
    const rel = path.relative(base, target)
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return true
    }
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
export function isImmutableAssetPath(realPath) {
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
    immutable ? 'public, max-age=31536000, immutable' : 'no-cache'
  )
  return new Response(upstream.body, {
    status: upstream.status || 200,
    statusText: upstream.statusText,
    headers
  })
}

/** 在 app ready 之后调用，注册协议处理器 */
export function registerImageProtocolHandler() {
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
      // 先解析符号链接/junction 得到真实路径，再校验归属（B8）
      let realPath
      try {
        realPath = await fs.promises.realpath(filePath)
      } catch {
        return new Response('Not Found', { status: 404 })
      }
      if (!(await isAllowedPath(realPath))) {
        logger.warn(`mvimg 协议拒绝访问路径: ${filePath}`)
        return new Response('Forbidden', { status: 403 })
      }
      if (!(await isValidImageFile(realPath))) {
        return new Response('Not Found', { status: 404 })
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
  logger.info(`自定义协议 ${SCHEME}:// 注册完成`)
}

/** 由本地图片绝对路径构造渲染进程可用的 mvimg URL */
export function toImageUrl(filePath) {
  if (!filePath) return ''
  return `${SCHEME}://local/${encodeURIComponent(filePath)}`
}
