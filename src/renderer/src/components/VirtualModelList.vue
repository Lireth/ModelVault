<script setup>
import { computed } from 'vue'
import { handleModelActionKey } from './modelRowActions'
import {
  formatDate,
  formatParamSummary,
  formatSize,
  multiSelectIdSet,
  openDetail,
  selectRangeTo,
  showContextMenu,
  state,
  subCategoryInfo,
  toggleFavorite,
  toggleMultiSelectMode,
  toggleSelect,
  typeInfo,
} from '../store/appStore'
import { useVirtualScroll } from '../composables/useVirtualScroll'

/**
 * 模型紧凑列表视图（列表/网格双视图之一）：
 * - 与 VirtualModelGrid 同一数据源与交互语义（点击打开详情/多选切换、
 *   右键菜单、F 收藏、Delete 删除、方向键导航），信息密度更高，
 *   面向大批量整理场景；
 * - 行高固定（无需网格的等高校准），虚拟滚动内核（滚动测量/可视区间/
 *   浏览锚/键盘滚动联动）收敛于 useVirtualScroll（O4）；
 * - 列随设置项显隐（显示文件大小/修改日期/推荐参数，与卡片同一开关）；
 * - 浏览位置锚（B7）与网格同一约定：局部重扫就地合并不把用户拉回顶部。
 */

const props = defineProps({
  models: { type: Array, required: true },
})

/** 行高（px，固定）与上下缓冲行数 */
const ROW_HEIGHT = 36
const OVERSCAN_ROWS = 8

const { rootEl, startIndex, endIndex, indexById, scrollToRow, focusModel } =
  useVirtualScroll({
    rowHeight: ROW_HEIGHT,
    rowCount: () => props.models.length,
    models: () => props.models,
    overscan: OVERSCAN_ROWS,
    // 单列行模型：行号与模型索引恒等
    indexAtRow: (row) => row,
    rowOfIndex: (index) => index,
  })

/** 列定义：key → 表头文案与 grid 列宽（name/params 弹性，其余定宽） */
const COL_DEFS = {
  name: { label: '名称', width: 'minmax(180px, 2.4fr)' },
  type: { label: '分类', width: 'minmax(96px, 0.9fr)' },
  size: { label: '大小', width: '76px' },
  mtime: { label: '修改日期', width: '92px' },
  rating: { label: '评分', width: '88px' },
  params: { label: '推荐参数', width: 'minmax(120px, 1.5fr)' },
}

/** 可见列（随设置项显隐，与卡片展示开关同源） */
const visibleCols = computed(() => {
  const cols = ['name', 'type']
  if (state.settings.showSize) cols.push('size')
  if (state.settings.showMtime) cols.push('mtime')
  cols.push('rating')
  if (state.settings.showParams) cols.push('params')
  return cols
})

const gridTemplate = computed(() =>
  visibleCols.value.map((k) => COL_DEFS[k].width).join(' '),
)

const totalHeight = computed(() => props.models.length * ROW_HEIGHT)

const visibleModels = computed(() =>
  props.models.slice(startIndex.value, endIndex.value),
)

/** 多选模式与选中态（E4，与卡片同一语义） */
const selectedSet = multiSelectIdSet

/** 显示名称：备注名优先，为空回退文件名 */
function displayName(m) {
  return m.alias || m.name
}

/** 分类列文本：主分类标签 + 已标注的二级标签 */
function typeText(m) {
  const base = typeInfo(m.type).label
  if (!['other', 'lora', 'checkpoint'].includes(m.type) || !m.subCategory)
    return base
  const sub = subCategoryInfo(m.subCategory)
  return sub ? `${base} · ${sub.label}` : base
}

/** 评分列文本（0 分占位） */
function ratingText(m) {
  return m.rating > 0 ? '★'.repeat(m.rating) + '☆'.repeat(5 - m.rating) : '—'
}

function onRowActivate(m) {
  if (state.multiSelect.active) toggleSelect(m.id)
  else openDetail(m.id)
}

/**
 * 鼠标点击行（修饰键语义，与 ModelCard.onCardClick 同一约定；键盘
 * Enter/Space 恒走 onRowActivate 默认语义）：
 * - Ctrl+点击：非多选模式进入多选并选中该行；多选模式下等同普通点击
 * - Shift+点击：多选模式从锚点范围选中（替换选区）；非多选模式进入多选并选中
 */
