import { computed } from 'vue'
import { state } from '../state'
import { visibleModels } from './visibility'
import { zhCollator } from './collator'

/**
 * 标签计数与分类计数派生（O6 自 filter.js 拆出）：
 * 全库/可见口径的自由标签池与侧栏分类计数。
 */

/**
 * 全库自由标签使用计数（F4 标签管理面板数据源）：标签 -> 使用模型数。
 */
export const tagCounts = computed(() => {
  /** @type {Array<Record<string, any>>} */
  const models = state.models
  const counts = new Map()
  for (const m of models) {
    for (const t of m.tags || []) {
      counts.set(t, (counts.get(t) || 0) + 1)
    }
  }
  return counts
})

/**
 * 全库自由标签池（F-5）：按使用次数降序（同频按中文名稳定排序），不截断——
 * 标签管理（重命名/合并/移除）与可检索选择器的完整数据源；标签由详情页
 * 编辑器维护，随元数据即时落盘。筛选下拉的默认快选展示由消费方自行限制，
 * 避免把「库内标签存在但不可管理/不可检索」的状态固化在数据层。
 * O-4：先物化 [标签, 计数] 数组再排序——原实现在比较器内两次 tagCounts.get()
 * 查表，全库标签量级下把 Map 查找乘进比较次数。
 */
export const allTags = computed(() =>
  [...tagCounts.value.entries()]
    .sort((a, b) => b[1] - a[1] || zhCollator.compare(a[0], b[0]))
    .map(([tag]) => tag),
)

/**
 * 当前可见模型的自由标签计数/标签池（OPT-03）：隐藏 NSFW 后筛选下拉不得
 * 出现「只属于隐藏模型、选中必为空」的标签。标签管理面板仍使用全库
 * tagCounts/allTags（需要能管理隐藏模型的标签）。
 */
const visibleTagCounts = computed(() => {
  // 关闭隐藏开关时与全库计数完全一致，直接复用，避免多一遍 O(n)
  if (state.settings?.hideNsfwModels !== true) return tagCounts.value
  const counts = new Map()
  for (const m of visibleModels.value) {
    for (const t of m.tags || []) {
      counts.set(t, (counts.get(t) || 0) + 1)
    }
  }
  return counts
})

/** 当前可见标签池（排序口径与 allTags 一致，不截断；快选/检索由消费方处理） */
export const visibleTags = computed(() =>
  [...visibleTagCounts.value.entries()]
    .sort((a, b) => b[1] - a[1] || zhCollator.compare(a[0], b[0]))
    .map(([tag]) => tag),
)

/**
 * 各分类的数量（可见模型口径，OPT-03）：隐藏 NSFW 后侧栏计数与列表命中
 * 范围一致。收藏/搜索条件不参与（切分类时计数保持稳定，避免数字闪烁）。
 */
export const typeCounts = computed(() => {
  /** @type {{ all: number } & Record<string, number>} */
  const counts = { all: 0 }
  for (const m of visibleModels.value) {
    counts.all += 1
    counts[m.type] = (counts[m.type] || 0) + 1
  }
  return counts
})
