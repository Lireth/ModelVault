<script setup>
import { formatSize } from '../../store/appStore'

/**
 * 库统计总览数字区（OPT-01 自 StatsSection.vue 按域拆出）：
 * 数量/容量/平均/收藏/评分/损坏/NSFW/近 30 天更新八项概览。
 */

defineProps({
  /** 全库派生统计（StatsSection 的 stats computed） */
  stats: { type: Object, required: true },
  /** 单模型平均容量（字节） */
  avgBytes: { type: Number, default: 0 }
})
</script>

<template>
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
    <div class="stat-item" :class="{ 'stat-warn': stats.suspect > 0 }">
      <span class="stat-num">{{ stats.suspect }}</span>
      <span class="stat-label">疑似损坏</span>
    </div>
    <div class="stat-item">
      <span class="stat-num">{{ stats.nsfw }}</span>
      <span class="stat-label">NSFW</span>
    </div>
    <div class="stat-item">
      <span class="stat-num">{{ stats.recent }}</span>
      <span class="stat-label">近 30 天更新</span>
    </div>
  </div>
</template>

<style scoped>
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

/* 疑似损坏 > 0：渐变数字转警示红（background-clip: text 下换背景色即可） */
.stat-warn .stat-num {
  background: var(--danger);
}
</style>
