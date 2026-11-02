import { state } from '../state'
import { toast } from '../toast'
import { modelById } from '../selectors'

/**
 * 批量操作逐项失败明细（B20/F3）：
 * 各批量执行链路（标签/标记/文件/Civitai）在收尾时把逐项失败经
 * reportBatchFailures 整体替换写入 state.multiSelect.failures——
 * 失败项可定位（模型 + 真实原因）、可经 reselectFailedItems 重建选区
 * 后用既有批量动作重试；全成功时归 null（不弹面板，保持轻提示）。
 */

/**
 * 记录一次批量操作的逐项失败（整体替换，不叠加旧错误）。
 * @param {string} op 操作类型文案（如「批量评分」「批量删除」）
 * @param {Array<{id: string, error?: any}>} items 失败项（id + 主进程/IPC 真实原因）
 * @returns {number} 记录的失败数（0 时清空明细）
 */
export function reportBatchFailures(op, items) {
  const list = (Array.isArray(items) ? items : [])
    .filter((it) => it && typeof it.id === 'string' && it.id)
    .map((it) => {
      const m = modelById.value.get(it.id)
      // 名称在记录时快照：后续删除/改名后明细仍可读（id 可能已失效）
      const raw =
        typeof it.error === 'string'
          ? it.error
          : it.error?.message || String(it.error || '')
      return {
        id: it.id,
        name: m?.alias || m?.name || it.id,
        error: raw || '未知错误',
      }
    })
  state.multiSelect.failures =
    list.length > 0 ? { op, at: Date.now(), items: list } : null
  return list.length
}

/** 清空失败明细（手动关闭面板 / 切换模型库时调用） */
export function clearBatchFailures() {
  state.multiSelect.failures = null
}

/**
 * 按失败项重建选区（F3）：进入多选并只选中失败项中仍存在于当前库的
 * 模型（改名/删除/切库后的失效 id 自动剔除——不产生幻影选区），
 * 用户随后用批量栏的既有动作重试。
 * @returns {boolean} 是否重建成功（失败项全部失效时 false 并提示）
 */
export function reselectFailedItems() {
  const items = state.multiSelect.failures?.items || []
  if (items.length === 0) return false
  const byId = modelById.value
  const ids = items.filter((it) => byId.get(it.id)).map((it) => it.id)
  const missing = items.length - ids.length
  if (ids.length === 0) {
    toast('warn', '失败项已不在当前模型库中（可能已被删除/改名/切库）')
    return false
  }
  state.multiSelect.active = true
  state.multiSelect.ids = ids
  toast(
    'info',
    `已选中 ${ids.length} 个失败项，可在批量栏重试刚才的操作` +
      (missing > 0 ? `（${missing} 个已不在当前库，跳过）` : ''),
  )
  return true
}
