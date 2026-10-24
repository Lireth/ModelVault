<script setup>
import { formatSize } from '../../store/appStore'

/**
 * 库统计「基底模型分布」块（OPT-01 自 StatsSection.vue 按域拆出）：
 * F-2 数据源（autoInfo 解析 + Civitai 回填，按家族归一化），
 * 清理「基底不匹配」模型时的全局视角。
 * 区块/占比条视觉为 main.css 共享原语（.stats-section 前缀）。
 */

defineProps({
  /** 基底分布（StatsSection 的 baseRows computed：{ total, rows }） */
  data: { type: Object, required: true }
})
</script>

<template>
  <div class="stats-block">
    <h4>基底模型分布</h4>
    <p class="base-note">
      已识别 {{ data.total }} 个模型的基底（safetensors 头部解析 / Civitai 识别）
    </p>
    <div class="coverage">
      <div v-for="row in data.rows" :key="row.key" class="cov-row">
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
</template>

<style scoped>
.base-note {
  font-size: var(--font-xs);
  color: var(--text-muted);
  margin: 0 0 8px;
}

.base-label {
  width: 88px;
}
</style>
