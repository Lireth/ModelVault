import {
  MODEL_TYPES,
  effectiveModelHash,
  effectiveFavorite,
  effectiveRating,
  sortDirectional,
} from '../state'
import { zhCollator } from './collator'

/**
 * 排序原语（O6 自 filter.js 拆出）：分类顺序映射、字段取值器、
 * 比较器构造、排序键快照与「有序下标数组」构建（PERF-SORT 下标层排序，
 * 缓存判定与物化在 pipeline.js）。
 */

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
 * 最近打开时间（epoch ms）：缺失/非法/从未打开统一为 0
 * @param {Record<string, any>} m 模型对象
 */
function lastOpenedAtOf(m) {
  return Number.isFinite(m.lastOpenedAt) && m.lastOpenedAt > 0
    ? m.lastOpenedAt
    : 0
}

/**
 * 累计打开次数：缺失/非法/负数统一为 0
 * @param {Record<string, any>} m 模型对象
 */
function openCountOf(m) {
  return Number.isInteger(m.openCount) && m.openCount > 0 ? m.openCount : 0
}

/**
 * 按排序方式构造比较器（仅在缓存未命中、需要真正重排时才创建）。
 * 语义与原集中式 switch 完全一致（收藏优先/评分为固定语义排序，同组按名称）。
 * @param {string} sortBy 排序方式 key
 * @returns {(a: Record<string, any>, b: Record<string, any>) => number}
 */
function comparatorFor(sortBy) {
  switch (sortBy) {
    case 'size':
      return (a, b) => b.size - a.size
    case 'mtime':
      return (a, b) => b.mtimeMs - a.mtimeMs
    case 'added':
      // 按添加时间（OPT-1）：与 mtime 同一约定——比较器恒为「新在前」，
      // sortAsc=true 默认即最新入库在前，sortAsc=false 翻转为最早在前
      return (a, b) => addedMsOf(b) - addedMsOf(a)
    case 'lastOpened':
      // 最近使用（F3）：最近打开的在前，从未打开（0）沉底并按名称排序；
      // sortAsc=false 翻转为最早使用/从未打开在前，便于清理长期未用模型
      return (a, b) =>
        lastOpenedAtOf(b) - lastOpenedAtOf(a) ||
        zhCollator.compare(a.name, b.name)
    case 'openCount':
      // 使用次数（F3）：次数高者在前，同次数按名称；方向翻转后低次数在前
      return (a, b) =>
        openCountOf(b) - openCountOf(a) || zhCollator.compare(a.name, b.name)
    case 'favorite':
      // 收藏优先，同组内按名称（U2）；固定语义排序，不响应方向翻转（O1）。
      // P1-1：收藏态经标注覆盖层读取（即时标注后排序立即生效）
      return (a, b) =>
        (effectiveFavorite(b) ? 1 : 0) - (effectiveFavorite(a) ? 1 : 0) ||
        zhCollator.compare(a.name, b.name)
    case 'rating':
      // 评分高优先，同分按名称（U2）；固定语义排序，不响应方向翻转（O1）。
      // P1-1：评分经标注覆盖层读取
      return (a, b) =>
        effectiveRating(b) - effectiveRating(a) ||
        zhCollator.compare(a.name, b.name)
    case 'type':
      // 按分类排序：遵循固定分类顺序（Checkpoint → TextEncoders → VAE → LoRA → 其他），同分类内按名称
      // 未知分类不在 TYPE_ORDER 中：undefined 参与算术本就产生 NaN（该路
      // 比较退化为 0）；?? NaN 仅显式化既有语义，不改变行为
      return (a, b) =>
        (TYPE_ORDER[a.type] ?? Number.NaN) -
          (TYPE_ORDER[b.type] ?? Number.NaN) ||
        zhCollator.compare(a.name, b.name)
    default:
      return (a, b) => zhCollator.compare(a.name, b.name)
  }
}

