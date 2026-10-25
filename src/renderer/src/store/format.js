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

/** 修改日期格式化（卡片/列表共用）：本地 zh-CN 日期串 */
export function formatDate(mtimeMs) {
  return new Date(mtimeMs).toLocaleDateString('zh-CN')
}

/**
 * 推荐参数摘要（卡片底部/列表参数列共用）：
 * 步数 · CFG（区间或单值）· 采样器 · 分辨率区间；未填字段跳过。
 */
export function formatParamSummary(p) {
  if (!p) return ''
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
  return parts.join(' · ')
}
