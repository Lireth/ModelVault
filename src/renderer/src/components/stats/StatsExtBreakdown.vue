<script setup>
import { formatSize } from '../../store/appStore'

/**
 * 库统计「格式分布」块（OPT-01 自 StatsSection.vue 按域拆出）：
 * 按扩展名聚合的堆叠条 + 明细行（与扫描文件类型设置呼应）。
 * 区块/堆叠条/明细行视觉为 main.css 共享原语（.stats-section 前缀）。
 */

const props = defineProps({
  /** 格式行（StatsSection 的 extRows computed，含配色与占比） */
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
    <h4>格式分布</h4>
    <div
      v-if="rows.length && totalBytes > 0"
      class="stack-bar"
      role="img"
      aria-label="各格式容量占比"
    >
      <div
        v-for="e in rows"
        :key="e.ext"
        class="stack-seg"
        :style="{ flex: e.bytes, background: e.color }"
        :title="`.${e.ext}：${formatSize(e.bytes)}（${bytePctOf(e.bytes)}%）`"
      ></div>
    </div>
    <ul v-if="rows.length" class="type-stats">
      <li v-for="e in rows" :key="e.ext">
        <span class="type-dot" :style="{ background: e.color }"></span>
        <span class="type-name">.{{ e.ext }}</span>
        <span class="type-count">{{ e.count }} 个</span>
        <span class="type-size">{{ formatSize(e.bytes) }}</span>
        <span class="type-pct">{{ e.pct }}%</span>
      </li>
    </ul>
    <p v-else class="stats-empty">尚未扫描模型</p>
  </div>
</template>
