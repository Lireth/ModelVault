import { state } from './state'
import { toast, confirmDialog } from './toast'
import { partialScanModels } from './partial-scan'

/**
 * 应用内整理（B-06）渲染层状态与动作：
 * - 库内目录列举 / 新建 / 重命名（重命名后局部增量扫描刷新）；
 * - 模型文件移动到目标文件夹（多选栏入口 / 侧栏目录树拖拽），主进程迁移
 *   元数据键后返回装饰结果，本地就地替换列表条目；
 * - 失联标注（A-02 无法自动关联的孤儿）与无标注新模型的手动绑定。
 */

/** 目录展示名（'' 根目录） */
function dirDisplayName(dir) {
  if (!dir) return '根目录'
  const segs = dir.split('/')
  return segs[segs.length - 1]
}

/** 用装饰后的新条目就地替换列表中的旧 id 条目（保持原索引，避免网格跳动） */
function replaceModelEntry(oldId, model) {
  const idx = state.models.findIndex((m) => m.id === oldId)
  if (idx >= 0) state.models.splice(idx, 1, model)
  else state.models.push(model)
}

/** 打开整理面板（可带入选中的待移动模型）并加载目录/缺口数据 */
export async function openOrganize(ids = []) {
  state.organize.open = true
  state.organize.pendingIds = Array.isArray(ids) ? [...ids] : []
  state.organize.targetDir = ''
  await Promise.all([refreshOrganizeDirs(), loadMetaGaps()])
}

/** 关闭整理面板 */
export function closeOrganize() {
  state.organize.open = false
  state.organize.pendingIds = []
  state.organize.targetDir = ''
}

/** 设置移动目标目录（目录树点击） */
export function setOrganizeTargetDir(dir) {
  state.organize.targetDir = typeof dir === 'string' ? dir : ''
}

/** 重新拉取库内目录列表（新建/重命名/移动后同步空目录可见性） */
export async function refreshOrganizeDirs() {
  try {
    const res = await window.api.models.listDirs()
    if (res?.error) {
      toast('error', res.error)
      return
    }
    state.organize.dirs = Array.isArray(res.dirs) ? res.dirs : []
  } catch (err) {
    toast('error', `目录列表加载失败: ${err.message}`)
  }
}

/** 加载失联标注 / 无标注新模型缺口 */
export async function loadMetaGaps() {
  state.organize.gapsLoading = true
  try {
    const res = await window.api.models.metaGaps(state.models.map((m) => m.id))
    if (res?.error) {
      toast('error', res.error)
      return
    }
    state.organize.orphans = Array.isArray(res.orphans) ? res.orphans : []
    state.organize.newcomers = Array.isArray(res.newcomers) ? res.newcomers : []
  } catch (err) {
    toast('error', `失联标注查询失败: ${err.message}`)
  } finally {
    state.organize.gapsLoading = false
  }
}

/** 新建文件夹（FolderTree 内联输入提交） */
export async function createOrganizeFolder({ parentDir, name } = {}) {
  const relDir = parentDir ? `${parentDir}/${name}` : name
  try {
    const res = await window.api.models.createFolder(relDir)
    if (res?.error) {
      toast('error', res.error)
      return false
    }
    toast('success', `已新建文件夹「${name}」`)
    await refreshOrganizeDirs()
    return true
  } catch (err) {
    toast('error', `新建文件夹失败: ${err.message}`)
    return false
  }
}

/** 重命名文件夹：主进程迁移元数据键后，对新旧子树做局部增量扫描 */
export async function renameOrganizeFolder({ dir, newName } = {}) {
  try {
    const res = await window.api.models.renameFolder(dir, newName)
    if (res?.error) {
      toast('error', res.error)
      return false
    }
    if (state.organize.targetDir === dir) state.organize.targetDir = res.newDir
    toast('success', `文件夹已重命名${res.moved ? `，${res.moved} 条标注已随迁` : ''}`)
    await Promise.all([
      partialScanModels([res.oldDir, res.newDir]),
      refreshOrganizeDirs()
    ])
    return true
  } catch (err) {
    toast('error', `重命名失败: ${err.message}`)
    return false
  }
}

