<script setup>
import {
  MAX_VIEWS,
  addView,
  closeView,
  state,
  switchView,
  viewLabel
} from '../store/appStore'

/**
 * 多视图标签栏（B-02）：每个标签页保留独立的筛选/搜索/排序状态。
 * 仅在已选择模型文件夹时显示；标签标题由当前视图条件自动派生。
 */

/** 中键关闭：auxclick 经 Vue .middle 修饰符处理，阻止默认自动滚动 */
function onMiddleClose(e, id) {
  e.preventDefault()
  closeView(id)
}
</script>

<template>
  <nav v-if="state.folder" class="view-tabs" aria-label="筛选视图标签页">
    <button
      v-for="(v, i) in state.views"
      :key="v.id"
      class="view-tab"
      :class="{ active: v.id === state.activeViewId }"
      :aria-current="v.id === state.activeViewId ? 'page' : undefined"
      @click="switchView(v.id)"
      @click.middle="onMiddleClose($event, v.id)"
    >
      <span class="view-tab-label" :title="viewLabel(v, i)">{{ viewLabel(v, i) }}</span>
      <span
        v-if="state.views.length > 1"
        class="view-tab-close"
        role="button"
        tabindex="0"
        title="关闭标签页（中键也可关闭）"
        :aria-label="`关闭标签页 ${viewLabel(v, i)}`"
        @click.stop="closeView(v.id)"
        @keydown.enter.stop.prevent="closeView(v.id)"
        @keydown.space.stop.prevent="closeView(v.id)"
      >✕</span>
    </button>
    <button
      class="view-tab-add"
      :disabled="state.views.length >= MAX_VIEWS"
      :title="state.views.length >= MAX_VIEWS ? `最多 ${MAX_VIEWS} 个标签页` : '新建标签页（独立筛选条件）'"
      @click="addView()"
    >＋</button>
  </nav>
</template>

<style scoped>
.view-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.view-tab {
  display: flex;
  align-items: center;
  gap: 7px;
  max-width: 220px;
  padding: 4px 6px 4px 12px;
  border: 1px solid var(--border);
  border-radius: 9px 9px 0 0;
  background: var(--bg);
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.12s ease, border-color 0.12s ease, background 0.12s ease;
}

.view-tab:hover {
  color: var(--text);
  border-color: var(--accent);
}

.view-tab.active {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--bg-active);
  font-weight: 600;
}

.view-tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.view-tab-close {
  flex-shrink: 0;
  width: 17px;
  height: 17px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  font-size: 10px;
  opacity: 0.6;
}

.view-tab-close:hover {
  opacity: 1;
  background: var(--danger);
  color: #fff;
}

.view-tab-add {
  flex-shrink: 0;
  width: 26px;
  height: 24px;
  padding: 0;
  border: 1px dashed var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.view-tab-add:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}

.view-tab-add:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
