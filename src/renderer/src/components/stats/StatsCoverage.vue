<script setup>
/**
 * 库统计「标注覆盖率」块（OPT-01 自 StatsSection.vue 按域拆出）：
 * 备注/备注名/推荐参数/封面的覆盖进度条（引导补全标注，
 * 为备份/导出的数据价值做铺垫）。
 * 区块/占比条视觉为 main.css 共享原语（.stats-section 前缀）。
 */

const props = defineProps({
  /** 覆盖率行（StatsSection 的 coverageRows computed） */
  rows: { type: Array, required: true },
  /** 全库模型总数（空库时渲染占位） */
  total: { type: Number, default: 0 }
})

/** 占比（0-100 整数；空库返回 0） */
function pctOf(n) {
  return props.total === 0 ? 0 : Math.round((n / props.total) * 100)
}
</script>

<template>
  <div class="stats-block">
    <h4>标注覆盖率</h4>
    <div v-if="total" class="coverage">
      <div v-for="row in rows" :key="row.key" class="cov-row">
        <span class="cov-label">{{ row.label }}</span>
        <div class="cov-bar">
          <div class="cov-fill" :style="{ width: `${pctOf(row.value)}%` }"></div>
        </div>
        <span class="cov-value cov-wide">{{ row.value }} 项 · {{ pctOf(row.value) }}%</span>
      </div>
    </div>
    <p v-else class="stats-empty">尚未扫描模型</p>
  </div>
</template>
