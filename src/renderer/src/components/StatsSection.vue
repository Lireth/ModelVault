<script setup>
import { computed } from 'vue'
import StatsBaseBreakdown from './stats/StatsBaseBreakdown.vue'
import StatsCoverage from './stats/StatsCoverage.vue'
import StatsDuplicates from './stats/StatsDuplicates.vue'
import StatsExtBreakdown from './stats/StatsExtBreakdown.vue'
import StatsOverview from './stats/StatsOverview.vue'
import StatsRatingBreakdown from './stats/StatsRatingBreakdown.vue'
import StatsTopSize from './stats/StatsTopSize.vue'
import StatsTypeBreakdown from './stats/StatsTypeBreakdown.vue'
import {
  BASE_MODEL_FAMILIES,
  duplicateGroups,
  duplicateWastedBytes,
  MODEL_TYPES,
  state,
  typeInfo
} from '../store/appStore'
import { normalizeBaseModel } from '../../../shared/model-categories'

/**
 * 库统计区编排壳（F7，F-3 图表化增强；OPT-01 板块组件化）：
 * - 总览数字 → stats/StatsOverview.vue
 * - 分类占比 / 格式分布（堆叠条 + 明细行）→ stats/StatsTypeBreakdown.vue /
 *   stats/StatsExtBreakdown.vue
 * - 标注覆盖率 / 评分分布 / 基底模型分布（占比条）→ stats/StatsCoverage.vue /
 *   stats/StatsRatingBreakdown.vue / stats/StatsBaseBreakdown.vue
 * - 重复占用 → stats/StatsDuplicates.vue；最占空间 TOP 5 → stats/StatsTopSize.vue
 * - 区块/堆叠条/占比条共享视觉 → main.css（.stats-section 前缀原语）
 * 本文件保留：全部派生计算（单一来源，经 props 下发各板块）。
 * 全部由渲染层 state.models 派生，零 IPC、随扫描/标注即时刷新；
 * 图表为纯 CSS 条形（无图表库依赖）。
 */

const stats = computed(() => {
  const models = state.models
  const byType = new Map()
  let totalBytes = 0
  let withNote = 0
  let withAlias = 0
  let withParams = 0
  let withCover = 0
  let favorites = 0
  let rated = 0
  let suspect = 0
  let nsfwCount = 0
  let recent = 0
  const ratingBuckets = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  let unrated = 0
  const now = Date.now()
  for (const m of models) {
    totalBytes += Number.isFinite(m.size) ? m.size : 0
    const t = byType.get(m.type) || { count: 0, bytes: 0 }
    t.count += 1
    t.bytes += Number.isFinite(m.size) ? m.size : 0
    byType.set(m.type, t)
    if (m.note) withNote += 1
    if (m.alias) withAlias += 1
    if (hasAnyParams(m)) withParams += 1
    if (m.hasManualCover) withCover += 1
    if (m.favorite) favorites += 1
    if (m.rating > 0) rated += 1
    if (m.suspect) suspect += 1
    if (m.nsfw) nsfwCount += 1
    // 近 30 天有文件变动的模型（mtimeMs 为文件修改时间）
    if (Number.isFinite(m.mtimeMs) && now - m.mtimeMs < 30 * 24 * 3600 * 1000) recent += 1
    if (m.rating >= 1 && m.rating <= 5) ratingBuckets[m.rating] += 1
    else unrated += 1
  }
  return {
    total: models.length,
    totalBytes,
    byType,
    withNote,
    withAlias,
    withParams,
    withCover,
    favorites,
    rated,
    suspect,
    nsfw: nsfwCount,
    recent,
    ratingBuckets,
    unrated
  }
})

/** 推荐参数「有内容」判定：核心字段任一有值 */
function hasAnyParams(m) {
  const p = m.params
  if (!p) return false
  return (
    Number.isFinite(p.steps) ||
    Number.isFinite(p.cfgMin) ||
    Boolean(p.sampler) ||
    Number.isFinite(p.resMin)
  )
}

/** 单模型平均容量（空库返回 0）：辅助判断库内模型的普遍体积 */
const avgBytes = computed(() =>
  stats.value.total ? Math.round(stats.value.totalBytes / stats.value.total) : 0
)

/** 各分类行（含未覆盖到的类型归入其他展示） */
const typeRows = computed(() => {
  const total = stats.value.total
  const rows = []
  for (const t of MODEL_TYPES) {
    const s = stats.value.byType.get(t.key)
    if (!s) continue
    rows.push({
      key: t.key,
      label: typeInfo(t.key).label,
      color: t.color,
      count: s.count,
      bytes: s.bytes,
      pct: total === 0 ? 0 : Math.round((s.count / total) * 100)
    })
  }
  return rows
})

/** 标注覆盖率行（引导补全标注，为备份/导出的数据价值做铺垫） */
const coverageRows = computed(() => [
  { key: 'note', label: '有备注', value: stats.value.withNote },
  { key: 'alias', label: '有备注名', value: stats.value.withAlias },
  { key: 'params', label: '有推荐参数', value: stats.value.withParams },
  { key: 'cover', label: '有封面', value: stats.value.withCover }
])

/** 最占空间 TOP 5（轻量占用分析：清理场景定位大头；pct 为占总容量的百分比） */
const topSize = computed(() => {
  const total = stats.value.totalBytes
  return [...state.models]
    .sort((a, b) => (b.size || 0) - (a.size || 0))
    .slice(0, 5)
    .map((m) => ({
      id: m.id,
      name: m.alias || m.name,
      size: m.size,
      pct: total > 0 ? Math.round(((m.size || 0) / total) * 100) : 0
    }))
})

