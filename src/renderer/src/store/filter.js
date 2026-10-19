import { computed, watch } from 'vue'
import { state, MODEL_TYPES, SUB_MAP, sortDirectional } from './state'

/**
 * 筛选/搜索/排序派生状态（A-04 自 appStore.js 拆出）。
 */

/** 中文排序比较器（模块级缓存，O1）：避免排序热路径每次比较都走完整 Intl 构造 */
const zhCollator = new Intl.Collator('zh-CN')

/** 分类固定顺序映射（模块级常量，O3）：避免按分类排序时每次重算都重建 */
const TYPE_ORDER = Object.fromEntries(MODEL_TYPES.map((t, i) => [t.key, i]))

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

/** 构建并缓存模型的合并小写搜索域 */
function searchHaystack(m) {
  let hay = searchHaystackCache.get(m)
  if (hay !== undefined) return hay
  const parts = [m.name, m.alias, m.note, m.triggerWords]
  if (m.subCategory) {
    parts.push(m.subCategory)
    const info = SUB_MAP[m.subCategory]
    if (info) parts.push(info.label)
  }
  if (m.autoInfo) {
    // 作者与基底模型是高频检索词（"那个 SDXL 的 LoRA 在哪"）；
    // 训练标签候选（ss_tag_frequency 高频词）是内容检索的自然入口
    parts.push(m.autoInfo.author, m.autoInfo.baseModel, m.autoInfo.title)
    if (Array.isArray(m.autoInfo.triggerCandidates)) {
      parts.push(...m.autoInfo.triggerCandidates)
    }
  }
  hay = parts
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
  searchHaystackCache.set(m, hay)
  return hay
}

/**
 * 重复模型分组（FEAT-1，F9 闭环）：按文件 SHA256 分组，仅保留成员数 > 1 的组。
 * 哈希来源两路：扫描装饰携带（缓存命中，decorate.js 已随模型下发）+ 后台预热
 * 完成事件回填（library.applyHashUpdate，渐进可用无需重扫）。同哈希文件大小
 * 必然一致，组内可释放空间 = (成员数 - 1) × 单文件大小。
 */
export const duplicateGroups = computed(() => {
  const byHash = new Map()
  for (const m of state.models) {
    if (!m.hash) continue
    const list = byHash.get(m.hash)
    if (list) list.push(m)
    else byHash.set(m.hash, [m])
  }
  const groups = []
  for (const [hash, models] of byHash) {
    if (models.length > 1) {
      groups.push({ hash, models, wastedBytes: models[0].size * (models.length - 1) })
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

/** 冗余副本可释放空间合计（各组 wastedBytes 之和） */
export const duplicateWastedBytes = computed(() =>
  duplicateGroups.value.reduce((sum, g) => sum + g.wastedBytes, 0)
)

/**
 * 筛选 + 搜索后的未排序列表（过滤层，模块私有）。
 * 与排序分层缓存（P4 性能优化）：切换排序方式/方向时本层 computed 命中缓存，
 * 跳过全量 O(n) 过滤与搜索域匹配，仅重排即可。
 * 单趟完成分类/子分类/收藏/重复/关键词过滤（O3）：合并原多段 filter，
 * 消除中间数组分配；无筛选条件时仅做一次遍历拷贝。
 */
const filteredUnsorted = computed(() => {
  const keyword = state.search.trim().toLowerCase()
  const { typeFilter, subFilter, showFavoritesOnly, showDuplicatesOnly } = state
  // LoRA 分类筛选：仅选中 LoRA 分类且指定了子分类时生效
  const checkSub = typeFilter === 'lora' && subFilter
  // 重复筛选仅在开启时读取命中集合（关闭路径零额外开销）
  const dupes = showDuplicatesOnly ? duplicateIdSet.value : null
  const list = []
  for (const m of state.models) {
    if (typeFilter !== 'all' && m.type !== typeFilter) continue
    if (checkSub && m.subCategory !== subFilter) continue
    if (showFavoritesOnly && !m.favorite) continue
    if (dupes && !dupes.has(m.id)) continue
    if (keyword && !searchHaystack(m).includes(keyword)) continue
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
    case 'favorite':
      // 收藏优先，同组内按名称（U2）；固定语义排序，不响应方向翻转（O1）
      list.sort(
        (a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || zhCollator.compare(a.name, b.name)
      )
      break
    case 'rating':
      // 评分高优先，同分按名称（U2）；固定语义排序，不响应方向翻转（O1）
      list.sort((a, b) => b.rating - a.rating || zhCollator.compare(a.name, b.name))
      break
    case 'type':
      // 按分类排序：遵循固定分类顺序（Checkpoint → TextEncoders → VAE → LoRA → 其他），同分类内按名称
      list.sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || zhCollator.compare(a.name, b.name))
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
    list.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
  }
  return list
})

/**
 * 各分类的数量（含全部）：直接从模型列表派生，删除/新增后自动同步。
 * 收藏/搜索条件不参与（切分类时计数保持稳定，避免侧栏数字闪烁）。
 */
export const typeCounts = computed(() => {
  const counts = { all: 0 }
  for (const m of state.models) {
    counts.all += 1
    counts[m.type] = (counts[m.type] || 0) + 1
  }
  return counts
})

// 切换主分类时清空 LoRA 子分类筛选，避免残留条件
watch(
  () => state.typeFilter,
  () => {
    state.subFilter = ''
  }
)
