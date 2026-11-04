import { computed, watch } from 'vue'
import {
  state,
  MODEL_TYPES,
  SUB_MAP,
  sortDirectional,
  effectiveModelHash,
  effectiveFavorite,
  effectiveNsfw,
  effectiveRating,
} from './state'
import { normalizeBaseModel } from '../../../shared/model-categories'
import { getPinyinSearchText, pinyinReady } from './pinyin'
import { matchSearchFilters, parseSearchQuery } from './search-query'

/**
 * 筛选/搜索/排序派生状态（A-04 自 appStore.js 拆出）。
 */

/** 中文排序比较器（模块级缓存，O1）：避免排序热路径每次比较都走完整 Intl 构造 */
const zhCollator = new Intl.Collator('zh-CN')

/**
 * 结构化搜索 token 的标注解析器（O7/P1-1）：score:/fav:/nsfw: 命中判定走
 * 标注覆盖层（即时标注后无需重扫即生效），与侧栏筛选/标注排序同一语义。
 */
const META_FLAG_RESOLVERS = {
  favorite: effectiveFavorite,
  nsfw: effectiveNsfw,
  rating: effectiveRating,
}

/** 分类固定顺序映射（模块级常量，O3）：避免按分类排序时每次重算都重建 */
const TYPE_ORDER = Object.fromEntries(MODEL_TYPES.map((t, i) => [t.key, i]))

/**
 * 模型添加时间（OPT-1「按添加时间」排序）：扫描层 ctimeMs 为文件创建时间
 * （下载/复制入盘时间）；旧本地索引快照或手工构造的对象无该字段时回退
 * 修改时间，保证存量数据可排序。
 * @param {Record<string, any>} m 模型对象
 * @returns {number} 添加时间（epoch ms）
 */
function addedMsOf(m) {
  return Number.isFinite(m.ctimeMs) && m.ctimeMs > 0 ? m.ctimeMs : m.mtimeMs
}

/**
 * 搜索域小写缓存（O3）：按模型对象引用记忆化的小写搜索域，覆盖文件名、
 * 备注名、备注、触发词、分类标签（含中文标签），以换行连接防止跨字段
 * 误匹配。模型对象仅在元数据更新/批量同步/重扫时被整体替换——替换后
 * 新对象自然缓存未命中并重建，未变更模型跨多次按键复用，避免每次搜索
 * 对全库每个模型重复调用 4~5 次 toLowerCase 与 SUB_MAP 查找。
 * F2 扩展：safetensors 自动解析信息（作者/基底模型/训练标签候选）一并
 * 纳入搜索域——数据在扫描装饰阶段已随模型对象携带，此前解析了却搜不到。
 */
const searchHaystackCache = new WeakMap()
/** 拼音搜索域缓存（FEAT-07）：按模型对象引用记忆化，与普通搜索域同一失效约定 */
const pinyinHaystackCache = new WeakMap()

/**
 * 模型的可搜索文本片段（普通搜索域与拼音域共用同一来源，顺序/字段一致）。
 * @param {Record<string, any>} m 模型对象
 * @returns {any[]} 字段片段（可能含空值，由调用方过滤）
 */
function searchParts(m) {
  // 基底模型取装饰层合成字段，兼容手工构造/旧数据仅带 autoInfo 的对象
  const parts = [
    m.name,
    m.alias,
    m.note,
    m.triggerWords,
    m.baseModel || m.autoInfo?.baseModel,
  ]
  // 自由标签纳入搜索域（F-5）："那个赛博朋克风格的 LoRA" 直达
  if (Array.isArray(m.tags)) parts.push(...m.tags)
  if (m.subCategory) {
    parts.push(m.subCategory)
    const info = SUB_MAP[m.subCategory]
    if (info) parts.push(info.label)
  }
  if (m.autoInfo) {
    // 作者与训练标签候选是内容检索的自然入口；基底模型已在 parts 中
    // （m.baseModel，safetensors 解析与 Civitai 回填双来源，F-2）
    parts.push(m.autoInfo.author, m.autoInfo.title)
    if (Array.isArray(m.autoInfo.triggerCandidates)) {
      parts.push(...m.autoInfo.triggerCandidates)
    }
  }
  return parts
}

/** 构建并缓存模型的合并小写搜索域 */
function searchHaystack(m) {
  let hay = searchHaystackCache.get(m)
  if (hay !== undefined) return hay
  hay = searchParts(m).filter(Boolean).join('\n').toLowerCase()
  searchHaystackCache.set(m, hay)
  return hay
}

