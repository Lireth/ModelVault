/**
 * Civitai 域名白名单与请求头校验（纯函数，无 IO）：
 * 基域白名单（API 重定向逐跳校验 + 示例图 URL 校验共用）与
 * Range 头透传白名单格式。
 */

/**
 * Civitai 站点基域（com 主站 + red 镜像站，NSFW 内容在 red 站无需跳转即可识别）。
 * API/图片请求统一从 red 站发起；白名单同时保留 com 域——历史数据中的
 * com 页面链接与两站间的重定向均需放行。
 */
const CIVITAI_BASE_HOSTS = ['civitai.com', 'civitai.red']

/**
 * Civitai API 域名白名单（含子域）：API 初始地址固定，此校验只用于重定向。
 * @param {string} url 待校验 URL
 * @returns {boolean}
 */
export function isAllowedCivitaiApiUrl(url) {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    return CIVITAI_BASE_HOSTS.some(
      (base) => host === base || host.endsWith(`.${base}`),
    )
  } catch {
    return false
  }
}

/**
 * 校验示例图 URL 是否允许下载（纯函数，便于单测）：
 * 必须 https 协议且主机命中 Civitai 基域白名单（含子域——CDN 会随迁移
 * 变更主机名，如 image.civitai.com → blobs-b2.civitai.com，按基域后缀
 * 匹配避免每次迁移都更新白名单）。
 * @param {unknown} url 待校验 URL
 * @returns {boolean}
 */
export function isAllowedCivitaiImageUrl(url) {
  try {
    const parsed = new URL(String(url))
    if (parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    return CIVITAI_BASE_HOSTS.some(
      (base) => host === base || host.endsWith(`.${base}`),
    )
  } catch {
    return false
  }
}

/**
 * 合法 Range 头格式（单区间、字节数 ≤16 位）：
 * 渲染进程可控入参的透传白名单，覆盖开区间（bytes=10-）与后缀区间（bytes=-500）。
 */
export const RANGE_HEADER_RE = /^bytes=\d{0,16}-\d{0,16}$/
