import { state, modelIndexOf } from './state'

/**
 * 主进程元数据结果应用到本地模型列表的共享工具（A-04 自 appStore.js 拆出）。
 * 仅依赖 state，供单模型操作与封面/批量操作复用。
 */

/** 将快捷标记同步到本地模型列表 */
export function applyMetaFlags(id, meta) {
  // O2：走 id→下标索引（O(1)），收藏/评分等高频标注不再全表扫描
  const idx = modelIndexOf(id)
  if (idx !== undefined) {
    state.models[idx] = {
      ...state.models[idx],
      favorite: meta.favorite === true,
      nsfw: meta.nsfw === true,
      rating: meta.rating || 0,
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
 * @param {(meta: Record<string, any>, current?: Record<string, any>) => Record<string, any>} pick 从 meta 提取需
 *   合并到模型对象的字段；第二参数为当前模型对象（F-2：baseModel 回填的
 *   「本地已有值优先」合并需要读取现值）
 * @returns {number} 实际更新的模型数量（列表中不存在的 id 不计入）
 */
export function applyMetaUpdates(metaMap, pick) {
  if (metaMap.size === 0) return 0
  let updated = 0
  for (let i = 0; i < state.models.length; i++) {
    const meta = metaMap.get(state.models[i].id)
    if (!meta) continue
    state.models[i] = { ...state.models[i], ...pick(meta, state.models[i]) }
    updated += 1
    if (updated === metaMap.size) break
  }
  return updated
}

/**
 * 有界并发映射（OPT-09）：按固定数量 worker 流式消费任务，
 * 返回值形状与 Promise.allSettled 一致并保持输入顺序，便于批量操作
 * 复用同一套成功/失败汇总逻辑，同时避免万级选中瞬间发起万级 IPC/文件句柄。
 * @template T
 * @param {T[]} items 待处理项
 * @param {(item: T, index: number) => Promise<any>} worker 单项处理器
 * @param {number} [limit] 最大并发数（默认 16）
 * @returns {Promise<Array<{status: 'fulfilled', value: any} | {status: 'rejected', reason: any}>>}
 */
export async function mapWithConcurrency(items, worker, limit = 16) {
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return []
  const concurrency = Math.max(1, Math.min(limit, list.length))
  const results = new Array(list.length)
  let next = 0
  async function runner() {
    for (;;) {
      const index = next++
      if (index >= list.length) return
      try {
        results[index] = {
          status: 'fulfilled',
          value: await worker(list[index], index),
        }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => runner()))
  return results
}
