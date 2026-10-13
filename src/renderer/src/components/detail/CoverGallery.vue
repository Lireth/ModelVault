<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { state } from '../../store/appStore'

/**
 * 全屏画廊模式：详情页预览图的全屏浏览层（Teleport 到 body）。
 * - 缩放：滚轮（以光标为锚点）/ 工具栏按钮 / 双击在适应与 2.5 倍间切换；
 * - 平移：左键拖拽（指针捕获，拖出窗口不丢手势），切换图片或复位时归零；
 * - 切换：← → 方向键 / 两侧按钮，相邻图自动预加载避免白闪；
 * - 快捷键：Esc 关闭、Delete 删除当前、D 设为默认、+/-/0 缩放控制；
 * - 键盘经 window 捕获阶段监听并阻断冒泡——Esc 不会穿透关闭详情页（F1），
 *   删除确认层可见时整键让位（与详情页同一约定）；
 * - 层级 --z-gallery（详情之上、Toast/确认层之下），删除确认与提示正常置顶。
 */

const props = defineProps({
  covers: { type: Array, required: true }, // [{ rel, path, url }]
  defaultPath: { type: String, default: '' },
  initialIndex: { type: Number, default: 0 },
  busy: { type: Boolean, default: false }
})

const emit = defineEmits(['close', 'set-default', 'delete'])

/* ---------------- 当前图片与切换 ---------------- */

const index = ref(
  Math.min(Math.max(0, props.initialIndex), Math.max(0, props.covers.length - 1))
)
const current = computed(() => props.covers[index.value] || null)
const isDefault = computed(() => current.value !== null && current.value.path === props.defaultPath)

/** 加载失败的图片 path（展示失效占位，不阻断切换浏览） */
const failedPaths = ref(new Set())

function onImgError(path) {
  failedPaths.value = new Set([...failedPaths.value, path])
}

/** 循环切换（单图时无操作） */
function go(step) {
  const n = props.covers.length
  if (n < 2) return
  index.value = (index.value + step + n) % n
}

// 切换图片：复位视口并预加载新邻居
watch(index, () => {
  resetView()
  preloadAround()
})

// 封面集合变化（画廊内删除/详情页增删）：钳制索引；删空时关闭画廊
watch(
  () => props.covers.map((c) => c.path).join('|'),
  () => {
    failedPaths.value = new Set()
    if (props.covers.length === 0) {
      emit('close')
      return
    }
    if (index.value >= props.covers.length) index.value = props.covers.length - 1
    preloadAround()
  }
)

/** 预加载相邻图片（本地文件加载快，但多 MB 原图解码仍需时间） */
function preloadAround() {
  const n = props.covers.length
  if (n < 2) return
  for (const step of [-1, 1]) {
    const c = props.covers[(index.value + step + n) % n]
    if (c) new Image().src = c.url
  }
}

/* ---------------- 缩放与平移 ---------------- */

const MIN_SCALE = 0.2
const MAX_SCALE = 8
const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
const dragging = ref(false)

const stageEl = ref(null)

function resetView() {
  scale.value = 1
  tx.value = 0
  ty.value = 0
}

/**
 * 以 (cx, cy)（相对舞台中心）为锚点缩放：锚点下的图像内容保持不动。
 * img 经 flex 居中、transform-origin 为元素中心，translate 在父坐标系
 * 作用于 scale 之后（CSS 变换右往左应用），故锚点公式成立。
 */
function zoomAt(cx, cy, next) {
  const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next))
  if (clamped === scale.value) return
  const k = clamped / scale.value
  tx.value = cx - (cx - tx.value) * k
  ty.value = cy - (cy - ty.value) * k
  scale.value = clamped
}

/** 事件位置换算为相对舞台中心的坐标 */
function stagePoint(e) {
  const rect = stageEl.value?.getBoundingClientRect()
  if (!rect) return { cx: 0, cy: 0 }
  return {
    cx: e.clientX - (rect.left + rect.width / 2),
    cy: e.clientY - (rect.top + rect.height / 2)
  }
}

