import { reactive } from 'vue'
import { toast } from './toast'

/**
 * 模型对比（FN-03）：
 * 多选 2~6 个模型后并排展示推荐参数、触发词、基底、标签等字段。
 * 只保存 id 快照——打开期间列表刷新/重排不改变对比对象；关闭即释放。
 */

export const COMPARE_MAX_MODELS = 6

export const compareState = reactive({
  open: false,
  ids: [],
})

/**
 * 打开对比视图。
 * @param {string[]} ids 参与对比的模型 id
 * @returns {boolean} 是否打开
 */
export function openCompare(ids) {
  const list = (Array.isArray(ids) ? ids : []).filter(
    (id) => typeof id === 'string' && id,
  )
  if (list.length < 2) {
    toast('warn', '请至少选择 2 个模型进行对比')
    return false
  }
  if (list.length > COMPARE_MAX_MODELS) {
    toast('warn', `最多同时对比 ${COMPARE_MAX_MODELS} 个模型`)
    return false
  }
  compareState.ids = [...new Set(list)].slice(0, COMPARE_MAX_MODELS)
  compareState.open = true
  return true
}

/** 关闭对比视图 */
export function closeCompare() {
  compareState.open = false
  compareState.ids = []
}