/**
 * 元素的排序键快照（PERF-SORT）：排序缓存需要保存「排序当时的键值」，而不是
 * 比较时重新读取——favorite/rating 与哈希经可变覆盖映射读取，若两侧对象
 * 共用同一覆盖状态，重新读取会把「键已变化」误判为未变化。
 * 名称参与比较的排序（收藏/评分/分类/默认）把名称并入键串，保证替换对象
 * 后名称变化同样被识别。
 * @param {Record<string, any>} m 模型对象
 * @param {string} sortBy 排序方式 key
 * @returns {number|string} 可比较的键快照
 */
export function sortKeyOf(m, sortBy) {
  switch (sortBy) {
    case 'size':
      return m.size
    case 'mtime':
      return m.mtimeMs
    case 'added':
      return addedMsOf(m)
    case 'lastOpened':
      return `${lastOpenedAtOf(m)}\u0000${m.name}`
    case 'openCount':
      return `${openCountOf(m)}\u0000${m.name}`
    case 'favorite':
      return `${effectiveFavorite(m) ? 1 : 0}\u0000${m.name}`
    case 'rating':
      return `${effectiveRating(m)}\u0000${m.name}`
    case 'type':
      return `${TYPE_ORDER[m.type]}\u0000${m.name}`
    default:
      return m.name
  }
}

/**
 * 构造「有序下标数组」（PERF-SORT）。
 *
 * 以索引排序取代「复制模型数组后直接 sort」：中文 Collator 比较是排序热路径
 * 中唯一昂贵的环节，索引数组使排序结果可被整体缓存复用（pipeline 的
 * sortCache）——列表因单模型封面/标注/详情补全等变更而重算时，只要 id
 * 顺序与排序键未变，直接按下标物化即可，不再重跑 O(n log n) 次 Collator
 * 比较。初始下标递增 = 原输入顺序，配合规范保证稳定的 sort，输出与原实现
 * 等价；排序方向翻转与重复筛选的二级排序同样在下标层完成，模型数组只物化
 * 一次。
 * @param {Array<Record<string, any>>} src 过滤后的未排序模型数组
 * @param {string} sortBy 排序方式 key
 * @param {boolean} sortAsc 是否升序（false 时翻转方向，固定语义排序不响应）
 * @param {boolean} showDuplicatesOnly 是否按哈希聚拢重复组
 * @returns {{order: number[], ids: string[], keys: Array<number|string>,
 *   hashes: string[]|null}} 有序下标与 id/排序键快照
 */
export function buildSortOrder(src, sortBy, sortAsc, showDuplicatesOnly) {
  const order = new Array(src.length)
  const ids = new Array(src.length)
  const keys = new Array(src.length)
  const hashes = showDuplicatesOnly ? new Array(src.length) : null
  for (let i = 0; i < src.length; i++) {
    const m = src[i]
    order[i] = i
    // src 为过滤层产出的密集数组（无空洞），!m 分支实际不可达，仅收窄类型
    if (!m) continue
    ids[i] = m.id
    keys[i] = sortKeyOf(m, sortBy)
    if (hashes) hashes[i] = effectiveModelHash(m)
  }
  const compare = comparatorFor(sortBy)
  // order 为 0..n-1 的排列，下标必然有效；!a/!b 分支不可达，仅收窄类型
  order.sort((ia, ib) => {
    const a = src[ia]
    const b = src[ib]
    if (!a || !b) return 0
    return compare(a, b)
  })
  // 排序方向（U2）：收藏优先/按评分为固定语义排序（收藏/高分恒在前），
  // 翻转会反转语义，故不响应（O1）
  if (!sortAsc && sortDirectional(sortBy)) order.reverse()
  // 重复筛选（FEAT-1）：按哈希稳定排序把同组模型聚拢为相邻块（组间无语义
  // 顺序），组内相对顺序保持上方排序结果——散落的同组文件会破坏「逐组清理」
  // 的浏览流。筛选语义下此排序随筛选开启/关闭自动生效与退出
  if (hashes) {
    order.sort((ia, ib) => {
      const ha = hashes[ia]
      const hb = hashes[ib]
      return ha < hb ? -1 : ha > hb ? 1 : 0
    })
  }
  return { order, ids, keys, hashes }
}
