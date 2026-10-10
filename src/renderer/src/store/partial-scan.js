import { state } from './state'
import { toast } from './toast'
import { scanModels } from './library'

/**
 * 局部增量扫描（A-03，watcher 变更子树驱动，A-04 自 appStore.js 拆出）。
 */

/**
 * 判断模型的相对目录是否落在变更子树集合内。
 * @param {string} relDir 模型相对目录（'' 为根直属）
 * @param {string[]} dirs 变更子树（POSIX，'' 为根直属）
 */
function isRelDirAffected(relDir, dirs) {
  return dirs.some((d) =>
    d === '' ? relDir === '' : relDir === d || relDir.startsWith(`${d}/`)
  )
}

/**
 * 局部增量扫描：只重扫 watcher 检出的变更子树，主进程返回这些子树的模型现状，
 * 渲染层就地合并——子树外的模型列表完全不动（零 IPC 载荷、零重排），
 * 不进入全屏扫描遮罩（局部扫描通常很快），成本从全库 O(n) 降为变更量。
 * dirs 为空时回退全量扫描（防御异常载荷）。
 * @param {string[]} dirs 变更子树相对路径
 */
export async function partialScanModels(dirs) {
  const normalizedDirs = Array.isArray(dirs)
    ? dirs.filter((d) => typeof d === 'string').map((d) => d.trim())
    : []
  if (normalizedDirs.length === 0) {
    return scanModels()
  }
  if (!state.folder) return
  try {
    const res = await window.api.models.partialScan({ folder: state.folder, dirs: normalizedDirs })
    if (res.canceled) return
    if (res.error) {
      // 局部失败保守降级为全量扫描，保证最终与磁盘一致
      toast('warn', '增量刷新失败，已改为完整扫描')
      return scanModels()
    }
    const incoming = Array.isArray(res.models) ? res.models : []
    const incomingIds = new Set(incoming.map((m) => m.id))
    const removedIds = []

    // 未受影响子树的旧模型原样保留；受影响的模型以局部扫描结果为准
    const untouched = state.models.filter((m) => {
      if (!isRelDirAffected(m.relDir || '', normalizedDirs)) return true
      if (incomingIds.has(m.id)) return false
      removedIds.push(m.id)
      return false
    })
    state.models = untouched.concat(incoming)
    state.lastScan = {
      count: state.models.length,
      durationMs: res.durationMs
    }

    // 联动收敛：多选选区与打开的详情若指向已消失模型，同步清理
    if (state.multiSelect.ids.length > 0) {
      const removedSet = new Set(removedIds)
      state.multiSelect.ids = state.multiSelect.ids.filter((id) => !removedSet.has(id))
    }
    if (state.selectedId && removedIds.includes(state.selectedId)) {
      state.selectedId = null
      state.detailDirty = false
    }

    if (res.relinked > 0) {
      toast('success', `已自动重新关联 ${res.relinked} 个移动/重命名模型的标注`)
    }
  } catch (err) {
    toast('error', `增量刷新失败: ${err.message}`)
  }
}
