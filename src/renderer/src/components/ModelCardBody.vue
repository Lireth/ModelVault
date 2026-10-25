<script setup>
import { computed } from 'vue'
import {
  formatDate,
  formatParamSummary,
  formatSize,
  state,
  toggleFavorite,
} from '../store/appStore'

/**
 * 模型卡片主体（OPT-01 自 ModelCard.vue 按域拆出）：
 * 名称行（备注名 + 收藏星标）、文件大小/修改日期、自由标签角标、
 * 推荐参数摘要。展示开关（showSize/showMtime/showParams）随设置实时生效。
 */

const props = defineProps({
  model: { type: Object, required: true },
  /** 显示名称（备注名优先，为空时回退文件名；父组件同源计算） */
  displayName: { type: String, default: '' },
})

/** 卡片展示的自由标签（F-5）：最多 3 个，溢出以 +N 收尾 */
const cardTags = computed(() => (props.model.tags || []).slice(0, 3))

/** 参数摘要：卡片底部一行展示已填写的推荐参数（与列表视图共用格式化） */
const paramSummary = computed(() => formatParamSummary(props.model.params))

const mtimeText = computed(() => formatDate(props.model.mtimeMs))

/** 收藏/取消收藏（click 与键盘 Enter/Space 均在模板层阻断冒泡，避免打开详情页，OPT-3） */
function onToggleFavorite() {
  toggleFavorite(props.model.id)
}
</script>

<template>
  <div class="card-body">
    <div class="name-row">
      <h4 class="model-name" :title="model.name">{{ displayName }}</h4>
      <!-- 收藏/取消收藏。click 与 Enter/Space 的 keydown 均需阻断冒泡：
           keydown 若不阻断会冒泡到 article 的 @keydown.enter/space 触发
           打开详情（onCardActivate），与按钮原生 click 的收藏动作叠加，
           键盘聚焦本按钮按键时形成一次按键两个动作（OPT-3）；
           .prevent 同时阻止 Space 的默认滚动行为（与 article 的处理一致） -->
      <button
        class="fav-btn"
        :class="{ active: model.favorite }"
        :title="model.favorite ? '取消收藏' : '收藏'"
        @click.stop="onToggleFavorite"
        @keydown.enter.stop.prevent
        @keydown.space.stop.prevent
      >
        <svg
          viewBox="0 0 24 24"
          width="15"
          height="15"
          :fill="model.favorite ? 'currentColor' : 'none'"
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
    </div>
    <div
      v-if="state.settings.showSize || state.settings.showMtime"
      class="model-meta"
    >
      <span v-if="state.settings.showSize">{{ formatSize(model.size) }}</span>
      <span v-if="state.settings.showMtime">{{ mtimeText }}</span>
    </div>
    <!-- 自由标签角标（F-5）：最多展示 3 个，溢出计数收尾 -->
    <div v-if="cardTags.length" class="tag-row">
      <span v-for="t in cardTags" :key="t" class="card-tag">{{ t }}</span>
      <span
        v-if="(model.tags || []).length > cardTags.length"
        class="card-tag more"
      >
        +{{ model.tags.length - cardTags.length }}
      </span>
    </div>
    <p
      v-if="state.settings.showParams && paramSummary"
      class="param-summary"
      :title="paramSummary"
    >
      {{ paramSummary }}
    </p>
    <p v-else-if="state.settings.showParams" class="param-summary empty">
      未设置推荐参数
    </p>
  </div>
</template>

<style scoped>
.card-body {
  padding: 12px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

/* 名称 + 收藏星标行 */
.name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.fav-btn {
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
  transition:
    color var(--dur-fast) var(--ease-out),
    filter var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}

.fav-btn:hover {
  color: var(--favorite);
  transform: scale(1.12);
}

/* 已收藏：金色 + 微光晕 */
.fav-btn.active {
  color: var(--favorite);
  filter: drop-shadow(0 0 5px rgba(245, 179, 1, 0.4));
}

.name-row .model-name {
  flex: 1;
  min-width: 0;
}

.model-name {
  font-size: var(--font-sm);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-meta {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-muted);
}

.param-summary {
  font-size: 11px;
  color: var(--accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.param-summary.empty {
  color: var(--text-muted);
  opacity: 0.7;
}

/* 自由标签角标（F-5）：小型胶囊，视觉弱于分类标签 */
.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.card-tag {
  font-size: 10px;
  padding: 1px 8px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
  max-width: 88px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-tag.more {
  background: var(--bg-hover);
  color: var(--text-muted);
}
</style>
