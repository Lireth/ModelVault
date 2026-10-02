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
 * 校验请求的真实路径是否允许访问：仅限当前模型根目录（含关联存储）与旧版封面目录。
 * 入参必须是已 fs.realpath 解析后的路径：根目录内的符号链接/junction
 * 若指向根目录外，字面前缀校验可被绕过，必须以解析后的真实路径判断（B8）。
 * 放行目录本身也做 realpath 归一（root 可能位于 junction 之下），
 * Windows 上按大小写不敏感比较（与路径关联存储的兜底策略一致）。
 */
async function isAllowedPath(realPath) {
  const allowed = []
  const root = getCurrentRoot()
  if (root) allowed.push(path.normalize(root))
  // 旧版全局封面目录（迁移前的历史数据兼容）
  allowed.push(path.join(app.getPath('userData'), 'covers'))
  const lower = process.platform === 'win32'
  for (const dir of allowed) {
    let resolved
    try {
      resolved = await fs.promises.realpath(dir)
    } catch {
      continue // 放行目录不存在时跳过
    }
    const base = lower ? resolved.toLowerCase() : resolved
    const target = lower ? realPath.toLowerCase() : realPath
    const rel = path.relative(base, target)
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return true
    }
  }
  return false
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
      const filePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
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
      return net.fetch(pathToFileURL(realPath).toString())
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
