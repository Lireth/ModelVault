<script setup>
import { computed } from 'vue'
import {
  allFilteredSelected,
  batchApplyTriggers,
  batchDeleteModels,
  batchFavorite,
  batchNsfw,
  batchRating,
  batchSetSubCategory,
  batchToggleDisabled,
  exitMultiSelect,
  filteredModels,
  multiSelectTags,
  multiSelectedModels,
  state,
  toggleSelectAllFiltered
} from '../store/appStore'

/**
 * 多选批量操作栏（E4/E6，O9 自 App.vue 拆出）：位于搜索行下方。
 * in-flight 防护（B6）：批量 IPC 逐个并发提交期间 state.multiSelect.busy
 * 置位，全栏按钮禁用防连点重复提交，并给出「处理中」忙碌反馈。
 */

/** 批量操作可用：有选中且无进行中的批量提交 */
const batchReady = computed(
  () => state.multiSelect.ids.length > 0 && !state.multiSelect.busy
)

/** 选中模型是否全部处于禁用态（决定按钮显示「禁用」还是「启用」，F10） */
const batchAllDisabled = computed(() =>
  multiSelectedModels.value.length > 0 && multiSelectedModels.value.every((m) => m.disabled === true)
)
</script>

<template>
  <div v-if="state.folder && state.multiSelect.active" class="batch-bar">
    <button
      class="btn batch-select-all"
      :disabled="filteredModels.length === 0 || state.multiSelect.busy"
      @click="toggleSelectAllFiltered"
    >{{ allFilteredSelected ? '取消全选' : '全选' }}</button>
    <span class="batch-count">已选 {{ state.multiSelect.ids.length }}</span>
    <span v-if="state.multiSelect.busy" class="batch-busy">处理中…</span>
    <span class="batch-sep"></span>
    <button class="btn" :disabled="!batchReady" @click="batchFavorite(true)">收藏</button>
    <button class="btn" :disabled="!batchReady" @click="batchFavorite(false)">取消收藏</button>
    <button class="btn" :disabled="!batchReady" @click="batchNsfw(true)">标记 NSFW</button>
    <button class="btn" :disabled="!batchReady" @click="batchNsfw(false)">取消 NSFW</button>
    <span class="batch-label">评分</span>
    <button
      v-for="i in 5"
      :key="i"
      class="batch-star"
      :disabled="!batchReady"
      :title="`批量评 ${i} 星`"
      @click="batchRating(i)"
    ><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.6l2.5 5.2 5.7.7-4.2 3.9 1.1 5.6L12 16.1 6.9 19l1.1-5.6-4.2-3.9 5.7-.7z" /></svg></button>
    <button
      class="btn"
      :disabled="!batchReady"
      title="将各模型 safetensors 自动解析的训练标签候选批量填入触发词（已有触发词的模型不改动）"
      @click="batchApplyTriggers"
    >填触发词</button>
    <template v-if="multiSelectTags.length">
      <span class="batch-sep"></span>
      <span class="batch-label">标签</span>
      <button
        v-for="t in multiSelectTags"
        :key="t.key"
        class="btn"
        :style="batchReady ? { borderColor: t.color, color: t.color } : {}"
        :disabled="!batchReady"
        @click="batchSetSubCategory(t.key)"
      >{{ t.label }}</button>
    </template>
    <span class="batch-sep"></span>
    <button
      class="btn"
      :disabled="!batchReady"
      :title="batchAllDisabled ? '去掉 .disabled 后缀，绘画工具恢复加载' : '加 .disabled 后缀，绘画工具不再加载（可随时恢复）'"
      @click="batchToggleDisabled(!batchAllDisabled)"
    >{{ batchAllDisabled ? '启用' : '禁用' }}</button>
    <button class="btn btn-danger" :disabled="!batchReady" @click="batchDeleteModels">移入回收站</button>
    <button class="btn" :disabled="state.multiSelect.busy" @click="exitMultiSelect">退出多选</button>
  </div>
</template>

<style scoped>
.batch-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  /* 玻璃操作条：磨砂底 + 强调色描边微光，提示处于多选模式 */
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg-active) 72%, transparent);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  box-shadow: 0 4px 20px rgba(90, 163, 250, 0.1);
}

.batch-count {
  font-size: var(--font-xs);
  color: var(--accent);
  font-weight: 600;
  min-width: 52px;
}

/* 批量提交进行中的忙碌提示（B6） */
.batch-busy {
  font-size: var(--font-xs);
  color: var(--text-muted);
  animation: batch-busy-pulse 1.2s ease-in-out infinite;
}

@keyframes batch-busy-pulse {
  50% {
    opacity: 0.45;
  }
}

.batch-label {
  font-size: var(--font-xs);
  color: var(--text-muted);
}

.batch-sep {
  width: 1px;
  height: 18px;
  background: var(--border);
  margin: 0 4px;
}

.batch-star {
  border: none;
  background: transparent;
  color: var(--border);
  line-height: 1;
  padding: 1px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  transition: color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}

.batch-star:hover:not(:disabled) {
  transform: scale(1.2);
  color: var(--favorite);
}

.batch-bar .btn {
  padding: 5px 12px;
  font-size: var(--font-xs);
}
</style>
