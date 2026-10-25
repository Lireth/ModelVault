<script setup>
import { formatSize, openDetail } from '../../store/appStore'

/**
 * 库统计「最占空间 TOP 5」块（OPT-01 自 StatsSection.vue 按域拆出）：
 * 占比条直观看占用，点击行打开模型详情。
 */

defineProps({
  /** TOP 行（StatsSection 的 topSize computed：{ id, name, size, pct }） */
  rows: { type: Array, required: true },
})
</script>

<template>
  <div class="stats-block">
    <h4>最占空间 TOP 5</h4>
    <ol class="top-list">
      <li
        v-for="t in rows"
        :key="t.id"
        class="top-row"
        title="打开模型详情"
        @click="openDetail(t.id)"
      >
        <span class="top-name">{{ t.name }}</span>
        <div class="top-bar">
          <div class="top-fill" :style="{ width: `${t.pct}%` }"></div>
        </div>
        <span class="top-size">{{ formatSize(t.size) }}</span>
        <span class="top-pct">{{ t.pct }}%</span>
      </li>
    </ol>
  </div>
</template>

<style scoped>
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
}
</style>
