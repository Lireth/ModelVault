import { computed } from 'vue'
import { state } from './state'

/**
 * 跨域复用的模型查找派生状态（A-04）。
 */

/**
 * modelById 的复用缓存（O4 收尾，PERF-3 同款哲学）：
 * - cachedModelsRef 为当前 models 数组引用：整体替换（replaceModels——
 *   切库/重扫/批量同步的数组级入口）时全量重建；
 * - 元素级替换（收藏/评分/标签/封面回填等 `state.models[i] = {...}`）时
 *   id 与位置不变、对象引用更新——仅把值变化的键同步进同一个 Map 实例，
 *   哈希表本体零重建（跳过 O(n) 条目分配与重哈希），消除「每次标注点击
 *   都全量重建数千条目 Map」的剩余热点。
 * 约定依赖与 state.js 的 modelIndexById 相同：models 数组禁止 splice/push
 * 等原位变异（违反该约定时 modelIndexById 的下标错位更严重，非本缓存新增
 * 风险）；同引用下条目只会被替换、不会被移除，故增量同步不产生陈旧键。
 */
let cachedModelsRef = null
let cachedById = new Map()

/**
 * id → 模型对象映射（O4）：selectedModel、多选选区等按 id 查找的场景 O(1)
 * 命中，替代每次全表 find。
 *
 * 返回轻量查询包装而非 Map 本体（全部消费方仅使用 .get，已核查）：
 * Vue 3.4+ 的 computed 以 Object.is 判定值是否变化并决定是否向下游传播，
 * 直接返回稳定 Map 实例会让 selectedModel 等下游派生拿不到「元素已更新」
 * 的重算信号（读到旧对象，响应传播回归测试即失败）。包装每次重算新建，
 * 仅为一个闭包方法，开销相比旧实现的整表 Map 重建可忽略。
 */
export const modelById = computed(() => {
  const models = state.models
  if (models !== cachedModelsRef) {
    cachedModelsRef = models
    cachedById = new Map()
    for (let i = 0; i < models.length; i++) {
      cachedById.set(models[i].id, models[i])
    }
  } else {
    for (let i = 0; i < models.length; i++) {
      const m = models[i]
      if (cachedById.get(m.id) !== m) cachedById.set(m.id, m)
    }
  }
  return { get: (id) => cachedById.get(id) }
})