/* ---------------- F-3 图表化增强 ---------------- */

/**
 * 格式分布（按扩展名聚合）：与分类占比同款堆叠条 + 明细行；
 * 按容量降序，配色循环取自语义色板（safetensors 通常居首取主色）。
 */
const EXT_PALETTE = [
  'var(--accent)',
  'var(--accent-2)',
  'var(--success)',
  'var(--warning)',
  'var(--warning-soft)',
  'var(--text-muted)'
]

const extRows = computed(() => {
  const byExt = new Map()
  for (const m of state.models) {
    // 优先使用扫描结果携带的真实扩展名（OPT-06）：.disabled 只是禁用后缀，
    // 直接截取路径末段会把 a.safetensors.disabled 误统计为 disabled 格式。
    let ext = typeof m.ext === 'string' && m.ext ? m.ext.replace(/^\./, '').toLowerCase() : ''
    if (!ext) {
      // 兼容无 ext 的旧索引：剔除 .disabled 后再取最后一段扩展名
      let id = typeof m.id === 'string' ? m.id : ''
      if (id.toLowerCase().endsWith('.disabled')) id = id.slice(0, -'.disabled'.length)
      const dot = id.lastIndexOf('.')
      ext = dot >= 0 ? id.slice(dot + 1).toLowerCase() : '其他'
    }
    const row = byExt.get(ext) || { count: 0, bytes: 0 }
    row.count += 1
    row.bytes += Number.isFinite(m.size) ? m.size : 0
    byExt.set(ext, row)
  }
  const total = stats.value.total
  return [...byExt.entries()]
    .map(([ext, s]) => ({ ext, count: s.count, bytes: s.bytes }))
    .sort((a, b) => b.bytes - a.bytes || b.count - a.count)
    .map((row, i) => ({
      ...row,
      color: EXT_PALETTE[i % EXT_PALETTE.length],
      pct: total === 0 ? 0 : Math.round((row.count / total) * 100)
    }))
})

/** 评分分布行（5★ → 1★ + 未评分；空库不渲染该区块） */
const ratingRows = computed(() => {
  const total = stats.value.total
  if (!total) return []
  const rows = [5, 4, 3, 2, 1].map((star) => ({
    star,
    label: '★'.repeat(star),
    count: stats.value.ratingBuckets[star],
    pct: Math.round((stats.value.ratingBuckets[star] / total) * 100)
  }))
  rows.push({
    star: 0,
    label: '未评分',
    count: stats.value.unrated,
    pct: Math.round((stats.value.unrated / total) * 100)
  })
  return rows
})

/**
 * 基底模型家族分布（F-2 数据源）：仅统计已解析/已回填基底模型的条目，
 * 按家族聚合计数与容量；未知（未解析）数量单列——筛选器命中语义与之一致
 * （未解析不命中任何家族）。
 */
const baseRows = computed(() => {
  const byFamily = new Map()
  let total = 0
  for (const m of state.models) {
    const family = normalizeBaseModel(m.baseModel || m.autoInfo?.baseModel || '')
    if (!family) continue
    total += 1
    const row = byFamily.get(family) || { count: 0, bytes: 0 }
    row.count += 1
    row.bytes += Number.isFinite(m.size) ? m.size : 0
    byFamily.set(family, row)
  }
  return {
    total,
    rows: BASE_MODEL_FAMILIES.filter((f) => byFamily.has(f.key)).map((f) => {
      const s = byFamily.get(f.key)
      return {
        key: f.key,
        label: f.label,
        count: s.count,
        bytes: s.bytes,
        pct: total === 0 ? 0 : Math.round((s.count / total) * 100)
      }
    })
  }
})

/** 重复占用统计（FEAT-1）：组数 / 冗余副本数 / 可释放空间占比 */
const dupStats = computed(() => {
  const groups = duplicateGroups.value
  if (groups.length === 0) return null
  let redundant = 0
  for (const g of groups) redundant += g.models.length - 1
  const total = stats.value.totalBytes
  return {
    groups: groups.length,
    redundant,
    wastedPct: total > 0 ? Math.round((duplicateWastedBytes.value / total) * 100) : 0
  }
})
</script>

<template>
  <div class="stats-section">
    <StatsOverview :stats="stats" :avg-bytes="avgBytes" />

    <div class="stats-grid">
      <!-- 分类占比 -->
      <StatsTypeBreakdown :rows="typeRows" :total-bytes="stats.totalBytes" />

      <!-- 标注覆盖率 -->
      <StatsCoverage :rows="coverageRows" :total="stats.total" />
    </div>

    <div class="stats-grid">
      <!-- 格式分布：按扩展名聚合（与扫描文件类型设置呼应） -->
      <StatsExtBreakdown :rows="extRows" :total-bytes="stats.totalBytes" />

      <!-- 评分分布：定位评分集中度与待评分存量 -->
      <StatsRatingBreakdown :rows="ratingRows" />
    </div>

    <!-- 基底模型分布（F-3，数据源 F-2）：清理「基底不匹配」模型时的全局视角 -->
    <StatsBaseBreakdown v-if="baseRows.total" :data="baseRows" />

    <!-- 重复占用（F-3，数据源 FEAT-1）：把「可释放空间」量化为清理动机 -->
    <StatsDuplicates v-if="dupStats" :dup="dupStats" :wasted-bytes="duplicateWastedBytes" />

    <!-- 最占空间 TOP 5：占比条直观看占用，点击行打开模型详情 -->
    <StatsTopSize v-if="topSize.length" :rows="topSize" />
  </div>
</template>

<style scoped>
.stats-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

@media (max-width: 720px) {
  .stats-grid {
    grid-template-columns: 1fr;
  }
}
</style>