/**
 * 移动模型到库内目标文件夹的公共实现：
 * 确认 → IPC → 本地条目替换/选区联动/目录与缺口刷新。
 * @param {string[]} ids 模型绝对路径
 * @param {string} dir 目标 POSIX 相对目录（'' 根目录）
 * @param {{clearPending?: boolean}} [opts]
 */
export async function moveModelsToDir(ids, dir, opts = {}) {
  const list = Array.isArray(ids) ? [...new Set(ids.filter(Boolean))] : []
  if (list.length === 0) return false
  if (state.scanning) {
    toast('warn', '正在扫描中，请稍候')
    return false
  }
  const targetName = dirDisplayName(dir)
  const confirmed = await confirmDialog(
    list.length === 1
      ? `确定将该模型移动到「${targetName}」吗？同名标注与封面会随文件迁移。`
      : `确定将选中的 ${list.length} 个模型移动到「${targetName}」吗？同名标注与封面会随文件迁移。`
  )
  if (!confirmed) return false

  state.organize.busy = true
  try {
    const res = await window.api.models.moveModels({ ids: list, destDir: dir })
    if (res?.error) {
      toast('error', res.error)
      return false
    }
    const moved = Array.isArray(res.moved) ? res.moved : []
    const idMap = new Map()
    for (const { from, model } of moved) {
      replaceModelEntry(from, model)
      idMap.set(from, model.id)
    }
    // 多选选区跟随迁移后的新 id（被移动条目仍保持选中）
    if (state.multiSelect.ids.length > 0) {
      state.multiSelect.ids = state.multiSelect.ids.map((id) => idMap.get(id) || id)
    }
    // 详情若打开在被移动模型上则关闭（路径已变更，避免脏表单回填旧路径）
    if (state.selectedId && idMap.has(state.selectedId)) state.selectedId = null
    // 待移动清单剔除成功项
    state.organize.pendingIds = state.organize.pendingIds.filter(
      (id) => !idMap.has(id)
    )

    const failed = Array.isArray(res.failed) ? res.failed : []
    if (failed.length === 0) {
      toast('success', `已移动 ${moved.length} 个模型到「${targetName}」`)
    } else {
      toast('warn', `移动完成：成功 ${moved.length} 个，失败 ${failed.length} 个（${failed[0].error}）`)
    }

    // 目录树（可能新建了目标目录）与失联缺口都需刷新
    await Promise.all([refreshOrganizeDirs(), loadMetaGaps()])
    if (opts.clearPending !== false) state.organize.pendingIds = []
    return moved.length > 0
  } catch (err) {
    toast('error', `移动失败: ${err.message}`)
    return false
  } finally {
    state.organize.busy = false
  }
}

/** 整理面板内：把待移动模型移到当前选中的目标目录 */
export function movePendingToTarget() {
  return moveModelsToDir(state.organize.pendingIds, state.organize.targetDir)
}

/**
 * 侧栏目录树拖拽归位（B-06）：移动后保持面板关闭态（拖拽发生在主界面）。
 * @param {string[]} ids 拖拽携带的模型 id（多选时为整个选区）
 * @param {string} dir 目标目录
 */
export function moveIdsToDir(ids, dir) {
  return moveModelsToDir(ids, dir, { clearPending: false })
}

/** 手动绑定失联标注到无标注新模型 */
export async function bindGap(oldKey, newKey) {
  if (!oldKey || !newKey) return false
  try {
    const res = await window.api.models.bindMeta(oldKey, newKey)
    if (res?.error) {
      toast('error', res.error)
      return false
    }
    if (res.model) {
      replaceModelEntry(res.model.id, res.model)
      state.organize.orphans = state.organize.orphans.filter((o) => o.key !== oldKey)
      state.organize.newcomers = state.organize.newcomers.filter((n) => n.key !== newKey)
      toast('success', '标注已绑定到所选模型')
      return true
    }
    return false
  } catch (err) {
    toast('error', `绑定失败: ${err.message}`)
    return false
  }
}
