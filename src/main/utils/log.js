/**
 * 日志文本净化（#66 日志伪造面）：渲染进程可控字符串（协议 URL pathname
 * 解码结果等）写入按天日志前，将换行与控制字符替换为可见转义序列。
 * logger 按行落盘且不做转义，未净化的 %0A 解码换行可注入伪造的
 * [INFO]/[WARN] 行，污染日志与诊断包尾部截取的最近日志。
 */

/**
 * 控制字符 → 单行可见转义：\n、\r、\t 保留语义可读性，其余 C0/C1 控制字符
 * （含终端转义序列前缀 ESC）按 \xHH 呈现，杜绝借换行伪造日志行。
 * 逐码点判定而非正则：代理对（astral 字符）原样保留，语义与普通文本一致。
 * @param {string} text 未经信任来源的原始文本
 * @returns {string} 不含换行与控制字符的单行文本
 */
export function sanitizeLogText(text) {
  let out = ''
  for (const ch of text) {
    // for-of 产出单码点字符串，codePointAt(0) 必中（strictNullChecks cast）
    const code = /** @type {number} */ (ch.codePointAt(0))
    if (code === 0x0a) out += '\\n'
    else if (code === 0x0d) out += '\\r'
    else if (code === 0x09) out += '\\t'
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      out += `\\x${code.toString(16).padStart(2, '0')}`
    } else out += ch
  }
  return out
}
