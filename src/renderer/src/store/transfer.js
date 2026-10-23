import { computed, reactive } from 'vue'
import { state } from './state'
import { toast } from './toast'

/**
 * 跨库移动/复制（F-3，自 appStore 按域拆分的独立小仓库）：
 * 库选择浮层状态与传输编排。目标库列表来自已保存库（settings.modelsFolders
 * 去掉当前库）；传输经主进程 models:transferToLibrary（保持相对路径与元数据
 * 关联），成功后整表重扫收敛（move 模式源 id 已变化）。
 */

export const transferState = reactive({
  /** 选择浮层可见性 */
  visible: false,
  /** 待传输的当前库模型绝对路径 */
  ids: [],
  /** 传输模式：'copy' 复制（源不动）/ 'move' 移动（成功后清理源） */
  mode: 'copy',
  /** 传输进行中（浮层确认按钮防连点） */
  busy: false
})

/** 可选目标库：已保存库列表去掉当前库 */
export const transferTargets = computed(() =>
  (state.settings.modelsFolders || []).filter(
    (f) => typeof f === 'string' && f && f !== state.folder
  )
)

/** 库名显示（目录名；盘符根回退完整路径） */
export function targetDisplayName(folder) {
  const norm = String(folder || '').replace(/[\\/]+$/, '')
  const base = norm.split(/[\\/]/).pop()
  return base || norm
}

/**
 * 打开跨库传输浮层（右键菜单/批量操作入口）。
 * @param {string[]|string} ids 单个模型路径或路径数组
 */
export function openTransferToLibrary(ids) {
  const list = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && x) : [ids]
  if (list.length === 0) return
  if (transferTargets.value.length === 0) {
    toast('info', '当前只有这一个模型库，请先在侧栏添加其他模型库')
    return
  }
  transferState.ids = list
  // 批量默认复制（安全），单模型默认移动（整理语义）
  transferState.mode = list.length > 1 ? 'copy' : 'move'
  transferState.visible = true
}

/** 关闭浮层（传输进行中不可关闭） */
export function closeTransfer() {
  if (transferState.busy) return
  transferState.visible = false
  transferState.ids = []
}

/**
 * 确认传输到目标库：调主进程链路并汇总反馈，成功后整表重扫。
 * @param {string} targetRoot 目标库根目录（浮层选择）
 */
export async function confirmTransfer(targetRoot) {
  if (!targetRoot || transferState.busy || transferState.ids.length === 0) return
  transferState.busy = true
  try {
    const res = await window.api.models.transferToLibrary({
      ids: transferState.ids,
      targetRoot,
      mode: transferState.mode
    })
    if (res?.error) {
      toast('error', res.error)
      return
    }
    const verb = res.mode === 'move' ? '移动' : '复制'
    const parts = []
    if (res.transferred > 0) parts.push(`${verb} ${res.transferred} 个`)
    if (res.skipped?.length > 0) parts.push(`跳过 ${res.skipped.length} 个`)
    if (res.failed?.length > 0) parts.push(`失败 ${res.failed.length} 个`)
    if (res.transferred > 0) {
      toast(res.failed?.length > 0 ? 'warn' : 'success', `跨库传输完成：${parts.join('，')}`)
    } else {
      toast('info', `未传输任何模型：${parts.join('，') || '无可用项'}`)
    }
    transferState.visible = false
    transferState.ids = []
    // move 模式源 id 已变化、copy 后目标库待扫描：整表重扫收敛
    if (!state.scanning && !state.partialScanning && !state.importing) {
      const { scanModels } = await import('./library')
      await scanModels()
    }
  } catch (err) {
    toast('error', `跨库传输失败: ${err.message}`)
  } finally {
    transferState.busy = false
  }
}
