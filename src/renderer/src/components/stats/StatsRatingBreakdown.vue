<script setup>
/**
 * 库统计「评分分布」块（OPT-01 自 StatsSection.vue 按域拆出）：
 * 5★ → 1★ + 未评分的分布条（定位评分集中度与待评分存量）。
 * 区块/占比条视觉为 main.css 共享原语（.stats-section 前缀）。
 */

defineProps({
  /** 评分行（StatsSection 的 ratingRows computed；空库为空数组） */
  rows: { type: Array, required: true },
})
</script>

<template>
  <div class="stats-block">
    <h4>评分分布</h4>
    <div v-if="rows.length" class="coverage">
      <div v-for="r in rows" :key="r.star" class="cov-row">
        <span class="cov-label" :title="r.label">{{ r.label }}</span>
        <div class="cov-bar">
          <div class="cov-fill" :style="{ width: `${r.pct}%` }"></div>
        </div>
        <span class="cov-value cov-wide">{{ r.count }} 个 · {{ r.pct }}%</span>
      </div>
    </div>
    <p v-else class="stats-empty">尚未扫描模型</p>
  </div>
</template>
