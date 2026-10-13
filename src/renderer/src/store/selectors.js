import { computed } from 'vue'
import { state } from './state'

/**
 * 跨域复用的模型查找派生状态（A-04）。
 */

/**
 * id → 模型对象映射（O4）：selectedModel、多选选区等按 id 查找的场景 O(1)
 * 命中，替代每次全表 find。模型对象引用仅在元数据更新/批量同步/重扫时替换，
 * 缩略图回填（Object.assign 就地合并）不失效本映射。
 */
export const modelById = computed(() => new Map(state.models.map((m) => [m.id, m])))

/**
 * 完全重复模型的 id 集合（F9 去重筛选）：按「SHA256 + 字节数」分组，
 * 仅保留成员 ≥2 的组（字节数参与组键防极端哈希碰撞）。
 * 依赖各模型 hash 字段——批算完成经 applyHashUpdates 就地替换后自动重算。
 */
export const dupeIdSet = computed(() => {
  const byKey = new Map()
  for (const m of state.models) {
    if (!m.hash) continue
    const key = `${m.hash}:${m.size}`
    const group = byKey.get(key) || []
    group.push(m.id)
    byKey.set(key, group)
  }
  const dupes = new Set()
  for (const ids of byKey.values()) {
    if (ids.length < 2) continue
    for (const id of ids) dupes.add(id)
  }
  return dupes
})

/**
 * 重复组成员数映射（F9 卡片角标「重复 ×N」）：id → 组内成员数
 */
export const dupeCountById = computed(() => {
  const counts = new Map()
  for (const m of state.models) {
    if (!m.hash) continue
    const key = `${m.hash}:${m.size}`
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  const byId = new Map()
  for (const m of state.models) {
    if (!m.hash) continue
    const n = counts.get(`${m.hash}:${m.size}`)
    if (n > 1) byId.set(m.id, n)
  }
  return byId
})
