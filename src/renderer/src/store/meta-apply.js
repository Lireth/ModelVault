import { state, modelIndexOf, setMetaOverride } from './state'

/**
 * 主进程元数据结果应用到本地模型列表的共享工具（A-04 自 appStore.js 拆出）。
 * 仅依赖 state，供单模型操作与封面/批量操作复用。
 */

/** 从主进程规范化 meta 提取快捷标注三元组（覆盖层写入的统一形状） */
function flagsFromMeta(meta) {
  return {
    favorite: meta.favorite === true,
    nsfw: meta.nsfw === true,
    rating: meta.rating || 0,
  }
}

/**
 * 将快捷标注（收藏/NSFW/评分）同步到覆盖映射（O7/P1-1）：
 * 不再整体替换元素——元素替换会使 filteredModels（大库含 O(n log n) 排序）、
 * typeCounts/tagCounts/duplicateGroups 等全量派生失效重算，并使搜索域
 * WeakMap 缓存随对象换身失效；覆盖写入只让真正依赖标注的读取方（收藏筛选、
 * 标注排序、星标/模糊展示、标注 token）失效重算，且单卡片展示按覆盖键
 * 精确重渲染。模型对象保持引用稳定；持久化由调用方的 IPC 完成，重扫后
 * 对象自带权威值与覆盖自然一致。
 * @param {string} id 模型绝对路径
 * @param {Record<string, any>|null} meta 主进程返回的完整元数据
 */
export function applyMetaFlags(id, meta) {
  if (!meta || modelIndexOf(id) === undefined) return
  setMetaOverride(id, flagsFromMeta(meta))
}

/**
 * 单趟批量同步快捷标注到覆盖映射（O2/O7）：批量标记（batch-flags）专用
 * ——与单模型 toggle 同走覆盖层，保证收藏/NSFW/评分三字段单一来源，
 * 避免批量元素替换与单点覆盖互相盖出陈旧值。
 * @param {Map<string, object>} metaMap id → 主进程返回的最新元数据
 * @returns {number} 实际更新的模型数量（列表中不存在的 id 不计入）
 */
export function applyMetaFlagUpdates(metaMap) {
  if (!metaMap || metaMap.size === 0) return 0
  let updated = 0
  for (const [id, meta] of metaMap) {
    if (modelIndexOf(id) === undefined) continue
    setMetaOverride(id, flagsFromMeta(meta))
    updated += 1
  }
  return updated
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
