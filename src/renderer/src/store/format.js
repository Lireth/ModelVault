/**
 * 纯展示格式化工具（A-04 自 appStore.js 拆出），无响应式依赖。
 */

/** 文件大小格式化 */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

/**
 * zh-CN 日期格式化器（模块级单例）：`toLocaleDateString` 每次调用都要
 * 构造/解析 Intl 格式化器，虚拟列表滚动时每个可见行都会重算一次；复用
 * 同一实例后单次格式化降到纯 format 调用。输出与原调用完全等价
 * （`toLocaleDateString(locale)` 即该 locale 的默认日期格式）。
 */
const zhDateFormatter = new Intl.DateTimeFormat('zh-CN')

/** 日期串缓存（键为本地年月日）：同一日期在多行/多卡片间复用格式化结果 */
const dateTextCache = new Map()
/** 日期串缓存容量上限（病态防御：跨多年份的库也不会无限增长） */
const DATE_TEXT_CACHE_MAX = 128

/**
 * 修改日期格式化（卡片/列表共用）：本地 zh-CN 日期串。
 * 按「本地年月日」记忆化——同一日期只调用一次 Intl（列表滚动期每个可见行
 * 都读取该值，原实现每次重算 Intl 日期串）。无效时间戳保持原生
 * `Invalid Date` 文案。
 * @param {number} mtimeMs 修改时间（epoch ms）
 * @returns {string} 本地日期串
 */
export function formatDate(mtimeMs) {
  const date = new Date(mtimeMs)
  if (Number.isNaN(date.getTime())) return 'Invalid Date'
  const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
  let text = dateTextCache.get(key)
  if (text === undefined) {
    text = zhDateFormatter.format(date)
    if (dateTextCache.size >= DATE_TEXT_CACHE_MAX) {
      dateTextCache.delete(dateTextCache.keys().next().value)
    }
    dateTextCache.set(key, text)
  }
  return text
}

/**
 * 推荐参数摘要缓存（按 params 对象引用记忆化）：params 仅在保存时整体替换，
 * 引用即天然版本号；卡片/列表/导出会对同一对象重复调用，WeakMap 让重复
 * 计算零成本且不阻止旧对象回收。
 */
const paramSummaryCache = new WeakMap()

/**
 * 推荐参数摘要（卡片底部/列表参数列共用）：
 * 步数 · CFG（区间或单值）· 采样器 · 分辨率区间；未填字段跳过。
 * @param {Record<string, any>|null} p 推荐参数对象
 * @returns {string} 摘要文本
 */
export function formatParamSummary(p) {
  if (!p || typeof p !== 'object') return ''
  const cached = paramSummaryCache.get(p)
  if (cached !== undefined) return cached
  const parts = []
  if (Number.isFinite(p.steps)) parts.push(`${p.steps} 步`)
  // CFG 区间：min/max 相等或缺失时只显示单个值
  if (
    Number.isFinite(p.cfgMin) &&
    Number.isFinite(p.cfgMax) &&
    p.cfgMin !== p.cfgMax
  ) {
    parts.push(`CFG ${p.cfgMin}~${p.cfgMax}`)
  } else if (Number.isFinite(p.cfgMin)) {
    parts.push(`CFG ${p.cfgMin}`)
  } else if (Number.isFinite(p.cfgMax)) {
    parts.push(`CFG ${p.cfgMax}`)
  }
  if (p.sampler) parts.push(p.sampler)
  if (Number.isFinite(p.resMin) && Number.isFinite(p.resMax)) {
    parts.push(`${p.resMin}~${p.resMax}px`)
  }
  const summary = parts.join(' · ')
  paramSummaryCache.set(p, summary)
  return summary
}
