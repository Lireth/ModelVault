<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ModelCard from './ModelCard.vue'
import {
  CARD_SIZE_PRESETS,
  confirmDialog,
  deleteModel,
  state,
  toggleFavorite
} from '../store/appStore'

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

/** 上下各多渲染的缓冲行数，保证快速滚动时不露白 */
const OVERSCAN_ROWS = 3

const rootEl = ref(null)
const containerWidth = ref(0)
const viewportHeight = ref(600)
const scrollTop = ref(0)
/**
 * 行间距（卡片高 + 行 gap），挂载后按实际卡片高度校准（B6）。
 * 初始估算值按当前档位推算：封面为 2:3 纵横比（宽取档位最小列宽）+ 信息区约 72px，
 * 比固定估计值更贴近真实高度，减少首帧行高突变造成的滚动条跳动。
 */
const CARD_INFO_HEIGHT = 72
function estimateRowPitch() {
  const p = CARD_SIZE_PRESETS[state.settings.cardSize] || CARD_SIZE_PRESETS.normal
  return Math.round(p.min * 1.5 + CARD_INFO_HEIGHT + p.gap)
}
const rowPitch = ref(estimateRowPitch())

const preset = computed(() => CARD_SIZE_PRESETS[state.settings.cardSize] || CARD_SIZE_PRESETS.normal)
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

const startRow = computed(() => {
  const raw = Math.floor(scrollTop.value / rowPitch.value) - OVERSCAN_ROWS
  // 上限钳制（B16）：scrollTop 瞬态越界（列表变短、rowPitch 变化）时
  // 避免 startRow >= rowCount 导致渲染 0 行空白
  return Math.min(Math.max(0, raw), Math.max(0, rowCount.value - 1))
})
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

/* ---------------- 键盘网格导航（E10） ---------------- */

/** id → 索引映射（导航定位用） */
const indexById = computed(() => new Map(props.models.map((m, i) => [m.id, i])))

/** 聚焦指定模型卡片（等待渲染后聚焦） */
function focusModel(id) {
  nextTick(() => {
    rootEl.value?.querySelector(`[data-model-id="${CSS.escape(id)}"]`)?.focus()
  })
}

/**
 * 方向键在卡片间移动焦点并联动滚动。
 * 此前键盘用户 Tab 到视口末尾后无法到达未渲染卡片（DOM 中不存在），
 * 数千模型时键盘浏览形同虚设；方向键导航 + 滚动联动解决该问题。
 */
function onGridKeydown(e) {
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']
  if (!keys.includes(e.key)) {
    onCardActionKey(e)
    return
  }
  const total = props.models.length
  if (total === 0) return
  const card = document.activeElement?.closest?.('[data-model-id]')
  let idx = card ? indexById.value.get(card.dataset.modelId) : undefined
  const cols = columns.value
  if (idx === undefined) {
    idx = 0
  } else {
    switch (e.key) {
      case 'ArrowLeft': idx = Math.max(0, idx - 1); break
      case 'ArrowRight': idx = Math.min(total - 1, idx + 1); break
      case 'ArrowUp': idx = Math.max(0, idx - cols); break
      case 'ArrowDown': idx = Math.min(total - 1, idx + cols); break
      case 'Home': idx = idx - (idx % cols); break
      case 'End': idx = Math.min(total - 1, idx - (idx % cols) + cols - 1); break
    }
  }
  const id = props.models[idx]?.id
  if (!id) return
  e.preventDefault()
  // 目标行不在渲染窗口内时先滚动（OVERSCAN 缓冲行内可视，无需精确对齐）
  const targetRow = Math.floor(idx / cols)
  const firstVisible = startRow.value + OVERSCAN_ROWS
  const lastVisible = endRow.value - 1 - OVERSCAN_ROWS
  if (scroller) {
    let next = scroller.scrollTop
    if (targetRow < firstVisible) next -= (firstVisible - targetRow) * rowPitch.value
    else if (targetRow > lastVisible) next += (targetRow - lastVisible) * rowPitch.value
    if (next !== scroller.scrollTop) {
      next = Math.max(0, next)
      scroller.scrollTop = next
      scrollTop.value = next
      // 键盘导航不触发 scroll 事件的 rAF 捕获（同步改动 scrollTop 后
      // 事件在下一帧才到），此处直接更新浏览锚（B7）
      captureAnchor()
    }
  }
  focusModel(id)
}

