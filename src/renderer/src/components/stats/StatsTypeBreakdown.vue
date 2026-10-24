<script setup>
import { formatSize } from '../../store/appStore'

/**
 * 库统计「分类占比」块（OPT-01 自 StatsSection.vue 按域拆出）：
 * 容量堆叠条（按字节占比分色，一眼看出磁盘大头）+ 分类明细行。
 * 区块/堆叠条/明细行视觉为 main.css 共享原语（.stats-section 前缀）。
 */

const props = defineProps({
  /** 分类行（StatsSection 的 typeRows computed） */
  rows: { type: Array, required: true },
  /** 全库总容量（字节），用于堆叠条占比换算 */
  totalBytes: { type: Number, default: 0 }
})

/** 容量占比（0-100 整数；总容量为零时返回 0，避免除零） */
function bytePctOf(bytes) {
  return props.totalBytes > 0 ? Math.round((bytes / props.totalBytes) * 100) : 0
}
</script>

<template>
  <div class="stats-block">
    <h4>分类占比</h4>
    <!-- 容量堆叠条（F-3）：按字节占比分色，一眼看出磁盘大头 -->
    <div
      v-if="rows.length && totalBytes > 0"
      class="stack-bar"
      role="img"
      aria-label="各分类容量占比"
    >
      <div
        v-for="t in rows"
        :key="t.key"
        class="stack-seg"
        :style="{ flex: t.bytes, background: t.color }"
        :title="`${t.label}：${formatSize(t.bytes)}（${bytePctOf(t.bytes)}%）`"
      ></div>
    </div>
    <ul v-if="rows.length" class="type-stats">
      <li v-for="t in rows" :key="t.key">
        <span class="type-dot" :style="{ background: t.color }"></span>
        <span class="type-name">{{ t.label }}</span>
        <span class="type-count">{{ t.count }} 个</span>
        <span class="type-size">{{ formatSize(t.bytes) }}</span>
        <span class="type-pct">{{ t.pct }}%</span>
      </li>
    </ul>
    <p v-else class="stats-empty">尚未扫描模型</p>
  </div>
</template>
