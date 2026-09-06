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

/** 校验请求路径是否允许访问：仅限当前模型根目录（含关联存储）与旧版封面目录 */
function isAllowedPath(filePath) {
  const normalized = path.normalize(filePath)
  const allowed = []
  const root = getCurrentRoot()
  if (root) allowed.push(path.normalize(root))
  // 旧版全局封面目录（迁移前的历史数据兼容）
  allowed.push(path.join(app.getPath('userData'), 'covers'))
  return allowed.some((dir) => {
    const rel = path.relative(dir, normalized)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
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
      const filePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      if (!isAllowedPath(filePath)) {
        logger.warn(`mvimg 协议拒绝访问路径: ${filePath}`)
        return new Response('Forbidden', { status: 403 })
      }
      if (!(await isValidImageFile(filePath))) {
        return new Response('Not Found', { status: 404 })
      }
      return net.fetch(pathToFileURL(filePath).toString())
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
