/**
 * 渲染进程 CSP 构建期处理（B4）：
 * 源码 index.html 的 CSP 为 dev 与生产共享的基底——显式收紧
 * object-src/base-uri/form-action/frame-src（不再仅靠 default-src
 * 隐式覆盖），并保留 style-src 的 'unsafe-inline'（dev 的 HMR
 * 经 <style> 标签注入样式所需）。
 * 生产构建将 CSS 抽为 <link> 外链（见 out/renderer 产物），此时
 * 'unsafe-inline' 不再必要——本模块在构建期将其移除，收紧基线。
 */

/** dev CSP 中的内联样式许可（仅 HMR 需要） */
const DEV_STYLE_SRC = "style-src 'self' 'unsafe-inline'"
/** 生产 CSP 的样式许可（CSS 为 link 外链，禁止内联） */
const PROD_STYLE_SRC = "style-src 'self'"

/** 匹配 CSP meta 标签（http-equiv 与 content 之间允许任意空白） */
const CSP_META_RE = /(http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/

/**
 * 把一条 dev CSP 转换为生产 CSP：仅移除 style-src 的内联许可，
 * 其余指令原样保留。对已是生产形态的输入幂等。
 * @param {string} csp 源码（dev）CSP 字符串
 * @returns {string} 生产 CSP 字符串
 */
export function toProductionCsp(csp) {
  return csp.replace(DEV_STYLE_SRC, PROD_STYLE_SRC)
}

/**
 * 将渲染进程 HTML 中的 CSP meta 替换为生产版本（供 Vite 构建插件调用）。
 * HTML 不含 CSP meta 时原样返回（不做猜测性注入）。
 * @param {string} html index.html 内容
 * @returns {string} 替换后的 HTML
 */
export function applyProductionCsp(html) {
  return html.replace(CSP_META_RE, (_match, prefix, csp, suffix) => `${prefix}${toProductionCsp(csp)}${suffix}`)
}
