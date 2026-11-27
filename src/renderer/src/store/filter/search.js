import { watch } from 'vue'
import { state, SUB_MAP } from '../state'
import { getPinyinSearchText, pinyinReady } from '../pinyin'

/**
 * 搜索域构建与拼音预构建（O6 自 filter.js 拆出）：
 * 合并搜索域缓存（WeakMap 按模型对象引用记忆化）、拼音域缓存与空闲
 * 分片预构建调度、关键词/模糊子序列命中判定。
 */

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
/**
 * 拼音搜索域缓存（FEAT-07）：按模型对象引用记忆化，与普通搜索域同一失效约定。
 * O2：引擎就绪后由空闲预构建（prebuildPinyinSearchIndex）提前填充，查询
 * 热路径优先命中缓存；预构建未完成时仍按原有懒计算兜底，结果不受进度影响。
 */
const pinyinHaystackCache = new WeakMap()
/** 拼音域预构建单次最多处理的模型数（与时间预算共同限幅） */
const PINYIN_PREBUILD_BATCH_MAX = 100
/** 拼音域预构建单次时间预算（ms）：空闲回调内不长时间占用主线程 */
const PINYIN_PREBUILD_BUDGET_MS = 6

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

/**
 * 构建并缓存模型的合并小写搜索域
 * @param {Record<string, any>} m 模型对象
 */
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

/**
 * 增量预构建拼音搜索域（O2）：从 start 起最多处理 max 个未缓存模型，
 * 或达到时间预算后返回下一次起点。已缓存对象直接跳过（WeakMap 按对象
 * 引用失效，模型对象整体替换后自然视为未缓存）。
 *
 * 分片而非一次性遍历：pinyin-pro 对每个模型要生成全拼与首字母两段文本，
 * 万级库一次跑完会在渲染线程形成数十毫秒级长任务。调用方（空闲调度器）
 * 在 requestIdleCallback 内逐片推进，搜索过滤热路径只读缓存；若用户在
 * 预构建完成前发起查询，pinyinHaystack 仍按原有懒计算兜底，结果正确性
 * 不依赖预构建进度。
 * @param {Array<Record<string, any>>} models 模型列表
 * @param {{start?: number, max?: number, budgetMs?: number}} [options]
 *   start 起始下标；max 本次最多新建数；budgetMs 单次时间预算
 * @returns {{next: number, built: number, done: boolean}}
 *   next 下一次起点；built 本次新建条目数；done 是否已处理完
 */
export function prebuildPinyinSearchIndex(models, options = {}) {
  if (!pinyinReady.value) return { next: 0, built: 0, done: true }
  const list = Array.isArray(models) ? models : []
  // Number.isInteger/isFinite 不是类型守卫：先取局部 const 并以 typeof 收窄
  // （对非数值入参二者本就返回 false，判定结果与语义完全一致）
  const rawStart = options.start
  const start =
    typeof rawStart === 'number' && Number.isInteger(rawStart) && rawStart > 0
      ? Math.min(rawStart, list.length)
      : 0
  const rawMax = options.max
  const max =
    typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0
      ? Math.max(1, Math.floor(rawMax))
      : PINYIN_PREBUILD_BATCH_MAX
  const rawBudgetMs = options.budgetMs
  const budgetMs =
    typeof rawBudgetMs === 'number' &&
    Number.isFinite(rawBudgetMs) &&
    rawBudgetMs >= 0
      ? rawBudgetMs
      : PINYIN_PREBUILD_BUDGET_MS
  const startedAt = Date.now()
  let cursor = start
  let built = 0
  while (cursor < list.length && built < max) {
    const m = list[cursor]
    cursor += 1
    if (!m || pinyinHaystackCache.has(m)) continue
    pinyinHaystack(m)
    built += 1
    if (Date.now() - startedAt >= budgetMs) break
  }
  return { next: cursor, built, done: cursor >= list.length }
}

