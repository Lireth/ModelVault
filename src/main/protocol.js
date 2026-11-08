import { protocol } from 'electron'
import logger from './logger'
import { IMAGE_URL_SCHEME as SCHEME } from '../shared/image-url'
import { registerMvimgHandler } from './protocol/local-image'
import { CIV_SCHEME, registerCivimgHandler } from './protocol/remote-image'

/**
 * 自定义图片协议入口门面（按域拆分后的聚合模块）：
 * - protocol/local-image.js  mvimg:// 本地受控图片（realpath 缓存/条件请求/流式读盘）
 * - protocol/remote-image.js civimg:// Civitai 远程图片与视频代理（缓存/并发/负缓存）
 * - protocol/http-cache.js   缓存头、ETag/304、MIME 与代理响应头工具
 *
 * mvimg:// 用于在渲染进程中安全显示本地磁盘图片（封面/预览图），
 * 兼容开发（http://localhost）与生产（file://）两种页面来源，
 * 且无需放宽 CSP 或开启 Node 能力。
 * 用法：mvimg://local/<encodeURIComponent(绝对路径)>
 *
 * civimg:// 用于在渲染进程中显示 Civitai 示例图（远程 CDN 图片）：渲染进程直连
 * image.civitai.com 受 CSP/系统代理/Cloudflare 反爬等多重因素影响易失败，
 * 统一经主进程 net.fetch 代理（与识别/下载同一网络栈），并强制
 * 「https + 官方 CDN 域名白名单」校验。用法：
 * civimg://remote/<encodeURIComponent(图片 https URL)>
 */

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
        // corsEnabled：允许跨源 CORS 请求到达本协议处理器（响应头经
        // withCacheHeaders 附带 ACAO:*）。缩略图隐藏窗口（about:blank
        // 不透明来源）需经 <img crossorigin="anonymous"> 读取源图绘制
        // OffscreenCanvas，缺该特权时 CORS 请求在 Chromium 层被直接
        // 拦截，图片加载失败、缩略图回退原图。
        corsEnabled: true,
      },
    },
    {
      scheme: CIV_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ])
}

/** 在 app ready 之后调用，注册协议处理器（mvimg 本地图 + civimg 远程代理） */
export function registerImageProtocolHandler() {
  registerMvimgHandler()
  registerCivimgHandler()
  logger.info(`自定义协议 ${SCHEME}:// 与 ${CIV_SCHEME}:// 注册完成`)
}

/** 示例视频地址判定（实现位于 remote-image，此处保持既有导入面） */
export { isCivitaiVideoUrl } from './protocol/remote-image'

/**
 * 由本地图片绝对路径构造渲染进程可用的 mvimg URL。
 * 实现收敛于 shared/image-url.js（主/渲染两侧单一来源，列表瘦身依赖渲染侧
 * 派生）；此处 re-export 保持既有导入面（decorate/covers/thumbs 等）不变。
 */
export { toImageUrl } from '../shared/image-url'
