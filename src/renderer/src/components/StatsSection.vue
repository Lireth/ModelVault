<script setup>
import { computed } from 'vue'
import {
  MODEL_TYPES,
  formatSize,
  state,
  typeInfo
} from '../store/appStore'

/**
 * 库统计区（F7）：模型资产总览——总数/总容量/分类占比/标注覆盖率，
 * 以及最占空间 TOP 5（「该删谁」清理场景的第一入口）。
 * 全部由渲染层 state.models 派生，零 IPC、随扫描/标注即时刷新。
 * 说明：本组件为「轻量统计形态」——完整占用分析面板曾在功能精简阶段
 * 被移除，重启时以设置页区块而非独立面板的形态落地。
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
    rated
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

/** 占比（0-100 整数；空库返回 0） */
function pctOf(n) {
  const total = stats.value.total
  return total === 0 ? 0 : Math.round((n / total) * 100)
}

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

/** 最占空间 TOP 5（轻量占用分析：清理场景定位大头） */
const topSize = computed(() =>
  [...state.models]
    .sort((a, b) => (b.size || 0) - (a.size || 0))
    .slice(0, 5)
    .map((m) => ({ id: m.id, name: m.alias || m.name, size: m.size }))
)
</script>

<template>
  <div class="stats-section">
    <div class="stats-overview">
      <div class="stat-item">
        <span class="stat-num">{{ stats.total }}</span>
        <span class="stat-label">个模型</span>
      </div>
      <div class="stat-item">
        <span class="stat-num">{{ formatSize(stats.totalBytes) }}</span>
        <span class="stat-label">总容量</span>
      </div>
      <div class="stat-item">
        <span class="stat-num">{{ stats.favorites }}</span>
        <span class="stat-label">收藏</span>
      </div>
      <div class="stat-item">
        <span class="stat-num">{{ stats.rated }}</span>
        <span class="stat-label">已评分</span>
      </div>
    </div>

    <div class="stats-grid">
      <!-- 分类占比 -->
      <div class="stats-block">
        <h4>分类占比</h4>
        <ul v-if="typeRows.length" class="type-stats">
          <li v-for="t in typeRows" :key="t.key">
            <span class="type-dot" :style="{ background: t.color }"></span>
            <span class="type-name">{{ t.label }}</span>
            <span class="type-count">{{ t.count }} 个</span>
            <span class="type-size">{{ formatSize(t.bytes) }}</span>
            <span class="type-pct">{{ t.pct }}%</span>
          </li>
        </ul>
        <p v-else class="stats-empty">尚未扫描模型</p>
      </div>

      <!-- 标注覆盖率 -->
      <div class="stats-block">
        <h4>标注覆盖率</h4>
        <div v-if="stats.total" class="coverage">
          <div v-for="row in coverageRows" :key="row.key" class="cov-row">
            <span class="cov-label">{{ row.label }}</span>
            <div class="cov-bar">
              <div class="cov-fill" :style="{ width: `${pctOf(row.value)}%` }"></div>
            </div>
            <span class="cov-value">{{ pctOf(row.value) }}%</span>
          </div>
        </div>
        <p v-else class="stats-empty">尚未扫描模型</p>
      </div>
    </div>

    <!-- 最占空间 TOP 5 -->
    <div v-if="topSize.length" class="stats-block">
      <h4>最占空间 TOP 5</h4>
      <ol class="top-list">
        <li v-for="t in topSize" :key="t.id">
          <span class="top-name" :title="t.id">{{ t.name }}</span>
          <span class="top-size">{{ formatSize(t.size) }}</span>
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.stats-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.stats-overview {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.stat-item {
  flex: 1;
  min-width: 110px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stat-num {
  font-size: 18px;
  font-weight: 700;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}

.stat-label {
  font-size: 11px;
  color: var(--text-muted);
}

.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.stats-block {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  padding: 12px 14px;
}

.stats-block h4 {
  font-size: 11px;
  letter-spacing: 1px;
  color: var(--text-muted);
  margin-bottom: 8px;
}

.stats-empty {
  font-size: 12px;
  color: var(--text-muted);
  margin: 4px 0;
}

.type-stats {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.type-stats li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.type-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.type-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.type-count,
.type-pct {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.type-size {
  color: var(--text-muted);
  min-width: 64px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.type-pct {
  min-width: 36px;
  text-align: right;
}

.coverage {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cov-row {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

.cov-label {
  width: 76px;
  flex-shrink: 0;
  color: var(--text-muted);
}

.cov-bar {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: var(--bg-hover);
  overflow: hidden;
}

.cov-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--accent);
  transition: width 0.3s ease;
}

.cov-value {
  width: 36px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
}

.top-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  counter-reset: top;
}

.top-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
}

.top-list li::before {
  counter-increment: top;
  content: counter(top);
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--bg-hover);
  color: var(--text-muted);
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.top-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.top-size {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 720px) {
  .stats-grid {
    grid-template-columns: 1fr;
  }
}
</style>
