import { computed } from 'vue'
import { state } from './state'
import { modelById } from './selectors'
import { confirmDialog } from './toast'

/**
 * 模型详情的打开/关闭与当前选中模型派生（A-04 自 appStore.js 拆出）。
 */

/** 当前选中的模型对象 */
export const selectedModel = computed(() => modelById.value.get(state.selectedId) || null)

/**
 * 打开模型详情。表单有未保存的修改时先确认放弃（C8）；
 * 重复点击当前已选卡片不触发确认。
 * @param {string} id 模型 id（文件绝对路径）
 */
export async function openDetail(id) {
  if (state.detailDirty && state.selectedId !== id) {
    if (!(await confirmDialog('当前模型有未保存的修改，放弃修改并切换？'))) return
  }
  state.selectedId = id
}

/** 关闭模型详情。表单有未保存的修改时先确认放弃（C8/U4） */
export async function closeDetail() {
  if (state.detailDirty && !(await confirmDialog('当前模型有未保存的修改，放弃修改并关闭？'))) {
    return
  }
  state.selectedId = null
}