/**
 * 构建并缓存模型的拼音搜索域（FEAT-07）：仅在拼音引擎就绪且模型含中文时
 * 生成；引擎未就绪不写缓存，加载完成后的下一次过滤会自然重建。
 * @param {Record<string, any>} m 模型对象
 * @returns {string} 全拼+首字母搜索域；不可用时为空串
 */
function pinyinHaystack(m) {
  if (!pinyinReady.value) return ''
  let hay = pinyinHaystackCache.get(m)
  if (hay !== undefined) return hay
  hay = getPinyinSearchText(searchParts(m).filter(Boolean).join('\n'))
  pinyinHaystackCache.set(m, hay)
  return hay
}

/** 含拉丁字母的查询才尝试拼音域（纯中文查询走普通子串即可） */
const LATIN_QUERY_RE = /[a-z]/i
/** 模糊子序列最短长度：过短会产生大量无关命中 */
const FUZZY_MIN_LENGTH = 3
/** 允许模糊匹配的 token 形态（英文/数字/常见连接符）；中文仍精确子串 */
const FUZZY_TOKEN_RE = /^[a-z0-9._-]+$/i

/**
 * 模糊子序列匹配：按顺序在搜索域中找齐字符（允许间隔）。
 * 例：`sdxl` 可命中 `stable diffusion xl`；`yguang` 可命中 `yueguang`。
 * @param {string} hay 小写搜索域
 * @param {string} token 小写查询 token
 * @returns {boolean}
 */
function fuzzySubsequence(hay, token) {
  let cursor = 0
  for (const ch of token) {
    const next = hay.indexOf(ch, cursor)
    if (next < 0) return false
    cursor = next + 1
  }
  return true
}

/**
 * 单 token 命中：先精确子串；英文/数字 token 长度达阈值时回退模糊子序列。
 * 中文 token 不做模糊，避免任意汉字顺序造成误命中。
 * @param {string} hay 小写搜索域
 * @param {string} token 小写查询 token
 * @returns {boolean}
 */
function tokenMatches(hay, token) {
  if (hay.includes(token)) return true
  if (token.length < FUZZY_MIN_LENGTH) return false
  if (!FUZZY_TOKEN_RE.test(token)) return false
  return fuzzySubsequence(hay, token)
}

/**
 * 查询命中判定：整串精确子串优先；含空格时按 token AND 匹配；
 * 单 token 支持英文/拼音模糊子序列（FEAT-07）。
 * @param {string} hay 小写搜索域
 * @param {string} keyword 小写查询文本
 * @returns {boolean}
 */
function keywordMatches(hay, keyword) {
  if (!keyword) return true
  if (hay.includes(keyword)) return true
  const tokens = keyword.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  return tokens.every((token) => tokenMatches(hay, token))
}

/**
 * 模型自由文本命中（FEAT-07）：普通搜索域优先；仅当查询含拉丁字母且
 * 普通域未命中时，再尝试拼音全拼/首字母域（引擎未就绪时自动降级）。
 * @param {Record<string, any>} m 模型对象
 * @param {string} keyword 小写查询文本
 * @returns {boolean}
 */
function keywordHit(m, keyword) {
  if (keywordMatches(searchHaystack(m), keyword)) return true
  if (!LATIN_QUERY_RE.test(keyword)) return false
  const py = pinyinHaystack(m)
  return py !== '' && keywordMatches(py, keyword)
}

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
  if (state.settings?.hideNsfwModels !== true) return state.models
  return state.models.filter((m) => !effectiveNsfw(m))
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
    const models = group.models.filter((m) => visibleIds.has(m.id))
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
      !matchSearchFilters(m, filters, effectiveModelHash, META_FLAG_RESOLVERS)
    )
      continue
    list.push(m)
  }
  return list
})

