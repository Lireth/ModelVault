import { state } from './state'
import { toast } from './toast'

/**
 * 全库标签管理（F4，设置页标签管理面板的数据动作）：
 * 主进程整库改写 store.json（renameTag/removeTag），本模块把结果同步到
 * 本地模型列表（元素级整体替换约定），操作即时生效无需重扫。
 */

/** 标签列表规范化：大小写不敏感去重（保留首次出现的写法） */
function dedupeTags(tags) {
  const seen = new Set()
  const out = []
  for (const t of tags) {
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}

/**
 * 对本地全模型执行一次标签编辑；未命中的模型保持对象引用不变
 * （与 meta-apply 的浅响应约定一致，避免无谓的列表项替换）。
 * @param {(tags: string[]) => string[]} edit 返回同一引用表示未改动
 * @returns {number} 发生改动的模型数
 */
function applyTagEdit(edit) {
  let changed = 0
  state.models.forEach((m, i) => {
    const next = edit(m.tags || [])
    if (next === m.tags) return
    changed += 1
    state.models[i] = { ...m, tags: next }
  })
  return changed
}

/**
 * 全库重命名自由标签（目标名已存在时合并，服务端与本地各自去重）。
 * @param {string} from 现有标签名（精确匹配）
 * @param {string} to 新标签名
 * @returns {Promise<{changed: number, error?: string}>}
 */
export async function renameTagGlobally(from, to) {
  let res
  try {
    res = await window.api.models.renameTag(from, to)
  } catch (err) {
    toast('error', `标签重命名失败: ${err.message}`)
    return { changed: 0, error: err.message }
  }
  if (res.error) {
    toast('error', res.error)
    return res
  }
  const changed = applyTagEdit((tags) => {
    if (!tags.includes(from)) return tags
    return dedupeTags(tags.map((t) => (t === from ? to : t)))
  })
  toast('success', `已将「${from}」重命名为「${to}」（${changed} 个模型）`)
  return res
}

/**
 * 全库移除自由标签。
 * @param {string} tag 要移除的标签名（精确匹配）
 * @returns {Promise<{changed: number, error?: string}>}
 */
export async function removeTagGlobally(tag) {
  let res
  try {
    res = await window.api.models.removeTag(tag)
  } catch (err) {
    toast('error', `标签移除失败: ${err.message}`)
    return { changed: 0, error: err.message }
  }
  if (res.error) {
    toast('error', res.error)
    return res
  }
  const changed = applyTagEdit((tags) =>
    tags.includes(tag) ? tags.filter((t) => t !== tag) : tags,
  )
  toast('success', `已移除标签「${tag}」（${changed} 个模型）`)
  return res
}
