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
  // O3 约定：浅响应下原位 splice 不触发更新，须整体替换数组
  if (idx >= 0) state.models = state.models.filter((m) => m.id !== id)
  if (state.selectedId === id) state.selectedId = null
  if (!opts.silent) toast('success', '模型已移入回收站')
  return true
}

/**
 * 导出当前（筛选后）模型列表到文件（E2）。
 * in-flight 防重（O7）：导出含保存对话框与整列表 IPC，期间连点会重复
 * 弹窗/重复写盘——busy 期间入口直接拦截。
 * @param {'csv'} format 导出格式
 */
let exporting = false
export async function exportModels(format) {
  if (exporting) return
  const list = filteredModels.value
  if (list.length === 0) {
    toast('warn', '当前列表为空，无可导出的模型')
    return
  }
  exporting = true
  try {
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
      relDir: m.relDir || '',
      covers: Array.isArray(m.covers) ? m.covers.length : 0,
      // F4 扩列：基底模型/作者来自 safetensors 自动解析，随行携带
      autoInfo:
        m.autoInfo
          ? { baseModel: m.autoInfo.baseModel || '', author: m.autoInfo.author || '' }
          : null,
      // params 来自 reactive state，是 Proxy；Electron IPC 结构化序列化不支持
      // Proxy，直接传会抛 "An object could not be cloned"，需拷贝为普通对象
      params: m.params ? { ...m.params } : null
    }))
    const res = await window.api.models.exportList({ format, rows })
    if (res.canceled) return
    if (res.error) {
      toast('error', res.error)
      return
    }
    toast('success', `已导出 ${res.count} 个模型：${res.path}`)
  } catch (err) {
    toast('error', `导出失败: ${err.message}`)
  } finally {
    exporting = false
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
    case 'disableModel':
      await toggleDisabledModel(id, true)
      break
    case 'enableModel':
      await toggleDisabledModel(id, false)
      break
    case 'moveModel':
      await moveModelTo(id)
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

/* ---------------- 文件操作（批次 4：禁用/移动/哈希） ---------------- */

/**
 * 加/去 .disabled 后缀（F10）：成功后重扫刷新列表（文件 id 已变；
 * watcher 自动重扫开启时也会触发，手动重扫兜底 autoRescan 关闭的场景）
 * @param {string} id 模型 id
 * @param {boolean} disabled 目标状态
 */
export async function toggleDisabledModel(id, disabled) {
  let res
  try {
    res = await window.api.models.toggleDisabled(id, disabled)
  } catch (err) {
    toast('error', `禁用/启用失败: ${err.message}`)
    return false
  }
  if (res?.error) {
    toast('error', res.error)
    return false
  }
  toast('success', disabled ? '已禁用（文件名加 .disabled 后缀，绘画工具不再加载）' : '已启用')
  if (!state.scanning) await refreshAfterFileChange()
  return true
}

/**
 * 库内移动模型（F11）：目标目录经主进程原生对话框选择，
 * 元数据随键迁移，成功后重扫刷新
 * @param {string} id 模型 id
 */
export async function moveModelTo(id) {
  let res
  try {
    res = await window.api.models.moveModelTo(id)
  } catch (err) {
    toast('error', `移动失败: ${err.message}`)
    return false
  }
  if (res?.canceled) return false
  if (res?.error) {
    toast('error', res.error)
    return false
  }
  toast('success', `已移动到 ${res.path}`)
  if (!state.scanning) await refreshAfterFileChange()
  return true
}

/** 文件改名/移动后的列表刷新：文件 id 已变，整表重扫是最可靠的收敛方式 */
async function refreshAfterFileChange() {
  const { scanModels } = await import('./library')
  await scanModels()
}