/** 筛选 + 搜索 + 排序后的模型列表（导出名与行为不变，仅内部分层） */
export const filteredModels = computed(() => {
  // 拷贝后排序：内层结果被 computed 缓存复用，不得原位变异
  const list = [...filteredUnsorted.value]
  switch (state.sortBy) {
    case 'size':
      list.sort((a, b) => b.size - a.size)
      break
    case 'mtime':
      list.sort((a, b) => b.mtimeMs - a.mtimeMs)
      break
    case 'added':
      // 按添加时间（OPT-1）：与 mtime 同一约定——比较器恒为「新在前」，
      // sortAsc=true 默认即最新入库在前，sortAsc=false 翻转为最早在前
      list.sort((a, b) => addedMsOf(b) - addedMsOf(a))
      break
    case 'favorite':
      // 收藏优先，同组内按名称（U2）；固定语义排序，不响应方向翻转（O1）。
      // P1-1：收藏态经标注覆盖层读取（即时标注后排序立即生效）
      list.sort(
        (a, b) =>
          (effectiveFavorite(b) ? 1 : 0) - (effectiveFavorite(a) ? 1 : 0) ||
          zhCollator.compare(a.name, b.name),
      )
      break
    case 'rating':
      // 评分高优先，同分按名称（U2）；固定语义排序，不响应方向翻转（O1）。
      // P1-1：评分经标注覆盖层读取
      list.sort(
        (a, b) =>
          effectiveRating(b) - effectiveRating(a) ||
          zhCollator.compare(a.name, b.name),
      )
      break
    case 'type':
      // 按分类排序：遵循固定分类顺序（Checkpoint → TextEncoders → VAE → LoRA → 其他），同分类内按名称
      list.sort(
        (a, b) =>
          TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
          zhCollator.compare(a.name, b.name),
      )
      break
    default:
      list.sort((a, b) => zhCollator.compare(a.name, b.name))
  }
  // 排序方向（U2）：sortAsc=false 时翻转当前结果；
  // 收藏优先/按评分为固定语义排序（收藏/高分恒在前），翻转会反转语义，故不响应（O1）
  if (!state.sortAsc && sortDirectional(state.sortBy)) list.reverse()
  // 重复筛选（FEAT-1）：按哈希稳定排序把同组模型聚拢为相邻块（组间无语义
  // 顺序），组内相对顺序保持上方排序结果——散落的同组文件会破坏「逐组清理」
  // 的浏览流。筛选语义下此排序随筛选开启/关闭自动生效与退出
  if (state.showDuplicatesOnly) {
    list.sort((a, b) => {
      const ha = effectiveModelHash(a)
      const hb = effectiveModelHash(b)
      return ha < hb ? -1 : ha > hb ? 1 : 0
    })
  }
  return list
})

/**
 * 全库自由标签使用计数（F4 标签管理面板数据源）：标签 -> 使用模型数。
 */
export const tagCounts = computed(() => {
  const counts = new Map()
  for (const m of state.models) {
    for (const t of m.tags || []) {
      counts.set(t, (counts.get(t) || 0) + 1)
    }
  }
  return counts
})

/**
 * 全库自由标签池（F-5）：按使用次数降序（同频按中文名稳定排序），上限 50——
 * 筛选下拉的数据源；标签由详情页编辑器维护，随元数据即时落盘。
 * O-4：先物化 [标签, 计数] 数组再排序——原实现在比较器内两次 tagCounts.get()
 * 查表，全库标签量级下把 Map 查找乘进比较次数。
 */
export const allTags = computed(() =>
  [...tagCounts.value.entries()]
    .sort((a, b) => b[1] - a[1] || zhCollator.compare(a[0], b[0]))
    .slice(0, 50)
    .map(([tag]) => tag),
)

/**
 * 当前可见模型的自由标签计数/标签池（OPT-03）：隐藏 NSFW 后筛选下拉不得
 * 出现「只属于隐藏模型、选中必为空」的标签。标签管理面板仍使用全库
 * tagCounts/allTags（需要能管理隐藏模型的标签）。
 */
export const visibleTagCounts = computed(() => {
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

/** 当前可见标签池（排序/上限与 allTags 一致） */
export const visibleTags = computed(() =>
  [...visibleTagCounts.value.entries()]
    .sort((a, b) => b[1] - a[1] || zhCollator.compare(a[0], b[0]))
    .slice(0, 50)
    .map(([tag]) => tag),
)

/**
 * 各分类的数量（可见模型口径，OPT-03）：隐藏 NSFW 后侧栏计数与列表命中
 * 范围一致。收藏/搜索条件不参与（切分类时计数保持稳定，避免数字闪烁）。
 */
export const typeCounts = computed(() => {
  const counts = { all: 0 }
  for (const m of visibleModels.value) {
    counts.all += 1
    counts[m.type] = (counts[m.type] || 0) + 1
  }
  return counts
})

// 切换主分类时清空 LoRA 子分类与基底模型筛选，避免残留条件
watch(
  () => state.typeFilter,
  () => {
    state.subFilter = ''
    state.baseFilter = ''
  },
)
