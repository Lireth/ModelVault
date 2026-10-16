<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  allFilteredSelected,
  batchApplyTriggers,
  batchCivitaiIdentify,
  batchCivitaiImages,
  batchDeleteModels,
  batchFavorite,
  batchNsfw,
  batchRating,
  batchSetSubCategory,
  batchToggleDisabled,
  exitMultiSelect,
  filteredModels,
  invertSelectionFiltered,
  multiSelectTags,
  multiSelectedModels,
  state,
  toggleSelectAllFiltered
} from '../store/appStore'

/**
 * 多选批量操作栏（E4/E6，O9 自 App.vue 拆出）：位于多选结果行下方。
 * 布局按操作频率分组：选择组（全选/反选/计数/进度）→ 常用组（收藏/NSFW/评分）
 * →「更多」下拉（低频：触发词/Civitai/标签/禁用）→ 危险区（回收站/退出），
 * 危险操作与常规操作物理隔离防误触。
 * in-flight 防护（B6）：批量 IPC 提交期间 state.multiSelect.busy 置位，
 * 全栏按钮禁用防连点，并给出「处理中」忙碌反馈与流动进度条。
 */

/** 批量操作可用：有选中且无进行中的批量提交 */
const batchReady = computed(
  () => state.multiSelect.ids.length > 0 && !state.multiSelect.busy
)

/** 选中模型是否全部处于禁用态（决定菜单项显示「禁用」还是「启用」，F10） */
const batchAllDisabled = computed(() =>
  multiSelectedModels.value.length > 0 && multiSelectedModels.value.every((m) => m.disabled === true)
)

/* ---------------- 「更多」下拉（低频操作收纳） ---------------- */

const moreOpen = ref(false)
const moreEl = ref(null)

function toggleMore() {
  moreOpen.value = !moreOpen.value
}

/** 执行下拉中的批量动作并收起菜单 */
function runMore(action, ...args) {
  moreOpen.value = false
  action(...args)
}

/** 点击菜单外部关闭（挂 document，点击在「更多」锚点外时收起） */
function onDocClick(e) {
  if (moreOpen.value && moreEl.value && !moreEl.value.contains(e.target)) {
    moreOpen.value = false
  }
}

/** Esc 关闭菜单并在捕获阶段截断，避免冒泡触发全局 Esc（退出多选/清搜索词） */
function onMenuKeydown(e) {
  if (e.key === 'Escape' && moreOpen.value) {
    e.stopPropagation()
    moreOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  window.addEventListener('keydown', onMenuKeydown, { capture: true })
})

onUnmounted(() => {
  document.removeEventListener('click', onDocClick)
  window.removeEventListener('keydown', onMenuKeydown, { capture: true })
})
</script>

