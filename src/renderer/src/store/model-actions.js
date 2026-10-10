import { state } from './state'
import { toast, confirmDialog } from './toast'
import { applyMetaFlags } from './meta-apply'
import { filteredModels } from './filter'
import { openDetail } from './detail'

/**
 * 单模型文件操作、即时标注、右键菜单、列表导出（A-04 自 appStore.js 拆出）。
 */

/**
 * 在资源管理器中显示模型文件。
 * @param {string} modelPath 模型文件绝对路径（模型对象的 id 字段即绝对路径，可直接传入）
 */
export async function revealModel(modelPath) {
  let res
  try {
    res = await window.api.models.reveal(modelPath)
  } catch (err) {
    toast('error', `打开所在文件夹失败: ${err.message}`)
    return
  }
  if (res?.error) toast('error', res.error)
}

/**
 * 删除模型文件（移入系统回收站）并从本地列表移除。
 * @param {string} id 模型 id
 * @param {{silent?: boolean}} [opts] silent=true 时不弹成功提示（批量删除用，E4）
 */
export async function deleteModel(id, opts = {}) {
  let res
  try {
    res = await window.api.models.deleteModel(id)
  } catch (err) {
    toast('error', `删除模型失败: ${err.message}`)
    return false
  }
  if (res?.error) {
    toast('error', res.error)
    return false
  }
  const idx = state.models.findIndex((m) => m.id === id)
  if (idx >= 0) state.models.splice(idx, 1)
  if (state.selectedId === id) state.selectedId = null
  if (!opts.silent) toast('success', '模型已移入回收站')
  return true
}

/**
 * 导出当前（筛选后）模型列表到文件（E2）。
 * @param {'csv'|'json'} format 导出格式
 */
export async function exportModels(format) {
  const list = filteredModels.value
  if (list.length === 0) {
    toast('warn', '当前列表为空，无可导出的模型')
    return
  }
  const rows = list.map((m) => ({
    id: m.id,
    name: m.name,
    alias: m.alias || '',
    type: m.type,
    subCategory: m.subCategory || '',
    favorite: m.favorite === true,
    nsfw: m.nsfw === true,
    rating: m.rating || 0,
    triggerWords: m.triggerWords || '',
    note: m.note || '',
    size: m.size,
    mtimeMs: m.mtimeMs,
    params: m.params || null
  }))
  try {
    const res = await window.api.models.exportList({ format, rows })
    if (res.canceled) return
    if (res.error) {
      toast('error', res.error)
      return
    }
    toast('success', `已导出 ${res.count} 个模型：${res.path}`)
  } catch (err) {
    toast('error', `导出失败: ${err.message}`)
  }
}

/**
 * 即时标注操作（收藏/NSFW/评分）按模型串行队列（A5）：
 * toggleFavorite 需先读当前值再发 IPC，IPC 在途窗口内再次点击会读到
 * 同一旧值、发出相同目标值，表现为「第二次点击失效」。同一模型的标注
 * 操作经此队列依次执行——后一次必读到前一次经 applyMetaFlags 落定的
 * 状态；不同模型的键不同，互不阻塞。前一次失败不阻塞后续操作。
 */
const metaFlagChains = new Map()

function enqueueMetaFlag(id, task) {
  const prev = metaFlagChains.get(id)
  // 空闲时任务同步执行（保持单击原有的同步 IPC 时序）；
  // 有在途任务时才入队等它落定后执行（此时推迟一个微任务是必需的）
  const next = prev ? prev.then(task, task) : task()
  // 队列静止后清理条目，避免 Map 随模型数量无限增长
  next
    .catch(() => {})
    .finally(() => {
      if (metaFlagChains.get(id) === next) metaFlagChains.delete(id)
    })
  metaFlagChains.set(id, next)
  return next
}

/**
 * 切换收藏状态（即时落盘，不弹提示；同一模型的操作串行，A5）。
 * IPC reject 时 toast 提示（A6）。
 * @param {string} id 模型 id
 */
export function toggleFavorite(id) {
  return enqueueMetaFlag(id, async () => {
    const m = state.models.find((x) => x.id === id)
    const next = !m?.favorite
    let res
    try {
      res = await window.api.models.setMetaFlags({ id, favorite: next })
    } catch (err) {
      toast('error', `收藏操作失败: ${err.message}`)
      return false
    }
    if (res?.error) {
      toast('error', res.error)
      return false
    }
    if (res.meta) applyMetaFlags(id, res.meta)
    return true
  })
}

/**
 * 设置 NSFW 标记（即时落盘，同一模型的操作串行，A5）：勾选后首页卡片预览图模糊展示。
 * @param {string} id 模型 id
 * @param {boolean} nsfw 是否 NSFW
 */
export function setNsfw(id, nsfw) {
  return enqueueMetaFlag(id, async () => {
    const res = await window.api.models.setMetaFlags({ id, nsfw })
    if (res?.error) {
      toast('error', res.error)
      return false
    }
    if (res.meta) applyMetaFlags(id, res.meta)
    return true
  })
}

/**
 * 设置评分（0-5 整数，即时落盘，同一模型的操作串行，A5）。
 * @param {string} id 模型 id
 * @param {number} rating 评分
 */
export function setRating(id, rating) {
  return enqueueMetaFlag(id, async () => {
    const res = await window.api.models.setMetaFlags({ id, rating })
    if (res?.error) {
      toast('error', res.error)
      return false
    }
    if (res.meta) applyMetaFlags(id, res.meta)
    return true
  })
}

/**
 * 弹出模型右键菜单（主进程原生菜单）。
 * @param {string} id 模型 id
 */
export async function showContextMenu(id) {
  let res
  try {
    res = await window.api.models.popupMenu(id)
  } catch (err) {
    toast('error', `打开右键菜单失败: ${err.message}`)
    return
  }
  if (res?.error) toast('error', res.error)
}

/**
 * 处理主进程右键菜单回传的动作。
 * @param {string} id 模型 id
 * @param {string} action 动作标识
 */
export async function handleMenuAction(id, action) {
  switch (action) {
    case 'openDetail':
      openDetail(id)
      break
    case 'toggleFavorite':
      await toggleFavorite(id)
      break
    case 'deleteModel': {
      const m = state.models.find((x) => x.id === id)
      if (!m) break
      if (!(await confirmDialog(`确定将「${m.alias || m.name}」移入系统回收站吗？`))) break
      await deleteModel(id)
      break
    }
    default:
      break
  }
}
