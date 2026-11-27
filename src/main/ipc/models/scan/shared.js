/**
 * 扫描链路共享助手与跨子模块可变状态。
 * 全量扫描、局部扫描与取消入口分属不同子模块，scanState 以对象字段承载
 * 跨文件共享的取消控制器（禁止跨文件模块级 let），三个子模块经同一
 * 对象引用保持与原模块级 scanAbort 一致的共享语义。
 */

/**
 * 当前扫描的取消控制器状态（controller 为 null 表示无进行中的扫描）。
 * @type {{ controller: AbortController|null }}
 */
export const scanState = {
  /** @type {AbortController|null} */
  controller: null,
}

/**
 * 解析扫描扩展名选项（FIX-5 全量/局部扫描统一口径）：
 * 返回用户配置的扫描扩展名列表；异常情况（非数组/空数组——设置规范化
 * normalizeExtensions 保证恒非空，此处仅为契约兜底，防设置层漂移）返回
 * undefined，由 scanner 落回默认全集（options.extensions || MODEL_EXTENSIONS）。
 * 不可用 `|| []` 兜底：空数组为真值，scanner 语义中空集 = 扫不到任何文件，
 * 会把整次扫描静默变成零结果。
 * 纯函数，便于单测。
 * @param {{scanExtensions?: unknown}|undefined} appSettings 应用设置（getSettings() 结果）
 * @returns {string[]|undefined}
 */
export function resolveScanExtensions(appSettings) {
  const exts = appSettings?.scanExtensions
  return Array.isArray(exts) && exts.length > 0 ? exts : undefined
}
