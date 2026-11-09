/**
 * 异常字段安全读取助手（O-5 useUnknownInCatchVariables 消化配套）：
 * catch 变量在严格模式下为 unknown，直接取 .message/.code/.name/.stack
 * 无法通过类型检查。本模块提供与「非 Error 抛出值」兼容的统一读取入口，
 * 语义与历史写法逐点对齐：
 * - errorMessage：Error 取 message，其余 String(err)（模板串中呈现可读文案）
 * - errorName / errorStack：非 Error 返回空串（比较分支天然落空）
 * - errorCode：仅对象且自有/继承 code 时返回字符串，否则空串
 * 零依赖纯函数，shared 契约层规范：主进程 / preload / 渲染层均可导入。
 */

/**
 * 异常 → 展示文案（替代 `err.message` / `err?.message || err`）。
 * @param {unknown} err 捕获的异常
 * @returns {string} 可读错误信息
 */
export function errorMessage(err) {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 异常 → name（AbortError/TimeoutError 判定，替代 `err.name === 'X'`）。
 * @param {unknown} err 捕获的异常
 * @returns {string} Error 的 name，非 Error 为空串
 */
export function errorName(err) {
  return err instanceof Error ? err.name : ''
}

/**
 * 异常 → stack（日志落盘，替代 `err.stack`）。
 * @param {unknown} err 捕获的异常
 * @returns {string} Error 的 stack，缺失为空串
 */
export function errorStack(err) {
  return err instanceof Error && err.stack ? err.stack : ''
}

/**
 * 异常 → Node 错误码（ENOENT/EBUSY 判定，替代 `err.code`）。
 * @param {unknown} err 捕获的异常
 * @returns {string} 字符串 code，缺失为空串
 */
export function errorCode(err) {
  if (err && typeof err === 'object' && 'code' in err) {
    return String(/** @type {{code?: unknown}} */ (err).code)
  }
  return ''
}