/**
 * 焦点卡片快捷操作（键盘导航体系）：
 * - F 收藏/取消收藏焦点卡片（多选模式下同样只作用于焦点卡片本身，
 *   批量收藏走 App 层 Ctrl+D）；
 * - Delete 删除焦点卡片（自带确认，移入系统回收站）；多选模式下不拦截，
 *   冒泡至 App 层批量删除。
 * Ctrl/Alt 组合键放行（Ctrl+F 等全局快捷键由 App 层处理）；
 * 详情/确认层/设置页打开时不作用于背景卡片（详情内快捷键由其自身处理）。
 */
function onCardActionKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return
  if (state.confirm.visible || state.selectedId !== null || state.settingsOpen) return
  const card = document.activeElement?.closest?.('[data-model-id]')
  const id = card?.dataset.modelId
  if (!id) return
  if (e.key === 'f' || e.key === 'F') {
    e.preventDefault()
    toggleFavorite(id)
    return
  }
  if (e.key === 'Delete' && !state.multiSelect.active) {
    e.preventDefault()
    onDeleteFocused(id)
  }
}

/**
 * Delete 删除焦点卡片：确认后走既有删除链路（移入回收站 + 关联数据清理），
 * 成功后焦点顺延到原位置卡片（越界取前一张），避免焦点丢回 body 中断键盘流。
 */
async function onDeleteFocused(id) {
  const idx = indexById.value.get(id)
  const m = idx !== undefined ? props.models[idx] : null
  if (!m) return
  // 删除前取好顺延目标：删除后列表前移，原位置即下一张
  const nextId = props.models[idx + 1]?.id ?? props.models[idx - 1]?.id
  if (!(await confirmDialog(`确定将「${m.alias || m.name}」移入系统回收站吗？`))) return
  if (!(await deleteModel(id))) return
  if (nextId) focusModel(nextId)
}

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

/**
 * 滚动事件 rAF 合帧（O4）：高频滚动下同一帧内的多次事件只取最后一帧的
 * 位置写入响应式 ref，减少无意义的依赖触发；clientHeight 读取也并入同一帧。
 */
let scrollRafId = 0

/**
 * 浏览位置锚（B7）：最近一次滚动稳定后的可视区首行信息。
 * 「列表签名变化 → 按锚恢复」取代此前「首项 id 未变则保留」的判断——
 * mtime 排序下局部重扫更新任意文件的 mtime 都会改变列表首项，把正在深位
 * 浏览的用户静默拉回顶部。非响应式变量：仅列表变化时读取，不参与渲染。
 */
let anchorId = ''
let anchorRow = -1
let anchorScrollTop = 0

/** 捕获当前浏览位置锚：可视区首行行号、该行首个模型 id 与滚动位置（保留行内偏移用） */
function captureAnchor() {
  if (!scroller) return
  const top = scroller.scrollTop
  const row = Math.max(0, Math.floor(top / rowPitch.value))
  anchorRow = row
  anchorScrollTop = top
  anchorId = props.models[row * columns.value]?.id || ''
}

function onScroll() {
  if (!scroller || scrollRafId) return
  scrollRafId = requestAnimationFrame(() => {
    scrollRafId = 0
    if (!scroller) return
    scrollTop.value = scroller.scrollTop
    viewportHeight.value = scroller.clientHeight
    captureAnchor()
  })
}

function measure() {
  if (!rootEl.value) return
  containerWidth.value = rootEl.value.clientWidth
  if (scroller) {
    viewportHeight.value = scroller.clientHeight
    scrollTop.value = scroller.scrollTop
  }
}

/** 等高假设告警只发一次（开发期断言） */
let equalHeightWarned = false

