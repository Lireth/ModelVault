<script setup>
import { computed } from 'vue'
import {
  BASE_MODEL_FAMILIES,
  duplicateGroups,
  duplicateWastedBytes,
  MODEL_TYPES,
  formatSize,
  openDetail,
  state,
  typeInfo
} from '../store/appStore'
import { normalizeBaseModel } from '../../../shared/model-categories'

/**
 * 库统计区（F7，F-3 图表化增强）：
 * - 总览数字 + 分类容量堆叠条（一键看「磁盘被谁吃了」）+ 分类明细行；
 * - 标注覆盖率（引导补全标注）；
 * - 基底模型分布（F-2 数据：autoInfo 解析 + Civitai 回填，按家族归一化）；
 * - 重复占用（FEAT-1：冗余副本可释放空间，给清理动机）；
 * - 最占空间 TOP 5。
 * 全部由渲染层 state.models 派生，零 IPC、随扫描/标注即时刷新；
 * 图表为纯 CSS 条形（无图表库依赖）。本组件为「轻量统计形态」——完整
 * 占用分析面板曾在功能精简阶段被移除，重启时以设置页区块而非独立面板落地。
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

/** 分类容量堆叠条的百分比（容量为零时返回 0，避免除零） */
function bytePctOf(bytes) {
  const total = stats.value.totalBytes
  return total > 0 ? Math.round((bytes / total) * 100) : 0
}

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
        <span class="stat-num">{{ formatSize(avgBytes) }}</span>
        <span class="stat-label">平均容量</span>
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
        <!-- 容量堆叠条（F-3）：按字节占比分色，一眼看出磁盘大头 -->
        <div
          v-if="typeRows.length && stats.totalBytes > 0"
          class="stack-bar"
          role="img"
          aria-label="各分类容量占比"
        >
          <div
            v-for="t in typeRows"
            :key="t.key"
            class="stack-seg"
            :style="{ flex: t.bytes, background: t.color }"
            :title="`${t.label}：${formatSize(t.bytes)}（${bytePctOf(t.bytes)}%）`"
          ></div>
        </div>
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
            <span class="cov-value cov-wide">{{ row.value }} 项 · {{ pctOf(row.value) }}%</span>
          </div>
        </div>
        <p v-else class="stats-empty">尚未扫描模型</p>
      </div>
    </div>

    <!-- 基底模型分布（F-3，数据源 F-2）：清理「基底不匹配」模型时的全局视角 -->
    <div v-if="baseRows.total" class="stats-block">
      <h4>基底模型分布</h4>
      <p class="base-note">
        已识别 {{ baseRows.total }} 个模型的基底（safetensors 头部解析 / Civitai 识别）
      </p>
      <div class="coverage">
        <div v-for="row in baseRows.rows" :key="row.key" class="cov-row">
          <span class="cov-label base-label" :title="`${row.label}：${formatSize(row.bytes)}`">
            {{ row.label }}
          </span>
          <div class="cov-bar">
            <div class="cov-fill" :style="{ width: `${row.pct}%` }"></div>
          </div>
          <span class="cov-value cov-wide">{{ row.count }} 个 · {{ row.pct }}%</span>
        </div>
      </div>
    </div>

    <!-- 重复占用（F-3，数据源 FEAT-1）：把「可释放空间」量化为清理动机 -->
    <div v-if="dupStats" class="stats-block">
      <h4>重复占用</h4>
      <p class="dup-summary">
        {{ dupStats.groups }} 组重复内容、{{ dupStats.redundant }} 个冗余副本，
        可释放 <strong>{{ formatSize(duplicateWastedBytes) }}</strong>（约占总容量 {{ dupStats.wastedPct }}%）
      </p>
      <div class="cov-row">
        <span class="cov-label">可释放</span>
        <div class="cov-bar">
          <div class="cov-fill dup-fill" :style="{ width: `${dupStats.wastedPct}%` }"></div>
        </div>
        <span class="cov-value">{{ dupStats.wastedPct }}%</span>
      </div>
      <p class="stats-empty">在结果栏开启「重复」筛选并「选中冗余项」即可批量清理</p>
    </div>

    <!-- 最占空间 TOP 5：占比条直观看占用，点击行打开模型详情 -->
    <div v-if="topSize.length" class="stats-block">
      <h4>最占空间 TOP 5</h4>
      <ol class="top-list">
        <li v-for="t in topSize" :key="t.id" class="top-row" title="打开模型详情" @click="openDetail(t.id)">
          <span class="top-name">{{ t.name }}</span>
          <div class="top-bar">
            <div class="top-fill" :style="{ width: `${t.pct}%` }"></div>
          </div>
          <span class="top-size">{{ formatSize(t.size) }}</span>
          <span class="top-pct">{{ t.pct }}%</span>
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.stats-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.stats-overview {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.stat-item {
  flex: 1;
  min-width: 110px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 统计数字：极光渐变文字，与品牌色呼应 */
.stat-num {
  font-size: 18px;
  font-weight: 700;
  background: var(--accent-grad);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  font-variant-numeric: tabular-nums;
  width: fit-content;
}

.stat-label {
  font-size: 11px;
  color: var(--text-muted);
}

.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.stats-block {
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  padding: 12px 16px;
}

.stats-block h4 {
  font-size: 11px;
  letter-spacing: 1px;
  color: var(--text-muted);
  margin-bottom: 8px;
}

/* 分类容量堆叠条（F-3）：flex 比例即字节占比，段间留 1px 视觉分隔 */
.stack-bar {
  display: flex;
  height: 10px;
  border-radius: var(--radius-full);
  overflow: hidden;
  gap: 1px;
  margin-bottom: 10px;
  background: var(--bg-hover);
}

.stack-seg {
  min-width: 2px;
  transition: flex var(--dur-base) var(--ease-out);
}

/* 基底模型分布 */
.base-note {
  font-size: var(--font-xs);
  color: var(--text-muted);
  margin: 0 0 8px;
}

.base-label {
  width: 88px;
}

/* 值列加宽（数量 + 百分比），覆盖率/基底分布共用 */
.cov-wide {
  width: 96px;
  white-space: nowrap;
}

/* 重复占用 */
.dup-summary {
  font-size: var(--font-xs);
  color: var(--text-muted);
  margin: 0 0 8px;
}

.dup-summary strong {
  color: var(--warning);
  font-variant-numeric: tabular-nums;
}

/* 可释放占比条：警示色与「该清理了」语义呼应 */
.dup-fill {
  background: var(--warning);
}

.stats-empty {
  font-size: var(--font-xs);
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
  font-size: var(--font-xs);
}

/* 类型色点样式（.type-dot）为 main.css 公共类 */

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
  gap: 12px;
  font-size: var(--font-xs);
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
  /* 覆盖率进度：极光渐变 */
  background: var(--accent-grad);
  transition: width var(--dur-base) var(--ease-out);
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
  gap: 12px;
  font-size: var(--font-xs);
}

/* TOP 行可点击：hover 高亮（负 margin 让高亮区外扩不出血） */
.top-row {
  cursor: pointer;
  padding: 3px 8px;
  margin: 0 -8px;
  border-radius: var(--radius-sm);
  transition: background var(--dur-fast) var(--ease-out);
}

.top-row:hover {
  background: var(--bg-hover);
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
  flex: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 容量占比条：占总容量的比例，一眼看出单模型占用级别 */
.top-bar {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--bg-hover);
  overflow: hidden;
}

.top-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--accent-grad);
}

.top-size {
  color: var(--text-muted);
  min-width: 64px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.top-pct {
  color: var(--text-muted);
  min-width: 36px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 720px) {
  .stats-grid {
    grid-template-columns: 1fr;
  }
}
</style>
