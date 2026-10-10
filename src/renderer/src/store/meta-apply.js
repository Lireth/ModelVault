import { state } from './state'

/**
 * 主进程元数据结果应用到本地模型列表的共享工具（A-04 自 appStore.js 拆出）。
 * 仅依赖 state，供单模型操作与封面/批量操作复用。
 */

/** 将快捷标记同步到本地模型列表 */
export function applyMetaFlags(id, meta) {
  const idx = state.models.findIndex((m) => m.id === id)
  if (idx >= 0) {
    state.models[idx] = {
      ...state.models[idx],
      favorite: meta.favorite === true,
      nsfw: meta.nsfw === true,
      rating: meta.rating || 0
    }
  }
}

/**
 * 单趟批量同步本地模型状态（O2）：先收集全部 IPC 结果构建 id→meta Map，
 * 再一次性遍历 state.models 就位替换。替代「逐个 findIndex + 逐个元素替换」
 * ——后者在批量场景下造成 O(n×m) 查找，且每个元素替换都使 filteredModels
 * 失效（大库下每次重算含 O(n log n) 排序）；单趟写入保证同一时钟周期内
 * 完成全部变更，filteredModels 仅重算一次。
 * @param {Map<string, object>} metaMap id → 主进程返回的最新元数据
 * @param {(meta: object) => object} pick 从 meta 提取需合并到模型对象的字段
 * @returns {number} 实际更新的模型数量（列表中不存在的 id 不计入）
 */
export function applyMetaUpdates(metaMap, pick) {
  if (metaMap.size === 0) return 0
  let updated = 0
  for (let i = 0; i < state.models.length; i++) {
    const meta = metaMap.get(state.models[i].id)
    if (!meta) continue
    state.models[i] = { ...state.models[i], ...pick(meta) }
    updated += 1
    if (updated === metaMap.size) break
  }
  return updated
}