/** 用已渲染卡片的真实高度校准行距（卡片高度仅随列宽与显示设置变化） */
function calibrateRowPitch() {
  const cards = rootEl.value?.querySelectorAll('.grid-row .model-card')
  if (!cards || cards.length === 0) return
  const h = cards[0].getBoundingClientRect().height
  if (h <= 0) return
  // 开发期断言（B6）：虚拟滚动的行定位隐含「同行卡片等高」假设，当前由
  // ModelCard 的单行省略布局保证；未来改动（名称换行/新增可变高度内容）
  // 会静默破坏定位产生重叠/空隙，此处提前告警
  if (import.meta.env.DEV && !equalHeightWarned && cards.length > 1) {
    const last = cards[cards.length - 1].getBoundingClientRect().height
    if (Math.abs(last - h) > 2) {
      equalHeightWarned = true
      console.warn(
        '[VirtualModelGrid] 同行卡片高度不一致，虚拟滚动行定位将失准:',
        h,
        last
      )
    }
  }
  rowPitch.value = h + preset.value.gap
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

/**
 * 列表身份变化（筛选/搜索/排序导致长度或首尾项变化）时恢复/复位滚动位置：
 * 组件复用不重挂，列表变短后旧 scrollTop 会落在无效区间产生跳变。
 * 用「长度 + 首尾项 id」作签名，避免就地更新（如缩略图替换封面 URL）
 * 触发复位打断用户滚动。
 * B7 细化（取代旧「首项 id 未变则保留」判断）：以最近滚动捕获的浏览锚
 * （可视区首行模型 id）为准——
 * - 锚仍在新列表：滚动位置按锚的新行号平移（保留行内偏移），用户浏览
 *   不跳变。覆盖 autoRescan 局部重扫的就地合并，以及 mtime 排序下
 *   首项易主但可视内容未变的重排——此前这类变化会把深位用户拉回顶部；
 * - 无锚（未滚动过/在顶部）或锚已从列表消失（筛选/搜索/删除）：复位顶部
 *   （筛选/搜索变更几乎必然使锚失效，语义与旧版一致）。
 * 内容收缩导致的越界由浏览器钳制 scrollTop 并经 scroll 事件同步。
 */
watch(
  () =>
    `${props.models.length}|${props.models[0]?.id}|${props.models[props.models.length - 1]?.id}`,
  () => {
    if (!scroller) return
    const idx = anchorId ? indexById.value.get(anchorId) : undefined
    if (anchorId && idx !== undefined) {
      const newRow = Math.floor(idx / columns.value)
      const target = Math.max(0, anchorScrollTop + (newRow - anchorRow) * rowPitch.value)
      if (target !== scroller.scrollTop) {
        scroller.scrollTop = target
        scrollTop.value = target
      }
      // 以恢复后的位置为基准重捕锚：连续多次列表变化都以最新位置计算
      captureAnchor()
      return
    }
    anchorId = ''
    anchorRow = -1
    anchorScrollTop = 0
    scroller.scrollTop = 0
    scrollTop.value = 0
  }
)

onMounted(() => {
  scroller = findScrollParent(rootEl.value)
  // 重新挂载（空态/筛选空结果切换回网格）时旧滚动位置已无意义，复位到顶部（B16）
  if (scroller && scroller.scrollTop !== 0) {
    scroller.scrollTop = 0
  }
  measure()
  scroller?.addEventListener('scroll', onScroll, { passive: true })
  resizeObserver = new ResizeObserver(measure)
  resizeObserver.observe(rootEl.value)
  // U5：rootEl 高度恒等于 totalHeight，窗口纵向缩放不会触发其回调；
  // 须同时观察滚动容器，使 viewportHeight 随窗口缩放即时刷新（此前仅滚动时同步）
  if (scroller) resizeObserver.observe(scroller)
  scheduleCalibrate()
})

onBeforeUnmount(() => {
  if (scrollRafId) cancelAnimationFrame(scrollRafId)
  scroller?.removeEventListener('scroll', onScroll)
  resizeObserver?.disconnect()
})
</script>

<template>
  <div ref="rootEl" class="virtual-grid" :style="{ height: `${totalHeight}px` }" @keydown="onGridKeydown">
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
      <ModelCard v-for="m in row.models" :key="m.id" :model="m" :data-model-id="m.id" />
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
