<script setup>
import { nextTick, ref } from 'vue'
import {
  activeSavedViewId,
  applySavedView,
  deleteSavedView,
  saveCurrentAsView,
  savedViews,
  state,
  viewSummary,
} from '../../store/appStore'

/**
 * 侧栏「智能视图」板块（OPT-01 自 Sidebar.vue 按域拆出）：
 * 当前搜索/分类/收藏/排序组合存为命名视图，一键切换；内联命名表单
 * 支持回车保存 / Esc 取消。
 */

/** 内联保存表单状态：savingView 展开中、viewName 输入值、savingBusy 防重复提交 */
const savingView = ref(false)
const viewName = ref('')
const savingBusy = ref(false)
const viewNameInput = ref(null)

function startSaveView() {
  savingView.value = true
  viewName.value = ''
  nextTick(() => viewNameInput.value?.focus())
}

function cancelSaveView() {
  savingView.value = false
}

async function onSaveViewConfirm() {
  if (savingBusy.value) return
  savingBusy.value = true
  try {
    if (await saveCurrentAsView(viewName.value)) savingView.value = false
  } finally {
    savingBusy.value = false
  }
}
</script>

<template>
  <div class="side-section views-section">
    <h3>智能视图</h3>
    <ul v-if="savedViews.length" class="view-list">
      <li v-for="v in savedViews" :key="v.id">
        <button
          class="view-item"
          :class="{ active: v.id === activeSavedViewId }"
          :title="`${viewSummary(v)}（点击应用）`"
          @click="applySavedView(v.id)"
        >
          <span class="view-name">{{ v.name }}</span>
          <span
            class="view-remove"
            role="button"
            tabindex="0"
            title="删除该视图（不影响筛选状态）"
            :aria-label="`删除视图 ${v.name}`"
            @click.stop="deleteSavedView(v.id)"
            @keydown.enter.stop.prevent="deleteSavedView(v.id)"
            @keydown.space.stop.prevent="deleteSavedView(v.id)"
            >✕</span
          >
        </button>
      </li>
    </ul>
    <div v-if="savingView" class="view-save-form">
      <input
        ref="viewNameInput"
        v-model="viewName"
        type="text"
        maxlength="30"
        placeholder="视图名称…"
        spellcheck="false"
        @keydown.enter="onSaveViewConfirm"
        @keydown.esc="cancelSaveView"
      />
      <div class="view-save-actions">
        <button
          class="btn btn-primary"
          :disabled="savingBusy"
          @click="onSaveViewConfirm"
        >
          保存
        </button>
        <button class="btn" @click="cancelSaveView">取消</button>
      </div>
    </div>
    <button
      v-else
      class="btn view-save-btn"
      :disabled="!state.folder"
      title="将当前搜索 / 分类 / 收藏 / 排序组合保存为视图，便于一键切换"
      @click="startSaveView"
    >
      保存当前筛选为视图
    </button>
  </div>
</template>

<style scoped>
.view-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 8px;
}

.view-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text);
  font-size: var(--font-xs);
  cursor: pointer;
  text-align: left;
  transition:
    background var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}

.view-item:hover {
  background: var(--bg-hover);
}

/* 当前筛选命中的视图：与分类选中态一致的强调光条 */
.view-item.active {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--accent) 16%, transparent),
    color-mix(in srgb, var(--accent) 4%, transparent) 70%,
    transparent
  );
  box-shadow: inset 2px 0 0 var(--accent);
}

.view-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 删除按钮：键盘可达（OPT-2），装配语义与侧栏库列表移除按钮一致 */
.view-remove {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 10px;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--dur-fast) var(--ease-out);
}

.view-item:hover .view-remove,
.view-remove:focus-visible {
  opacity: 1;
  pointer-events: auto;
}

.view-remove:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.view-remove:hover {
  background: var(--danger);
  color: #fff;
}

.view-save-btn {
  width: 100%;
  text-align: center;
  padding: 7px 6px;
  font-size: var(--font-xs);
}

/* 内联命名表单：玻璃输入框（与搜索框同族），操作按钮右对齐 */
.view-save-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.view-save-form input {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--text);
  font-size: var(--font-xs);
  outline: none;
  transition:
    border-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}

.view-save-form input:focus {
  border-color: var(--accent);
  box-shadow: var(--glow-accent);
}

.view-save-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.view-save-actions .btn {
  padding: 5px 14px;
  font-size: var(--font-xs);
}

/* 窄屏图标栏（OPT-1）：与 Sidebar.vue 的 960px 断点联动，整块隐藏 */
@media (max-width: 960px) {
  .views-section {
    display: none;
  }
}
</style>