function onWheel(e) {
  e.preventDefault()
  const { cx, cy } = stagePoint(e)
  zoomAt(cx, cy, scale.value * (e.deltaY < 0 ? 1.15 : 1 / 1.15))
}

/** 双击：适应（1x）与放大（2.5x，以光标为锚）互切 */
function onDblClick(e) {
  e.preventDefault()
  if (scale.value > 1.01) {
    resetView()
  } else {
    const { cx, cy } = stagePoint(e)
    zoomAt(cx, cy, 2.5)
  }
}

/* 拖拽平移（指针捕获：拖出窗口手势不中断） */
let dragStart = null

function onPointerDown(e) {
  if (e.button !== 0) return
  // 工具栏/导航按钮不启动拖拽（保留点击语义）
  if (e.target.closest('.gallery-btn')) return
  e.preventDefault()
  dragging.value = true
  dragStart = { x: e.clientX, y: e.clientY, tx: tx.value, ty: ty.value }
  stageEl.value?.setPointerCapture?.(e.pointerId)
}

function onPointerMove(e) {
  if (!dragStart) return
  tx.value = dragStart.tx + (e.clientX - dragStart.x)
  ty.value = dragStart.ty + (e.clientY - dragStart.y)
}

function onPointerUp() {
  dragStart = null
  dragging.value = false
}

/* ---------------- 快捷键（捕获阶段 + 阻断冒泡） ---------------- */

function onKeydown(e) {
  // 确认层（删除确认）可见时整键让位（F1：模态确认期间底层不得响应）
  if (state.confirm.visible) return
  switch (e.key) {
    case 'Escape':
      e.preventDefault()
      e.stopPropagation()
      emit('close')
      break
    case 'ArrowLeft':
    case 'ArrowUp':
      e.preventDefault()
      e.stopPropagation()
      go(-1)
      break
    case 'ArrowRight':
    case 'ArrowDown':
      e.preventDefault()
      e.stopPropagation()
      go(1)
      break
    case 'Delete':
      if (!props.busy && current.value) {
        e.preventDefault()
        e.stopPropagation()
        emit('delete', current.value)
      }
      break
    case 'd':
    case 'D':
      if (!props.busy && current.value && !isDefault.value) {
        e.preventDefault()
        e.stopPropagation()
        emit('set-default', current.value)
      }
      break
    case '+':
    case '=':
      e.preventDefault()
      e.stopPropagation()
      zoomAt(0, 0, scale.value * 1.25)
      break
    case '-':
      e.preventDefault()
      e.stopPropagation()
      zoomAt(0, 0, scale.value / 1.25)
      break
    case '0':
      e.preventDefault()
      e.stopPropagation()
      resetView()
      break
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown, { capture: true })
  preloadAround()
  await nextTick()
  // 焦点移入画廊：避免 Enter/Space 触发详情页上的残留焦点按钮
  stageEl.value?.focus()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, { capture: true })
})
</script>

