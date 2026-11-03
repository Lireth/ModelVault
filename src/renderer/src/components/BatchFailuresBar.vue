<script setup>
import { computed, ref, watch } from 'vue'
import {
  clearBatchFailures,
  reselectFailedItems,
  state,
} from '../store/appStore'

/**
 * 批量操作失败明细条（B20/F3）：位于批量栏下方，仅在有逐项失败时出现
 * （全成功不打扰，保持轻提示）。折叠态显示聚合计数；展开态按页渲染
 * 明细（默认 100 条/页，「显示更多」增量展开——不一次渲染数千行）。
 * 「重选失败项」把失败项中仍存在于当前库的模型重建为多选选区，
 * 用户随后用批量栏既有动作重试（复用原执行路径，不另起一套）。
 */

/** 每页渲染的明细条数（大量失败时分页展开，避免一次渲染数千行） */
const PAGE_SIZE = 100

const expanded = ref(false)
const shown = ref(PAGE_SIZE)

const failures = computed(() => state.multiSelect.failures)
const items = computed(() => failures.value?.items || [])
const visibleItems = computed(() => items.value.slice(0, shown.value))
const remaining = computed(() => items.value.length - shown.value)

// 新一批失败到达（引用变化）时回到折叠态与第一页，避免旧展开状态错位
watch(failures, () => {
  expanded.value = false
  shown.value = PAGE_SIZE
})

function showMore() {
  shown.value += PAGE_SIZE
}
</script>

<template>
  <div v-if="items.length > 0" class="batch-failures" role="status">
    <div class="bf-row">
      <span class="bf-icon" aria-hidden="true">⚠</span>
      <span class="bf-summary">
        {{ failures.op }}：失败 {{ items.length }} 个
      </span>
      <button
        class="bf-btn"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        {{ expanded ? '收起明细 ▴' : '失败明细 ▾' }}
      </button>
      <button
        class="bf-btn bf-retry"
        title="选中全部失败项（已不在当前库的自动跳过），随后在批量栏重试刚才的操作"
        @click="reselectFailedItems"
      >
        重选失败项
      </button>
      <button
        class="bf-btn bf-close"
        title="清除失败明细"
        aria-label="清除失败明细"
        @click="clearBatchFailures"
      >
        ×
      </button>
    </div>
    <div v-if="expanded" class="bf-list">
      <div
        v-for="it in visibleItems"
        :key="it.id"
        class="bf-item"
        :title="it.id"
      >
        <span class="bf-name">{{ it.name }}</span>
        <span class="bf-error">{{ it.error }}</span>
      </div>
      <button v-if="remaining > 0" class="bf-btn bf-more" @click="showMore">
        显示更多（还剩 {{ remaining }} 条）
      </button>
    </div>
  </div>
</template>

<style scoped>
.batch-failures {
  margin: 6px 12px 0;
  border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--danger) 8%, transparent);
  font-size: var(--font-xs);
}

.bf-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
}

.bf-icon {
  color: var(--danger);
}

.bf-summary {
  color: var(--text);
  flex: 1;
  min-width: 0;
}

.bf-btn {
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  font-size: var(--font-xs);
  padding: 3px 10px;
  cursor: pointer;
}

.bf-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.bf-retry {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 50%, transparent);
}

.bf-close {
  padding: 3px 8px;
}

.bf-list {
  border-top: 1px solid color-mix(in srgb, var(--danger) 25%, transparent);
  max-height: 260px;
  overflow-y: auto;
  padding: 4px 0;
}

.bf-item {
  display: flex;
  gap: 10px;
  padding: 3px 12px;
  align-items: baseline;
}

.bf-name {
  color: var(--text);
  flex-shrink: 0;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bf-error {
  color: var(--danger);
  overflow-wrap: anywhere;
}

.bf-more {
  margin: 6px 12px;
}
</style>