function onRowClick(m, e) {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault()
    if (!state.multiSelect.active) toggleMultiSelectMode()
    toggleSelect(m.id)
    return
  }
  if (e.shiftKey) {
    e.preventDefault()
    if (!state.multiSelect.active) {
      toggleMultiSelectMode()
      toggleSelect(m.id)
    } else {
      selectRangeTo(m.id)
    }
    return
  }
  onRowActivate(m)
}

function onContextMenu(m) {
  showContextMenu(m.id)
}

/* ---------------- 键盘导航与快捷动作 ---------------- */

/**
 * 方向键在行间移动焦点并联动滚动（↑/← 上一行，↓/→ 下一行，
 * Home/End 跳首行/末行；与网格同一交互语言）。
 */
function onListKeydown(e) {
  const keys = [
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Home',
    'End',
  ]
  if (!keys.includes(e.key)) {
    handleModelActionKey(e, {
      models: props.models,
      indexById: indexById.value,
      focusModel,
    })
    return
  }
  const total = props.models.length
  if (total === 0) return
  const row = document.activeElement?.closest?.('[data-model-id]')
  let idx = row ? indexById.value.get(row.dataset.modelId) : undefined
  if (idx === undefined) {
    idx = 0
  } else {
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        idx = Math.max(0, idx - 1)
        break
      case 'ArrowRight':
      case 'ArrowDown':
        idx = Math.min(total - 1, idx + 1)
        break
      case 'Home':
        idx = 0
        break
      case 'End':
        idx = total - 1
        break
    }
  }
  const id = props.models[idx]?.id
  if (!id) return
  e.preventDefault()
  // 目标行不在可视窗口内时先滚动（内核 scrollToRow：缓冲行内可视，无需精确对齐）
  scrollToRow(idx)
  focusModel(id)
}
</script>