<template>
  <Teleport to="body">
    <div
      ref="stageEl"
      class="gallery-overlay"
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      aria-label="封面全屏画廊"
      @wheel="onWheel"
      @dblclick="onDblClick"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <!-- 图片层：flex 居中，transform 承载缩放/平移 -->
      <div class="gallery-stage">
        <img
          v-if="current && !failedPaths.has(current.path)"
          :key="current.path"
          :src="current.url"
          :alt="`预览图 ${index + 1}`"
          class="gallery-img"
          :class="{ grabbing: dragging }"
          :style="{ transform: `translate(${tx}px, ${ty}px) scale(${scale})` }"
          draggable="false"
          @error="onImgError(current.path)"
        />
        <div v-else-if="current" class="gallery-missing">图片已失效</div>
      </div>

      <!-- 顶部：索引 + 关闭 -->
      <div class="gallery-top">
        <span class="gallery-index">{{ index + 1 }} / {{ covers.length }}</span>
        <button class="gallery-btn gallery-close" title="关闭（Esc）" aria-label="关闭画廊" @click="emit('close')">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </div>

      <!-- 左右切换（多图时） -->
      <template v-if="covers.length > 1">
        <button class="gallery-btn gallery-nav prev" title="上一张（←）" aria-label="上一张" @click="go(-1)">
          <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3L5 8l5 5" /></svg>
        </button>
        <button class="gallery-btn gallery-nav next" title="下一张（→）" aria-label="下一张" @click="go(1)">
          <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3l5 5-5 5" /></svg>
        </button>
      </template>

      <!-- 底部工具栏：缩放控制 + 设默认 + 删除 -->
      <div class="gallery-toolbar">
        <button class="gallery-btn" title="缩小（-）" aria-label="缩小" @click="zoomAt(0, 0, scale / 1.25)">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 8h10" /></svg>
        </button>
        <span class="gallery-zoom" title="滚轮缩放；双击图片在适应与 2.5 倍间切换">{{ Math.round(scale * 100) }}%</span>
        <button class="gallery-btn" title="放大（+）" aria-label="放大" @click="zoomAt(0, 0, scale * 1.25)">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
        </button>
        <button class="gallery-btn gallery-text-btn" title="复位缩放与平移（0）" @click="resetView">复位</button>
        <span class="gallery-sep" aria-hidden="true"></span>
        <button
          class="gallery-btn gallery-text-btn"
          :disabled="busy || isDefault"
          :title="isDefault ? '当前已是默认显示' : '设为默认显示（D）'"
          @click="emit('set-default', current)"
        >{{ isDefault ? '默认显示' : '设为默认' }}</button>
        <button
          class="gallery-btn gallery-text-btn gallery-danger"
          :disabled="busy"
          title="删除这张预览图（Delete）"
          @click="emit('delete', current)"
        >删除</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.gallery-overlay {
  position: fixed;
  /* 标题栏以下（保持窗口控制可达，与确认层同一约定） */
  top: var(--titlebar-height);
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--z-gallery);
  background: color-mix(in srgb, var(--bg) 82%, #000 18%);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  outline: none;
  user-select: none;
  overflow: hidden;
}

.gallery-stage {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.gallery-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  cursor: grab;
  /* 缩放/平移由滚轮与拖拽连续驱动，不做过渡（逐帧赋值反而拖影） */
  will-change: transform;
}

.gallery-img.grabbing {
  cursor: grabbing;
}

.gallery-missing {
  color: var(--text-muted);
  font-size: var(--font-md);
}

/* ---------- 悬浮控件：磨砂底压图，hover 提亮 ---------- */
.gallery-btn {
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: var(--overlay-thumb);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  color: #fff;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 8px;
  transition: background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out), opacity var(--dur-fast) var(--ease-out);
}

.gallery-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 45%, var(--overlay-thumb));
  border-color: var(--accent);
}

.gallery-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.gallery-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.gallery-top {
  position: absolute;
  top: 14px;
  left: 16px;
  right: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  pointer-events: none;
}

.gallery-top > * {
  pointer-events: auto;
}

.gallery-index {
  font-size: var(--font-xs);
  color: #fff;
  background: var(--overlay-thumb);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-full);
  padding: 4px 12px;
}

.gallery-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 44px;
  height: 44px;
  border-radius: 50%;
}

.gallery-nav.prev {
  left: 16px;
}

.gallery-nav.next {
  right: 16px;
}

.gallery-toolbar {
  position: absolute;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--overlay-thumb);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  padding: 8px 10px;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}

/* 工具栏内按钮去底（容器已是磨砂底） */
.gallery-toolbar .gallery-btn {
  background: transparent;
  border-color: transparent;
}

.gallery-toolbar .gallery-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 35%, transparent);
}

.gallery-zoom {
  min-width: 46px;
  text-align: center;
  font-size: var(--font-xs);
  color: #fff;
  font-variant-numeric: tabular-nums;
}

.gallery-text-btn {
  font-size: var(--font-xs);
  padding: 8px 12px;
  white-space: nowrap;
}

.gallery-sep {
  width: 1px;
  height: 18px;
  background: var(--glass-border-bright);
}

.gallery-danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--danger) 45%, transparent);
  border-color: var(--danger);
}
</style>
