import { computed, watch } from 'vue'
import {
  state,
  effectiveModelHash,
  effectiveFavorite,
  effectiveNsfw,
  effectiveRating,
} from '../state'
import { normalizeBaseModel } from '../../../../shared/model-categories'
import { matchSearchFilters, parseSearchQuery } from '../search-query'
import { keywordHit } from './search'
import { visibleModels, duplicateIdSet } from './visibility'
import { buildSortOrder, sortKeyOf } from './sorting'

/**
 * 筛选→排序管线（O6 自 filter.js 拆出）：过滤层（单趟分类/搜索/结构化
 * token 匹配）与排序结果缓存（PERF-SORT 复用判定 + 下标物化）。
 */

/**
 * 结构化搜索 token 的标注解析器（O7/P1-1）：score:/fav:/nsfw: 命中判定走
 * 标注覆盖层（即时标注后无需重扫即生效），与侧栏筛选/标注排序同一语义。
 */
const META_FLAG_RESOLVERS = {
  favorite: effectiveFavorite,
  nsfw: effectiveNsfw,
  rating: effectiveRating,
}

/**
 * 筛选 + 搜索后的未排序列表（过滤层，模块私有）。
 * 与排序分层缓存（P4 性能优化）：切换排序方式/方向时本层 computed 命中缓存，
 * 跳过全量 O(n) 过滤与搜索域匹配，仅重排即可。
 * 单趟完成分类/子分类/收藏/重复/关键词过滤（O3）：合并原多段 filter，
 * 消除中间数组分配；无筛选条件时仅做一次遍历拷贝。
 */
const filteredUnsorted = computed(() => {
  // F3 高级语法：结构化 token（base:/tag:/size:>1gb…）与自由关键词由
  // search-query 解析拆分；token 与侧栏筛选叠加（AND），自由关键词沿用
  // 既有「合并搜索域子串包含」语义。token 命中判定不依赖搜索域 haystack
  const { text, filters } = parseSearchQuery(state.search)
  const keyword = text.toLowerCase()
  const hasFilters = filters.length > 0
  const {
    typeFilter,
    subFilter,
    baseFilter,
    tagFilters,
    showFavoritesOnly,
    showDuplicatesOnly,
    showSuspectOnly,
  } = state
  // LoRA 分类筛选：仅选中 LoRA 分类且指定了子分类时生效
  const checkSub = typeFilter === 'lora' && subFilter
  // 基底模型家族筛选（F-2）：归一化比较（autoInfo 解析 + Civitai 回填双来源
  // 已在装饰层合成为 m.baseModel）；未解析基底（''）不命中任何家族
  const checkBase = baseFilter
  // 自由标签筛选（F-5/FEAT-01）：数组内全部标签同时存在才命中（AND）
  const checkTags = Array.isArray(tagFilters) ? tagFilters : []
  // 重复筛选仅在开启时读取命中集合（关闭路径零额外开销）
  const dupes = showDuplicatesOnly ? duplicateIdSet.value : null
  // F4 dup: 解析器：仅当查询含 dup token 时才读取重复集合；闭包在循环外
  // 复用，避免结构化搜索时逐模型分配函数
  const isDuplicate =
    /** @param {Record<string, any>} model */
    (model) => duplicateIdSet.value.has(model.id)
  const list = []
  // 隐藏 NSFW 模型（设置开关）：统一从 visibleModels 取数（标注覆盖层与
  // 模型自带标记均经 effectiveNsfw 计入）；关闭路径直接复用 state.models
  for (const m of visibleModels.value) {
    // 疑似损坏筛选（FEAT-01）：只保留装饰阶段标记 suspect 的模型
    if (showSuspectOnly && m.suspect !== true) continue
    if (typeFilter !== 'all' && m.type !== typeFilter) continue
    if (checkSub && m.subCategory !== subFilter) continue
    if (
      checkBase &&
      normalizeBaseModel(m.baseModel || m.autoInfo?.baseModel || '') !==
        checkBase
    )
      continue
    if (checkTags.length > 0) {
      const tags = m.tags || []
      if (!checkTags.every((t) => tags.includes(t))) continue
    }
    if (showFavoritesOnly && !effectiveFavorite(m)) continue
    if (dupes && !dupes.has(m.id)) continue
    if (keyword && !keywordHit(m, keyword)) continue
    if (
      hasFilters &&
      !matchSearchFilters(
        m,
        filters,
        effectiveModelHash,
        META_FLAG_RESOLVERS,
        isDuplicate,
      )
    )
      continue
    list.push(m)
  }
  return list
})

