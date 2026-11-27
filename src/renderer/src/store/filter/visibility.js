import { computed } from 'vue'
import { state, effectiveModelHash, effectiveNsfw } from '../state'

/**
 * 可见性与重复分组派生（O6 自 filter.js 拆出）：
 * NSFW 隐藏统一谓词/可见列表，与按 SHA256 聚合的全库/可见重复分组。
 */

/**
 * 模型是否在当前视图中可见（OPT-03 统一谓词）：
 * 隐藏 NSFW 开关开启时，经标注覆盖层的 effectiveNsfw 判定；关闭时恒可见。
 * 所有「浏览/筛选/计数」派生统一走本谓词或 visibleModels，避免侧栏数字、
 * 标签池、重复分组与列表命中范围不一致。
 * @param {Record<string, any>} m 模型对象
 * @returns {boolean}
 */
export function isModelVisible(m) {
  return !(state.settings?.hideNsfwModels === true && effectiveNsfw(m))
}

/** 当前可见模型列表（隐藏 NSFW 时过滤；关闭时直接复用原数组，零额外分配） */
export const visibleModels = computed(() => {
  /** @type {Array<Record<string, any>>} */
  const models = state.models
  if (state.settings?.hideNsfwModels !== true) return models
  return models.filter((m) => !effectiveNsfw(m))
})

/**
 * 全库重复模型分组（供统计页使用，包含隐藏的 NSFW 模型）：
 * 按文件 SHA256 分组，仅保留成员数 > 1 的组。哈希来源两路：扫描装饰携带
 * （缓存命中，decorate.js 已随模型下发）+ 后台预热完成事件回填
 * （library.applyHashUpdate，渐进可用无需重扫）。同哈希文件大小必然一致，
 * 组内可释放空间 = (成员数 - 1) × 单文件大小。
 */
export const allDuplicateGroups = computed(() => {
  const byHash = new Map()
  for (const m of state.models) {
    // O7：后台预热回填走独立覆盖映射，模型对象保持引用稳定
    const hash = effectiveModelHash(m)
    if (!hash) continue
    const list = byHash.get(hash)
    if (list) list.push(m)
    else byHash.set(hash, [m])
  }
  const groups = []
  for (const [hash, models] of byHash) {
    if (models.length > 1) {
      groups.push({
        hash,
        models,
        wastedBytes: models[0].size * (models.length - 1),
      })
    }
  }
  return groups
})

/**
 * 当前可见重复分组：从全库分组按可见成员重新收敛。
 * 组内仅剩 1 个可见成员时不再构成「可见重复」，因此不能只过滤整组，
 * 必须按成员过滤后重新判定 > 1；wastedBytes 也按可见副本重算。
 */
export const duplicateGroups = computed(() => {
  if (state.settings?.hideNsfwModels !== true) return allDuplicateGroups.value
  const visibleIds = new Set(visibleModels.value.map((m) => m.id))
  const groups = []
  for (const group of allDuplicateGroups.value) {
    const models = group.models.filter(
      /** @param {Record<string, any>} m */
      (m) => visibleIds.has(m.id),
    )
    if (models.length > 1) {
      groups.push({
        hash: group.hash,
        models,
        wastedBytes: models[0].size * (models.length - 1),
      })
    }
  }
  return groups
})

/** 重复组内全部模型 id 集合（O4：筛选与卡片角标 O(1) 命中） */
export const duplicateIdSet = computed(() => {
  const set = new Set()
  for (const g of duplicateGroups.value) {
    for (const m of g.models) set.add(m.id)
  }
  return set
})

/** 当前可见冗余副本可释放空间合计（各组 wastedBytes 之和） */
export const duplicateWastedBytes = computed(() =>
  duplicateGroups.value.reduce((sum, g) => sum + g.wastedBytes, 0),
)

/** 全库冗余副本可释放空间合计（统计页口径，包含隐藏的 NSFW 模型） */
export const allDuplicateWastedBytes = computed(() =>
  allDuplicateGroups.value.reduce((sum, g) => sum + g.wastedBytes, 0),
)
