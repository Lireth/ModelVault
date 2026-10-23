import { state, replaceModels, modelIndexOf } from './state'
import { toast, confirmDialog } from './toast'
import { applyMetaFlags } from './meta-apply'
import { openDetail } from './detail'
import { openTransferToLibrary } from './transfer'

/**
 * 单模型文件操作、即时标注、自由标签（F-5）、右键菜单
 * （A-04 自 appStore.js 拆出）。
 */

/**
 * 整体覆写模型自由标签（F-5，即时落盘）：
 * 详情页标签编辑器每次增删提交全量列表；成功后同步本地列表元素
 * （浅响应约定：元素级整体替换，触发卡片角标与筛选池更新）。
 * @param {string} id 模型 id
 * @param {string[]} tags 全量标签列表
 * @returns {Promise<boolean>} 是否保存成功（失败已 toast）
 */
export async function setModelTags(id, tags) {
  let res
  try {
    res = await window.api.models.setModelTags(id, tags)
  } catch (err) {
    toast('error', `标签保存失败: ${err.message}`)
    return false
  }
  if (res?.error) {
    toast('error', res.error)
    return false
  }
  const next = res?.meta?.tags || []
  // O2：走 state 的 id→下标索引（O(1)），不再全表 findIndex
  const idx = modelIndexOf(id)
  if (idx !== undefined) {
    state.models[idx] = { ...state.models[idx], tags: next }
  }
  return true
}

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
  // O2：存在性判定走 id 索引；移除后仍按约定整体替换数组
  if (modelIndexOf(id) !== undefined) {
    // O3 约定：整体替换须经 replaceModels（保持数组代理，元素级更新才可触发）
    replaceModels(state.models.filter((m) => m.id !== id))
  }
  if (state.selectedId === id) state.selectedId = null
  if (!opts.silent) toast('success', '模型已移入回收站')
  return true
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
    const idx = modelIndexOf(id)
    const next = !(idx !== undefined && state.models[idx].favorite)
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
      const idx = modelIndexOf(id)
      if (idx === undefined) break
      const m = state.models[idx]
      if (!(await confirmDialog(`确定将「${m.alias || m.name}」移入系统回收站吗？可稍后在设置-最近删除中恢复。`))) break
      await deleteModel(id)
      break
    }
    case 'transferToLibrary': {
      // 跨库移动/复制（F-3）：打开目标库选择层
      openTransferToLibrary([id])
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
 * 重命名模型文件（N1）：name 为不含扩展名的新文件名。
 * 扩展名由主进程保留；同名 sidecar 一并改名，元数据键即时迁移。
 * 成功后关闭当前详情并整表重扫（文件 id 已变化）。
 * @param {string} id 模型 id
 * @param {string} name 新文件名（不含扩展名）
 * @returns {Promise<boolean>} 是否完成重命名
 */
export async function renameModel(id, name) {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (!trimmed) {
    toast('warn', '请输入新的文件名')
    return false
  }
  if (state.scanning || state.partialScanning || state.importing) {
    toast('warn', '正在扫描、增量刷新或导入中，请稍候')
    return false
  }
  let res
  try {
    res = await window.api.models.renameModel(id, trimmed)
  } catch (err) {
    toast('error', `重命名失败: ${err.message}`)
    return false
  }
  if (res?.canceled) return false
  if (res?.error) {
    toast('error', res.error)
    return false
  }
  if (res?.path === id) {
    toast('info', '文件名未变化')
    return true
  }
  const warnings = Array.isArray(res?.sidecarWarnings) ? res.sidecarWarnings : []
  if (warnings.length > 0) {
    toast('warn', `已重命名为「${trimmed}」，但 ${warnings.length} 个 sidecar 未迁移`)
  } else {
    toast('success', `已重命名为「${trimmed}」`)
  }
  // 文件 id 已变化：关闭当前详情，整表重扫收敛新文件名
  state.selectedId = null
  await refreshAfterFileChange()
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

/**
 * F2：导入外部模型文件（复制/移动入台）。
 * 主进程完成文件搬运后，对目标子树执行局部扫描，让新模型即时入列。
 * @param {'copy'|'move'} mode 复制或移动
 * @returns {Promise<boolean>} 是否成功导入至少一个模型
 */
export async function importModels(mode = 'copy') {
  if (state.importing) return false
  if (state.scanning || state.partialScanning || state.backgroundScanning) {
    toast('warn', '正在扫描或校验中，请稍候')
    return false
  }
  state.importing = true
  try {
    const res = await window.api.models.importModels(mode)
    if (res?.canceled) return false
    if (res?.error) {
      toast('error', res.error)
      return false
    }
    const imported = Number.isFinite(res?.imported) ? res.imported : 0
    const renamed = Number.isFinite(res?.renamed) ? res.renamed : 0
    const failed = Array.isArray(res?.failed) ? res.failed : []
    if (imported === 0) {
      toast(
        'warn',
        failed.length > 0 ? `导入失败：${failed[0].error}` : '没有导入任何模型'
      )
      return false
    }
    const parts = [`已${mode === 'move' ? '移动' : '复制'}入台 ${imported} 个模型`]
    if (renamed > 0) parts.push(`重命名 ${renamed} 个`)
    if (failed.length > 0) parts.push(`${failed.length} 个失败`)
    if (Array.isArray(res.warnings) && res.warnings.length > 0) {
      parts.push(`${res.warnings.length} 个 sidecar 警告`)
    }
    toast(failed.length > 0 ? 'warn' : 'success', parts.join('，'))
    // 先释放导入标记，再触发局部扫描（扫描/全量回退不应被导入互斥拦截）
    state.importing = false
    // 目标子树局部扫描（F1/O3 的增量链）；根目录导入传空串（仅根直属文件）
    const { partialScanModels } = await import('./partial-scan')
    await partialScanModels([res.targetRelDir ?? ''])
    return true
  } catch (err) {
    toast('error', `导入失败: ${err.message}`)
    return false
  } finally {
    state.importing = false
  }
}

/** 文件改名/移动后的列表刷新：文件 id 已变，整表重扫是最可靠的收敛方式 */
async function refreshAfterFileChange() {
  const { scanModels } = await import('./library')
  await scanModels()
}
