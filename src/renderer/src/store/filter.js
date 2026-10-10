import { computed, watch } from 'vue'
import { state, MODEL_TYPES, SUB_MAP, sortDirectional } from './state'
import { isApplyingView } from './views'

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
  hay = parts
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
  searchHaystackCache.set(m, hay)
  return hay
}

/** 筛选 + 搜索 + 排序后的模型列表 */
export const filteredModels = computed(() => {
  const keyword = state.search.trim().toLowerCase()
  const { typeFilter, subFilter, showFavoritesOnly, dirFilter } = state
  // LoRA 分类筛选：仅选中 LoRA 分类且指定了子分类时生效
  const checkSub = typeFilter === 'lora' && subFilter
  // 目录筛选（B-01）：选中目录及其全部后代
  const inDir = (m) => {
    if (!dirFilter) return true
    const rel = typeof m.relDir === 'string' ? m.relDir : ''
    return rel === dirFilter || rel.startsWith(`${dirFilter}/`)
  }
  // 单趟完成目录/分类/子分类/收藏/关键词过滤（O3）：合并原四段 filter，
  // 消除中间数组分配；无筛选条件时仅做一次遍历拷贝
  const list = []
  for (const m of state.models) {
    if (typeFilter !== 'all' && m.type !== typeFilter) continue
    if (checkSub && m.subCategory !== subFilter) continue
    if (showFavoritesOnly && !m.favorite) continue
    if (!inDir(m)) continue
    if (keyword && !searchHaystack(m).includes(keyword)) continue
    list.push(m)
  }
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
  return list
})

/**
 * 各分类的数量（含全部）：直接从模型列表派生，删除/新增后自动同步。
 * B-01：激活目录筛选时计数限定在该目录子树内，侧栏分类计数与网格结果同口径；
 * 收藏/搜索条件不参与（切分类时计数保持稳定，避免侧栏数字闪烁）。
 */
export const typeCounts = computed(() => {
  const counts = { all: 0 }
  const { dirFilter } = state
  for (const m of state.models) {
    if (dirFilter) {
      const rel = typeof m.relDir === 'string' ? m.relDir : ''
      if (rel !== dirFilter && !rel.startsWith(`${dirFilter}/`)) continue
    }
    counts.all += 1
    counts[m.type] = (counts[m.type] || 0) + 1
  }
  return counts
})

// 切换主分类时清空 LoRA 子分类筛选，避免残留条件。
// B-02：标签页切换是整体换入字段（目标视图可能自带 lora 子分类），
// 期间的 typeFilter 变化不得触发清空（isApplyingView 守卫）
watch(
  () => state.typeFilter,
  () => {
    if (!isApplyingView()) state.subFilter = ''
  }
)