/**
 * 上一次排序的有序下标缓存（PERF-SORT）：列表内容未变时复用排序结果。
 * 缓存只保存「排序当时的 id 顺序与键快照」的标量数组（不保留模型对象，
 * 避免跨库切换/重扫后缓存把上一代模型对象滞留成额外内存），逐项比对
 * 判定「能否复用」；仅当真正发生重排（筛选集合/排序键/排序方式变化）才
 * 重算。模型对象被整体替换但键值一致（封面/详情补全/缩略图回填等高频
 * 场景）同样命中复用，物化时取当前数组的新对象，展示不会陈旧。
 * @type {{order: number[], ids: string[], keys: Array<number|string>,
 *   hashes: string[]|null, sortBy: string, sortAsc: boolean,
 *   duplicates: boolean}|null}
 */
let sortCache = null

/**
 * 上次排序结果能否整体复用：排序方式/方向/重复聚拢配置一致，且当前数组
 * 逐项 id 与排序键快照一致。要求 id 逐项相同（而非集合相同），保证稳定
 * 排序下相等键的输入顺序不变——复用结果与重新排序完全等价。
 * @param {Array<Record<string, any>>} src 当前未排序数组
 * @param {string} sortBy 排序方式 key
 * @param {boolean} sortAsc 排序方向
 * @param {boolean} showDuplicatesOnly 是否按哈希聚拢
 * @returns {boolean} 可复用返回 true
 */
function canReuseSort(src, sortBy, sortAsc, showDuplicatesOnly) {
  const cached = sortCache
  if (
    !cached ||
    cached.sortBy !== sortBy ||
    cached.sortAsc !== sortAsc ||
    cached.duplicates !== showDuplicatesOnly ||
    cached.order.length !== src.length
  ) {
    return false
  }
  for (let i = 0; i < src.length; i++) {
    const cur = src[i]
    // src 为密集数组且长度已与缓存比对一致，!cur 分支不可达，仅收窄类型
    if (!cur) return false
    if (cached.ids[i] !== cur.id) return false
    // 与「排序当时的键快照」比较：favorite/rating/哈希经可变覆盖映射读取，
    // 对象引用不变也可能变化，不能在比较时重新读取两侧（会互相抵消）
    if (cached.keys[i] !== sortKeyOf(cur, sortBy)) return false
    if (showDuplicatesOnly) {
      const hash = effectiveModelHash(cur)
      // cached.duplicates === showDuplicatesOnly 已在上方校验：hashes 必非 null
      if (cached.hashes?.[i] !== hash) return false
    }
  }
  return true
}

/** 筛选 + 搜索 + 排序后的模型列表（导出名与行为不变，仅内部分层） */
export const filteredModels = computed(() => {
  const src = filteredUnsorted.value
  const sortBy = state.sortBy
  const sortAsc = Boolean(state.sortAsc)
  const showDuplicatesOnly = Boolean(state.showDuplicatesOnly)
  let order
  // canReuseSort 内部要求缓存非 null 才可能返回 true：先取局部 const 供
  // TS 跟踪收窄（同一同步帧内 sortCache 不会被改写，判定结果不变）
  const cached = sortCache
  if (cached && canReuseSort(src, sortBy, sortAsc, showDuplicatesOnly)) {
    // PERF-SORT：排序结果未变——按下标物化当前数组（元素可能已被整体替换），
    // 跳过 O(n log n) 的中文 Collator 比较
    order = cached.order
  } else {
    const built = buildSortOrder(src, sortBy, sortAsc, showDuplicatesOnly)
    order = built.order
    sortCache = {
      order,
      ids: built.ids,
      keys: built.keys,
      hashes: built.hashes,
      sortBy,
      sortAsc,
      duplicates: showDuplicatesOnly,
    }
  }
  // 物化：内层结果被 computed 缓存复用，不得原位变异
  const list = new Array(order.length)
  // order 为 0..n-1 的排列且 i < order.length：order[i] 必然有效，cast 仅收窄类型
  for (let i = 0; i < order.length; i++)
    list[i] = src[/** @type {number} */ (order[i])]
  return list
})

// 切换主分类时清空 LoRA 子分类与基底模型筛选，避免残留条件
watch(
  () => state.typeFilter,
  () => {
    state.subFilter = ''
    state.baseFilter = ''
  },
)
