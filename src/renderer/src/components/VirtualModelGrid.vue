<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ModelCard from './ModelCard.vue'
import { state } from '../store/appStore'

/**
 * 模型卡片虚拟滚动网格：
 * - 仅渲染视口附近（含上下缓冲行）的卡片行，数千模型时 DOM 数量恒定；
 * - 列数/列宽复刻原 .model-grid 的 repeat(auto-fill, minmax(...)) 行为，
 *   行高（卡片实际高度 + 行间距）在渲染后按真实卡片校准；
 * - 滚动事件挂在最近的滚动祖先（.content）上，页面其余部分滚动行为不变。
 */

const props = defineProps({
  models: { type: Array, required: true }
})

/** 各卡片尺寸对应的最小列宽与网格间距（与原 .model-grid CSS 保持一致） */
const GRID_PRESETS = {
  compact: { min: 150, gap: 10 },
  normal: { min: 190, gap: 14 },
  large: { min: 240, gap: 18 }
}

/** 上下各多渲染的缓冲行数，保证快速滚动时不露白 */
const OVERSCAN_ROWS = 3

const rootEl = ref(null)
const containerWidth = ref(0)
const viewportHeight = ref(600)
const scrollTop = ref(0)
/** 行间距（卡片高 + 行 gap），初始为估计值，挂载后按实际卡片高度校准 */
const rowPitch = ref(260)

const preset = computed(() => GRID_PRESETS[state.settings.cardSize] || GRID_PRESETS.normal)
const gapCss = computed(() => `${preset.value.gap}px`)

const columns = computed(() => {
  if (!containerWidth.value) return 1
  const { min, gap } = preset.value
  return Math.max(1, Math.floor((containerWidth.value + gap) / (min + gap)))
})

const rowCount = computed(() => Math.ceil(props.models.length / columns.value))
const totalHeight = computed(() =>
  rowCount.value > 0 ? rowCount.value * rowPitch.value - preset.value.gap : 0
)

const startRow = computed(() =>
  Math.max(0, Math.floor(scrollTop.value / rowPitch.value) - OVERSCAN_ROWS)
)
const visibleRowCount = computed(
  () => Math.ceil(viewportHeight.value / rowPitch.value) + 1 + OVERSCAN_ROWS * 2
)
const endRow = computed(() => Math.min(rowCount.value, startRow.value + visibleRowCount.value))

const visibleRows = computed(() => {
  const rows = []
  const cols = columns.value
  for (let r = startRow.value; r < endRow.value; r++) {
    rows.push({ index: r, models: props.models.slice(r * cols, (r + 1) * cols) })
  }
  return rows
})

/* ---------------- 滚动与尺寸测量 ---------------- */

let scroller = null
let resizeObserver = null

/** 向上查找最近的滚动容器（.content） */
function findScrollParent(el) {
  let node = el?.parentElement
  while (node) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll') return node
    node = node.parentElement
  }
  return null
}

function onScroll() {
  if (!scroller) return
  scrollTop.value = scroller.scrollTop
  viewportHeight.value = scroller.clientHeight
}

function measure() {
  if (!rootEl.value) return
  containerWidth.value = rootEl.value.clientWidth
  if (scroller) {
    viewportHeight.value = scroller.clientHeight
    scrollTop.value = scroller.scrollTop
  }
}

/** 用已渲染卡片的真实高度校准行距（卡片高度仅随列宽与显示设置变化） */
function calibrateRowPitch() {
  const card = rootEl.value?.querySelector('.grid-row .model-card')
  if (!card) return
  const h = card.getBoundingClientRect().height
  if (h > 0) rowPitch.value = h + preset.value.gap
}

function scheduleCalibrate() {
  nextTick(calibrateRowPitch)
}

// 列数或卡片显示设置变化时，卡片高度随之变化，需要在下一帧重新校准
watch(
  [
    columns,
    () => state.settings.cardSize,
    () => state.settings.showSize,
    () => state.settings.showMtime,
    () => state.settings.showParams
  ],
  scheduleCalibrate
)

onMounted(() => {
  scroller = findScrollParent(rootEl.value)
  measure()
  scroller?.addEventListener('scroll', onScroll, { passive: true })
  resizeObserver = new ResizeObserver(measure)
  resizeObserver.observe(rootEl.value)
  scheduleCalibrate()
})

onBeforeUnmount(() => {
  scroller?.removeEventListener('scroll', onScroll)
  resizeObserver?.disconnect()
})
</script>

<template>
  <div ref="rootEl" class="virtual-grid" :style="{ height: `${totalHeight}px` }">
    <div
      v-for="row in visibleRows"
      :key="row.index"
      class="grid-row"
      :style="{
        transform: `translateY(${row.index * rowPitch}px)`,
        gridTemplateColumns: `repeat(${columns}, 1fr)`,
        gap: gapCss
      }"
    >
      <ModelCard v-for="m in row.models" :key="m.id" :model="m" />
    </div>
  </div>
</template>

<style scoped>
.virtual-grid {
  position: relative;
}

.grid-row {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  display: grid;
}
</style>
