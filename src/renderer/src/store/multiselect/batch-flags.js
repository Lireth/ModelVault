import { state } from '../state'
import { toast } from '../toast'
import { applyMetaUpdates, mapWithConcurrency } from '../meta-apply'

/**
 * 批量快捷标记（E6，O-4 自 multiselect.js 按域拆出）：
 * 收藏 / NSFW / 评分的并发批量更新。复用 setMetaFlags 既有校验与持久化
 * 管线，结果经 applyMetaUpdates 单趟同步本地状态。
 */

/**
 * 批量更新快捷标记（收藏/NSFW/评分，E6）：复用 setMetaFlags 既有校验与
 * 持久化管线，并发逐个调用；结果收集为 Map 后经 applyMetaUpdates 单趟
 * 同步本地状态（O2），避免逐个落定造成的多次响应式失效。
 * in-flight 防护（B6）：执行期间置 busy，批量操作栏按钮禁用，防止连点
 * 对同一批模型重复提交数百个 IPC。
 * @param {Record<string, any>} patch { favorite?/nsfw?/rating? }
 * @param {string} label 完成提示文案（如「收藏」）
 */
async function batchApplyFlags(patch, label) {
  const ids = [...state.multiSelect.ids]
  if (ids.length === 0 || state.multiSelect.busy) return
  state.multiSelect.busy = true
  try {
    const results = await mapWithConcurrency(
      ids,
      (id) => window.api.models.setMetaFlags({ id, ...patch }),
      16,
    )
    const metaMap = new Map()
    let fail = 0
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value?.meta)
        metaMap.set(ids[i], r.value.meta)
      else fail += 1
    })
    const ok = applyMetaUpdates(metaMap, (meta) => ({
      favorite: meta.favorite === true,
      nsfw: meta.nsfw === true,
      rating: meta.rating || 0,
    }))
    if (fail === 0) toast('success', `已为 ${ok} 个模型${label}`)
    else toast('warn', `${label}完成：成功 ${ok} 个，失败 ${fail} 个`)
  } finally {
    state.multiSelect.busy = false
    // 并发型批量不响应取消，但 Esc 置位的标志必须在此复位：
    // 否则取消意图泄漏到下一个串行批量，首轮即被误判为已取消
    state.multiSelect.cancelRequested = false
  }
}

/** 批量收藏/取消收藏 */
export function batchFavorite(favorite) {
  return batchApplyFlags({ favorite }, favorite ? '收藏' : '取消收藏')
}

/** 批量设置 NSFW 标记 */
export function batchNsfw(nsfw) {
  return batchApplyFlags({ nsfw }, nsfw ? '标记 NSFW' : '取消 NSFW')
}

/** 批量评分 */
export function batchRating(rating) {
  return batchApplyFlags({ rating }, `评分 ${rating} 星`)
}
