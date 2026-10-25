<script setup>
import { computed } from 'vue'
import ModelCardBody from './ModelCardBody.vue'
import ModelCardCover from './ModelCardCover.vue'
import {
  multiSelectIdSet,
  openDetail,
  selectRangeTo,
  showContextMenu,
  state,
  toggleMultiSelectMode,
  toggleSelect,
} from '../store/appStore'

/**
 * 模型卡片编排壳（OPT-01 拆分）：
 * - 封面区（默认封面/悬停轮播/各类角标）→ ModelCardCover.vue
 * - 卡片主体（名称/收藏/元信息/标签/参数摘要）→ ModelCardBody.vue
 * 本文件保留：卡片根节点交互（点击/修饰键多选/键盘激活/右键菜单）、
 * 多选勾选框与选中态。
 */

const props = defineProps({
  model: { type: Object, required: true },
})

/** 多选模式（E4）：点击卡片切换选中态而非打开详情（O4：Set 命中 O(1)） */
const selected = computed(() => multiSelectIdSet.value.has(props.model.id))

/** 显示名称：备注名优先，为空时回退文件名 */
const displayName = computed(() => props.model.alias || props.model.name)

function onCardActivate() {
  if (state.multiSelect.active) toggleSelect(props.model.id)
  else openDetail(props.model.id)
}

/**
 * 鼠标点击（修饰键语义，与文件管理器对齐；键盘 Enter/Space 恒走
 * onCardActivate 默认语义，避免与网格方向键导航等键盘流冲突）：
 * - Ctrl+点击：非多选模式进入多选并选中该项；多选模式下等同普通点击
 * - Shift+点击：多选模式从锚点范围选中（替换选区）；非多选模式进入多选并选中
 */
function onCardClick(e) {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault()
    if (!state.multiSelect.active) toggleMultiSelectMode()
    toggleSelect(props.model.id)
    return
  }
  if (e.shiftKey) {
    e.preventDefault()
    if (!state.multiSelect.active) {
      toggleMultiSelectMode()
      toggleSelect(props.model.id)
    } else {
      selectRangeTo(props.model.id)
    }
    return
  }
  onCardActivate()
}

/** 右键菜单（阻止默认浏览器菜单） */
function onContextMenu() {
  showContextMenu(props.model.id)
}
</script>

<template>
  <article
    class="model-card"
    :class="{ selected }"
    :title="model.id"
    tabindex="0"
    role="button"
    :aria-pressed="state.multiSelect.active ? selected : undefined"
    :aria-label="`查看模型 ${displayName} 的详情`"
    @click="onCardClick"
    @keydown.enter.prevent="onCardActivate"
    @keydown.space.prevent="onCardActivate"
    @contextmenu.prevent="onContextMenu"
  >
    <!-- 多选勾选框（E4）：仅多选模式显示 -->
    <span
      v-if="state.multiSelect.active"
      class="select-check"
      :class="{ on: selected }"
      role="checkbox"
      :aria-checked="selected"
      title="选中/取消选中"
      @click.stop="toggleSelect(model.id)"
      ><svg
        v-if="selected"
        viewBox="0 0 16 16"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        stroke-width="2.4"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M3 8.5l3.2 3.2L13 4.8" /></svg
    ></span>
    <ModelCardCover :model="model" />
    <ModelCardBody :model="model" :display-name="displayName" />
  </article>
</template>

<style scoped>
.model-card {
  position: relative;
  /* 玻璃拟态卡片：微渐变厚度 + 细腻亮边 */
  background: var(--card-grad);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  cursor: pointer;
  transition:
    transform var(--dur-base) var(--ease-out),
    border-color var(--dur-base) var(--ease-out),
    box-shadow var(--dur-base) var(--ease-out);
  display: flex;
  flex-direction: column;
}

.model-card:hover {
  transform: translateY(-3px);
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
  box-shadow: var(--card-hover-shadow);
}

/* 多选选中态（E4）：强调边框 + 勾选角标 */
.model-card.selected {
  border-color: var(--accent);
  box-shadow:
    0 0 0 1px var(--accent) inset,
    0 0 18px color-mix(in srgb, var(--accent) 16%, transparent);
}

.select-check {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  border: 1.5px solid var(--glass-border-bright);
  /* 磨砂底压在封面上，未选中时也能看清 */
  background: var(--overlay-thumb);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  color: var(--on-bright);
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  user-select: none;
}

.select-check.on {
  border-color: var(--accent);
  background: var(--accent);
}

/* 键盘焦点可见性（U1）：Tab 聚焦卡片时的轮廓反馈 */
.model-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
