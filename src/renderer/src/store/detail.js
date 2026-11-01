import { computed } from 'vue'
import { state } from './state'
import { modelById } from './selectors'
import { filteredModels } from './filter'
import { confirmDialog } from './toast'

/**
 * 模型详情的打开/关闭与当前选中模型派生（A-04 自 appStore.js 拆出）。
 */

/** 当前选中的模型对象 */
export const selectedModel = computed(
  () => modelById.value.get(state.selectedId) || null,
)

/**
 * 当前详情在筛选结果中的位置（FEA-01 序列导航）：
 * 导航跟随用户当前的浏览上下文（筛选 + 排序后的列表），逐个审阅标注时
 * ‹ › 与「12 / 348」位置指示共用此派生；当前模型不在列表内（筛选变化/
 * 已删除）时 index 为 -1，导航与指示一并隐藏。
 */
export const detailPosition = computed(() => {
  const list = filteredModels.value
  const index = state.selectedId
    ? list.findIndex((m) => m.id === state.selectedId)
    : -1
  return { index, total: list.length }
})

/**
 * 打开筛选结果中当前模型的相邻模型（FEA-01，offset ±1）：
 * 逐个审阅/标注的核心工作流——此前每看完一个必须 ESC 关闭 → 回网格 →
 * 点击下一个。跳转复用 openDetail 内建的脏表单确认（C8）：未保存修改
 * 先确认放弃再切换；组件保持挂载，fillForm 重填后 detailDirty 自愈。
 * 端点（首个/末个）与当前模型不在列表内时为 no-op（按钮由位置派生禁用）。
 * @param {1|-1} offset 方向
 */
export async function openAdjacentDetail(offset) {
  const list = filteredModels.value
  if (list.length === 0) return
  const index = state.selectedId
    ? list.findIndex((m) => m.id === state.selectedId)
    : -1
  if (index === -1) return
  const adjacent = list[index + offset]
  if (!adjacent) return
  await openDetail(adjacent.id)
}

/**
 * 打开模型详情。表单有未保存的修改时先确认放弃（C8）；
 * 重复点击当前已选卡片不触发确认。
 * @param {string} id 模型 id（文件绝对路径）
 */
export async function openDetail(id) {
  if (state.detailDirty && state.selectedId !== id) {
    if (!(await confirmDialog('当前模型有未保存的修改，放弃修改并切换？')))
      return
  }
  state.selectedId = id
  // 后台预热该模型的 SHA256（Civitai 识别加速）：主进程优先入队并立即
  // 计算，用户随后点击识别时哈希多半已缓存。火后不管，失败静默
  window.api.models.warmupHash(id).catch(() => {})
}

/**
 * 静默清除当前详情选中（FIX-9）：删除/重命名等操作使模型消失或 id 变化、
 * 详情被强制关闭时调用。此时 MetaForm 已随详情卸载
 * （ModelDetail 的 v-if="selectedModel"），其 formDirty watcher 不会再
 * 写回——只清 selectedId 会残留 detailDirty=true，下一次 openDetail
 * 误弹「放弃修改」确认（幽灵确认框）。openDetail 的切换路径不受影响：
 * 组件未卸载，fillForm 重填后 formDirty 归零自愈。
 */
export function clearSelectedModel() {
  state.selectedId = null
  state.detailDirty = false
}

/** 关闭模型详情。表单有未保存的修改时先确认放弃（C8/U4） */
export async function closeDetail() {
  if (
    state.detailDirty &&
    !(await confirmDialog('当前模型有未保存的修改，放弃修改并关闭？'))
  ) {
    return
  }
  // 用户已明确放弃修改：关闭时同步清脏（FIX-9），与强制关闭同一出口
  clearSelectedModel()
}
