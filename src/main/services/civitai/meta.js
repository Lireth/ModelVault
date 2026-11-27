/**
 * Civitai 元数据整形（纯函数，无 IO）：
 * 描述富文本剥离为纯文本、「一键补全」元数据补丁构造。
 */

/** stripHtml 单次解码的常见实体表（命名 + 数字引用，键为原文形态） */
/** @type {Record<string, string>} */
const HTML_TEXT_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
}

/**
 * 剥离 Civitai 描述中的 HTML 标签并压缩空白（描述为富文本 HTML，
 * 备注为纯文本；实体仅处理常见命名实体，其余由浏览器渲染时自然容错）。
 * CodeQL #2：实体解码为单趟替换——链式逐个 replace 会让前一步的输出
 * 成为后一步的输入（`&amp;lt;` 二次解码为 `<`），单趟 + 表映射只解码
 * 一层，语义与 HTML 规范一致。输出仅流向纯文本 sink（Vue 插值/textarea/
 * CSV/Markdown 导出），无 HTML 渲染路径。
 * 纯函数，便于单测。
 * @param {string} html HTML 文本
 * @returns {string} 纯文本（已修剪）
 */
export function stripHtml(html) {
  if (typeof html !== 'string') return ''
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(
      /&(?:amp|lt|gt|quot|#39|nbsp);/g,
      (m) => HTML_TEXT_ENTITIES[m] ?? m,
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 由 Civitai 版本信息与当前元数据构造「一键补全」补丁（纯函数）：
 * 仅补空缺字段——触发词为空时导入 trainedWords，备注为空时导入描述纯文本，
 * 绝不覆盖任何用户已有标注（与 sidecar/civitai.info 导入同一原则）。
 * @param {Record<string, any>} meta 当前模型元数据（判空基准）
 * @param {import('./api').CivitaiVersionInfo} info normalizeVersionInfo 的规范化结果
 * @returns {{patch: Record<string, any>, applied: string[]}} patch 可合并到元数据；
 *   applied 为实际补全的字段名列表（渲染层据此提示）
 */
export function civitaiCompletePatch(meta, info) {
  const patch = {}
  if (!info || typeof info !== 'object' || !meta) return { patch, applied: [] }
  if (!meta.triggerWords && info.trainedWords?.length > 0) {
    const words = info.trainedWords.join(', ').slice(0, 1000)
    if (words.trim()) {
      patch.triggerWords = words
    }
  }
  if (!meta.note && info.description) {
    const text = stripHtml(info.description).slice(0, 2000)
    if (text) {
      patch.note = text
    }
  }
  return { patch, applied: Object.keys(patch) }
}
