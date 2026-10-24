<script setup>
import { formatSize } from '../../store/appStore'

/**
 * 库统计「重复占用」块（OPT-01 自 StatsSection.vue 按域拆出）：
 * FEAT-1 数据源——组数/冗余副本数/可释放空间，把「可释放空间」
 * 量化为清理动机。区块/占比条视觉为 main.css 共享原语。
 */

defineProps({
  /** 重复统计（StatsSection 的 dupStats computed：{ groups, redundant, wastedPct }） */
  dup: { type: Object, required: true },
  /** 冗余副本可释放字节数（duplicateWastedBytes） */
  wastedBytes: { type: Number, default: 0 }
})
</script>

<template>
  <div class="stats-block">
    <h4>重复占用</h4>
    <p class="dup-summary">
      {{ dup.groups }} 组重复内容、{{ dup.redundant }} 个冗余副本，
      可释放 <strong>{{ formatSize(wastedBytes) }}</strong>（约占总容量 {{ dup.wastedPct }}%）
    </p>
    <div class="cov-row">
      <span class="cov-label">可释放</span>
      <div class="cov-bar">
        <div class="cov-fill dup-fill" :style="{ width: `${dup.wastedPct}%` }"></div>
      </div>
      <span class="cov-value">{{ dup.wastedPct }}%</span>
    </div>
    <p class="stats-empty">在结果栏开启「重复」筛选并「选中冗余项」即可批量清理</p>
  </div>
</template>

<style scoped>
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
</style>
