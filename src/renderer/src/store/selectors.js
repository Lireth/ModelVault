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