/**
 * 空闲预构建调度状态（O2）：同一时刻只推进一个模型列表。
 * - generation：列表替换/引擎重置时递增，旧空闲回调据此作废；
 * - list/cursor：当前预构建列表与下一次起点；
 * - idle：已排队的 requestIdleCallback 句柄（null 表示未排队）。
 */
/** @type {number|null} */
let pinyinPrebuildIdle = null
let pinyinPrebuildGeneration = 0
/** @type {Array<Record<string, any>>|null} */
let pinyinPrebuildList = null
let pinyinPrebuildCursor = 0

/** 取消已排队的空闲预构建并作废旧代际 */
function cancelPinyinPrebuild() {
  pinyinPrebuildGeneration += 1
  if (pinyinPrebuildIdle !== null && typeof cancelIdleCallback === 'function') {
    cancelIdleCallback(pinyinPrebuildIdle)
  }
  pinyinPrebuildIdle = null
  pinyinPrebuildList = null
  pinyinPrebuildCursor = 0
}

/**
 * 安排拼音域空闲预构建（O2）：
 * - 引擎未就绪或环境不支持 requestIdleCallback（node 测试）时直接跳过，
 *   过滤链路仍有懒计算兜底；
 * - 列表整体替换（扫描完成/切库）或引擎首次就绪时重置进度，从新列表
 *   头部开始（WeakMap 缓存命中的模型会被快速跳过）；
 * - 每次空闲回调推进一个分片，未完成则以 timeout 续排，保证窗口隐藏/
 *   空闲时间碎片化时仍能最终完成。
 * @param {Array<Record<string, any>>} [list] 模型列表（默认当前全局列表）
 */
function schedulePinyinPrebuild(list = state.models) {
  // 引擎未就绪/空库：作废可能残留的旧列表进度（切库、离线清空）
  if (!pinyinReady.value || !Array.isArray(list) || list.length === 0) {
    cancelPinyinPrebuild()
    return
  }
  if (typeof requestIdleCallback !== 'function') {
    cancelPinyinPrebuild()
    return
  }
  // 同一列表已排队：不重复调度（进度由已排队回调继续推进）
  if (pinyinPrebuildList === list && pinyinPrebuildIdle !== null) return
  cancelPinyinPrebuild()
  pinyinPrebuildList = list
  pinyinPrebuildCursor = 0
  const generation = pinyinPrebuildGeneration
  const run = () => {
    pinyinPrebuildIdle = null
    if (generation !== pinyinPrebuildGeneration || !pinyinReady.value) return
    if (pinyinPrebuildList !== list) return
    const result = prebuildPinyinSearchIndex(list, {
      start: pinyinPrebuildCursor,
      max: PINYIN_PREBUILD_BATCH_MAX,
      budgetMs: PINYIN_PREBUILD_BUDGET_MS,
    })
    pinyinPrebuildCursor = result.next
    if (!result.done) {
      pinyinPrebuildIdle = requestIdleCallback(run, { timeout: 1000 })
    }
  }
  pinyinPrebuildIdle = requestIdleCallback(run, { timeout: 1000 })
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
export function keywordHit(m, keyword) {
  if (keywordMatches(searchHaystack(m), keyword)) return true
  if (!LATIN_QUERY_RE.test(keyword)) return false
  const py = pinyinHaystack(m)
  return py !== '' && keywordMatches(py, keyword)
}

/**
 * O2：拼音引擎就绪后启动全库空闲预构建；模型列表整体替换（扫描完成/
 * 切库）后重新推进新列表。元素级替换（标注/封面/详情补全）不整体重排——
 * 新对象在下一次过滤时按原有懒计算补齐，避免高频写入触发全库重扫。
 */
watch(pinyinReady, (ready) => {
  if (ready) schedulePinyinPrebuild(state.models)
  else cancelPinyinPrebuild()
})
watch(
  () => state.models,
  (list) => schedulePinyinPrebuild(list),
)
// HMR/测试等场景下引擎可能先于本模块就绪：补一次初始调度
if (pinyinReady.value) schedulePinyinPrebuild(state.models)
