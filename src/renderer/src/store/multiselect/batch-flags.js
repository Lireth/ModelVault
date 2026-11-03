import { state } from '../state'
import { toast } from '../toast'
import { applyMetaFlagUpdates } from '../meta-apply'
import { reportBatchFailures, clearBatchFailures } from './batch-failures'
import { MAX_BATCH_META_IDS } from '../../../../shared/app-enums'

/**
 * 批量快捷标记（E6，C1 批量 IPC 改造）：
 * 收藏 / NSFW / 评分按 MAX_BATCH_META_IDS 分块，单次 IPC 提交整块
 * （主进程逐项校验后单次落盘调度）；返回成功项的有效三元组与逐项失败
 * 原因，渲染层单趟写入标注覆盖层并复用失败明细面板。
 *
 * 相比旧实现（每模型一次 invoke，并发 16）：万级选中时 IPC 往返从 N 次
 * 降到 ceil(N/5000) 次，回包从「每模型完整 meta」降为「有效三元组 +
 * 失败明细」，并发在途窗口与结构化克隆成本同步收敛。
 */

/**
 * 批量更新快捷标记（收藏/NSFW/评分）。
 * in-flight 防护（B6）：执行期间置 busy，批量操作栏按钮禁用，防止连点
 * 对同一批模型重复提交。
 * @param {Record<string, any>} patch { favorite?/nsfw?/rating? }
 * @param {string} label 完成提示文案（如「收藏」）
 */
async function batchApplyFlags(patch, label) {
  const ids = [...state.multiSelect.ids]
  if (ids.length === 0 || state.multiSelect.busy) return
  state.multiSelect.busy = true
  clearBatchFailures()
  try {
    const metaMap = new Map()
    // B20/F3：逐项失败保留真实原因（IPC 异常 message 或主进程 error 文案）
    const failures = []

    for (let offset = 0; offset < ids.length; offset += MAX_BATCH_META_IDS) {
      const chunk = ids.slice(offset, offset + MAX_BATCH_META_IDS)
      let res
      try {
        res = await window.api.models.setMetaFlagsBulk({
          ids: chunk,
          ...patch,
        })
      } catch (err) {
        for (const id of chunk) failures.push({ id, error: err.message })
        continue
      }
      if (res?.error) {
        for (const id of chunk) failures.push({ id, error: res.error })
        continue
      }

      const updated = Array.isArray(res?.updated) ? res.updated : []
      const updatedIds = new Set()
      for (const item of updated) {
        if (!item || typeof item.id !== 'string') continue
        updatedIds.add(item.id)
        metaMap.set(item.id, item)
      }
      const failed = Array.isArray(res?.failed) ? res.failed : []
      const failedIds = new Set()
      for (const item of failed) {
        if (!item || typeof item.id !== 'string') continue
        failedIds.add(item.id)
        failures.push({
          id: item.id,
          error: item.error || '未返回失败原因',
        })
      }
      // 契约防御：既未成功也未显式失败的条目必须显形，不得静默丢失
      for (const id of chunk) {
        if (!updatedIds.has(id) && !failedIds.has(id)) {
          failures.push({ id, error: '未返回结果' })
        }
      }
    }

    const ok = applyMetaFlagUpdates(metaMap)
    const fail = reportBatchFailures(`批量${label}`, failures)
    if (fail === 0) toast('success', `已为 ${ok} 个模型${label}`)
    else
      toast(
        'warn',
        `${label}完成：成功 ${ok} 个，失败 ${fail} 个（可展开下方失败明细重试）`,
      )
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