<template>
  <div class="model-list-wrap">
    <!-- 表头：sticky 吸附滚动容器顶部，列宽与行共用同一 grid 模板 -->
    <div class="list-header" :style="{ gridTemplateColumns: gridTemplate }">
      <span
        v-for="key in visibleCols"
        :key="key"
        class="list-header-cell"
        :class="`col-${key}`"
        >{{ COL_DEFS[key].label }}</span
      >
    </div>

    <div
      ref="rootEl"
      class="virtual-list"
      :style="{ height: `${totalHeight}px` }"
      @keydown="onListKeydown"
    >
      <div
        class="list-window"
        :style="{ transform: `translateY(${startIndex * ROW_HEIGHT}px)` }"
      >
        <div
          v-for="m in visibleModels"
          :key="m.id"
          class="list-row"
          :class="{ selected: selectedSet.has(m.id) }"
          :style="{ gridTemplateColumns: gridTemplate }"
          :title="m.id"
          tabindex="0"
          role="button"
          :aria-pressed="
            state.multiSelect.active ? selectedSet.has(m.id) : undefined
          "
          :aria-label="`查看模型 ${displayName(m)} 的详情`"
          :data-model-id="m.id"
          @click="onRowClick(m, $event)"
          @keydown.enter.prevent="onRowActivate(m)"
          @keydown.space.prevent="onRowActivate(m)"
          @contextmenu.prevent="onContextMenu(m)"
        >
          <!-- 名称列：多选勾选 + 收藏星标 + 名称 + 迷你角标 -->
          <span class="list-cell col-name">
            <span
              v-if="state.multiSelect.active"
              class="row-check"
              :class="{ on: selectedSet.has(m.id) }"
              role="checkbox"
              :aria-checked="selectedSet.has(m.id)"
              title="选中/取消选中"
              @click.stop="toggleSelect(m.id)"
              ><svg
                v-if="selectedSet.has(m.id)"
                viewBox="0 0 16 16"
                width="10"
                height="10"
                fill="none"
                stroke="currentColor"
                stroke-width="2.4"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M3 8.5l3.2 3.2L13 4.8" /></svg
            ></span>
            <button
              class="row-fav"
              :class="{ active: m.favorite }"
              :title="m.favorite ? '取消收藏' : '收藏'"
              @click.stop="toggleFavorite(m.id)"
              @keydown.enter.stop.prevent
              @keydown.space.stop.prevent
            >
              <svg
                viewBox="0 0 24 24"
                width="13"
                height="13"
                :fill="m.favorite ? 'currentColor' : 'none'"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path
                  d="M12 3.6l2.5 5.2 5.7.7-4.2 3.9 1.1 5.6L12 16.1 6.9 19l1.1-5.6-4.2-3.9 5.7-.7z"
                />
              </svg>
            </button>
            <span class="row-name" :title="m.name">{{ displayName(m) }}</span>
            <span v-if="m.nsfw" class="mini-badge nsfw" title="NSFW 标记"
              >NSFW</span
            >
            <span
              v-if="m.suspect"
              class="mini-badge suspect"
              title="文件疑似损坏（结构校验失败或 0 字节）"
              >损坏</span
            >
            <span
              v-if="m.disabled"
              class="mini-badge disabled"
              title="已禁用（文件名带 .disabled 后缀）"
              >禁用</span
            >
          </span>
          <span class="list-cell col-type">{{ typeText(m) }}</span>
          <span v-if="state.settings.showSize" class="list-cell col-size">{{
            formatSize(m.size)
          }}</span>
          <span v-if="state.settings.showMtime" class="list-cell col-mtime">{{
            formatDate(m.mtimeMs)
          }}</span>
          <span class="list-cell col-rating" :class="{ rated: m.rating > 0 }">{{
            ratingText(m)
          }}</span>
          <span
            v-if="state.settings.showParams"
            class="list-cell col-params"
            :class="{ empty: !formatParamSummary(m.params) }"
            :title="formatParamSummary(m.params)"
            >{{ formatParamSummary(m.params) || '未设置推荐参数' }}</span
          >
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.model-list-wrap {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* 表头：吸附滚动容器顶部（.content 为滚动祖先），玻璃底压住行内容 */
.list-header {
  position: sticky;
  top: 0;
  z-index: 2;
  display: grid;
  gap: 12px;
  padding: 6px 12px;
  font-size: 11px;
  color: var(--text-muted);
  letter-spacing: 0.5px;
  background: var(--glass-bg-strong);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  margin-bottom: 6px;
}

.list-header-cell {
  overflow: hidden;
  white-space: nowrap;
}

.virtual-list {
  position: relative;
}

.list-window {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
}

.list-row {
  display: grid;
  gap: 12px;
  align-items: center;
  height: 36px;
  padding: 0 12px;
  border-radius: var(--radius-md);
  border: 1px solid transparent;
  cursor: pointer;
  font-size: var(--font-xs);
  color: var(--text);
  transition:
    background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}

/* 斑马纹：高密度行信息的行间分隔 */
.list-row:nth-child(even) {
  background: color-mix(in srgb, var(--bg-card) 55%, transparent);
}

.list-row:hover {
  background: var(--bg-hover);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
}

.list-row.selected {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

.list-row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.list-cell {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.col-name {
  display: flex;
  align-items: center;
  gap: 6px;
}

.row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

/* 收藏星标（行内紧凑版，语义与卡片一致） */
.row-fav {
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: var(--border);
  line-height: 1;
  padding: 2px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  border-radius: var(--radius-sm);
}

.row-fav:hover {
  color: var(--favorite);
}

.row-fav.active {
  color: var(--favorite);
}

/* 多选勾选框（行内紧凑版） */
.row-check {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm);
  border: 1.5px solid var(--glass-border-bright);
  background: var(--overlay-thumb);
  color: var(--on-bright);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  user-select: none;
}

.row-check.on {
  border-color: var(--accent);
  background: var(--accent);
}

/* 迷你角标：NSFW / 损坏 / 禁用（列表行高受限，取文字小标） */
.mini-badge {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  padding: 1px 7px;
  border-radius: var(--radius-full);
  line-height: 1.5;
}

.mini-badge.nsfw {
  color: #fff;
  background: var(--danger);
  letter-spacing: 0.5px;
}

.mini-badge.suspect {
  color: var(--on-bright);
  background: var(--warning);
}

.mini-badge.disabled {
  color: var(--text-muted);
  background: var(--overlay);
}

.col-type,
.col-size,
.col-mtime {
  color: var(--text-muted);
}

.col-rating {
  color: var(--text-muted);
  letter-spacing: 1px;
}

.col-rating.rated {
  color: var(--favorite);
}

.col-params {
  color: var(--accent);
}

.col-params.empty {
  color: var(--text-muted);
  opacity: 0.7;
}
</style>