<template>
  <div v-if="state.folder && state.multiSelect.active" class="batch-bar">
    <!-- 选择组：全选/反选/计数与进度 -->
    <div class="bb-group">
      <button
        class="btn batch-select-all"
        :disabled="filteredModels.length === 0 || state.multiSelect.busy"
        @click="toggleSelectAllFiltered"
      >{{ allFilteredSelected ? '取消全选' : '全选' }}</button>
      <button
        class="btn batch-invert"
        :disabled="filteredModels.length === 0 || state.multiSelect.busy"
        title="当前筛选范围内选中态取反；筛选范围外的已选项保留"
        @click="invertSelectionFiltered"
      >反选</button>
      <span class="batch-count">已选 {{ state.multiSelect.ids.length }}</span>
      <span v-if="state.multiSelect.busy" class="batch-busy">{{ state.multiSelect.progress || '处理中…' }}</span>
      <!-- 流动进度条（不定时长批量 IPC 的忙碌视觉反馈） -->
      <div v-if="state.multiSelect.busy" class="batch-progress" aria-hidden="true">
        <div class="batch-progress-fill"></div>
      </div>
    </div>

    <span class="batch-sep"></span>

    <!-- 常用组：收藏 / NSFW / 评分 -->
    <div class="bb-group">
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
    </div>

    <span class="batch-sep"></span>

    <!-- 「更多」下拉：低频操作收纳（触发词 / Civitai / 标签 / 禁用） -->
    <div ref="moreEl" class="bb-more">
      <button
        class="btn"
        :class="{ on: moreOpen }"
        aria-haspopup="menu"
        :aria-expanded="moreOpen"
        @click.stop="toggleMore"
      >更多<span class="bb-caret" aria-hidden="true">▾</span></button>
      <div v-if="moreOpen" class="bb-menu" role="menu">
        <button
          class="bb-menu-item"
          role="menuitem"
          :disabled="!batchReady"
          title="将各模型 safetensors 自动解析的训练标签候选批量填入触发词（已有触发词的模型不改动）"
          @click="runMore(batchApplyTriggers)"
        >填触发词</button>
        <!-- Civitai 批量操作：与详情页面板同一功能开关（设置页 civitaiEnabled） -->
        <template v-if="state.settings.civitaiEnabled">
          <button
            class="bb-menu-item"
            role="menuitem"
            :disabled="!batchReady"
            title="逐个按文件哈希在 Civitai 反查模型版本并保存链接（大文件哈希已预热缓存，未收录的自动跳过）"
            @click="runMore(batchCivitaiIdentify)"
          >识别 Civitai</button>
          <button
            class="bb-menu-item"
            role="menuitem"
            :disabled="!batchReady"
            title="为没有示例图的选中模型从 Civitai 导入前 4 张示例图作为封面（已有示例图的模型跳过，避免重复导入）"
            @click="runMore(batchCivitaiImages)"
          >获取示例图</button>
        </template>
        <template v-if="multiSelectTags.length">
          <div class="bb-menu-label">标签</div>
          <button
            v-for="t in multiSelectTags"
            :key="t.key"
            class="bb-menu-item"
            role="menuitem"
            :style="batchReady ? { borderColor: t.color, color: t.color } : {}"
            :disabled="!batchReady"
            @click="runMore(batchSetSubCategory, t.key)"
          >{{ t.label }}</button>
        </template>
        <div class="bb-menu-label">文件</div>
        <button
          class="bb-menu-item"
          role="menuitem"
          :disabled="!batchReady"
          :title="batchAllDisabled ? '去掉 .disabled 后缀，绘画工具恢复加载' : '加 .disabled 后缀，绘画工具不再加载（可随时恢复）'"
          @click="runMore(batchToggleDisabled, !batchAllDisabled)"
        >{{ batchAllDisabled ? '启用' : '禁用' }}</button>
      </div>
    </div>

    <span class="batch-sep"></span>

    <!-- 危险区：移入回收站（与常规操作物理隔离）+ 退出多选 -->
    <div class="bb-group">
      <button class="btn btn-danger" :disabled="!batchReady" @click="batchDeleteModels">移入回收站</button>
      <button class="btn" :disabled="state.multiSelect.busy" @click="exitMultiSelect">退出多选</button>
    </div>
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
  box-shadow: 0 4px 20px color-mix(in srgb, var(--accent) 10%, transparent);
}

/* 分组容器：组内间距略小于组间（组间由分隔线 + gap 承担） */
.bb-group {
  display: flex;
  align-items: center;
  gap: 6px;
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

/* 流动进度条：不定时长批量的忙碌视觉，滑块循环移动表示进行中 */
.batch-progress {
  position: relative;
  width: 64px;
  height: 3px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  overflow: hidden;
}

.batch-progress-fill {
  position: absolute;
  top: 0;
  left: 0;
  width: 40%;
  height: 100%;
  border-radius: 2px;
  background: var(--accent);
  animation: batch-progress-slide 1.1s var(--ease-out) infinite;
}

@keyframes batch-progress-slide {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(250%);
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

/* 「更多」下拉锚点与菜单 */
.bb-more {
  position: relative;
}

.bb-more .btn.on {
  border-color: color-mix(in srgb, var(--accent) 60%, transparent);
  color: var(--accent);
}

.bb-caret {
  margin-left: 4px;
  font-size: 10px;
}

.bb-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 60;
  min-width: 168px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg-active) 92%, transparent);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
}

.bb-menu-label {
  padding: 4px 8px 2px;
  font-size: var(--font-xs);
  color: var(--text-muted);
}

.bb-menu-item {
  text-align: left;
  padding: 6px 8px;
  font-size: var(--font-xs);
  color: var(--text);
  background: transparent;
  border: 1px solid transparent;
  border-radius: calc(var(--radius-md) - 2px);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}

.bb-menu-item:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}

.bb-menu-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
