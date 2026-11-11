<script setup>
import { computed } from 'vue'
import {
  effectiveFavorite,
  effectiveNsfw,
  effectiveRating,
  formatDate,
  selectedModel,
  setNsfw,
  setRating,
  toast,
  toggleFavorite,
} from '../../store/appStore'

/**
 * 详情表单列「收藏 / 评分」行（OPT-01 自 MetaForm.vue 按域拆出）：
 * 收藏切换、NSFW 标记切换、五星评分（点击当前星标清零）。
 * 与表单本地副本无关，直接经 store 即时保存。
 * P1-1：展示态经标注覆盖层读取——即时标注后模型对象保持引用稳定，
 * 覆盖写入按覆盖键精确重渲染本组件。
 */

/** 详情页切换收藏 */
async function onToggleFavorite() {
  const model = selectedModel.value
  if (!model) return
  try {
    await toggleFavorite(model.id)
  } catch (err) {
    toast('error', `收藏操作失败: ${err.message}`)
  }
}

/** 详情页切换 NSFW 标记（勾选后首页卡片预览图模糊展示） */
async function onToggleNsfw() {
  const model = selectedModel.value
  if (!model) return
  try {
    await setNsfw(model.id, !effectiveNsfw(model))
  } catch (err) {
    toast('error', `NSFW 标记操作失败: ${err.message}`)
  }
}

/**
 * 使用轨迹摘要（F3）：最近打开日期 + 累计次数；从未打开时显式提示，
 * 让「清理长期未用模型」在详情页有直接依据。
 */
const usageText = computed(() => {
  const m = selectedModel.value
  if (!m) return ''
  const openedAt =
    Number.isFinite(m.lastOpenedAt) && m.lastOpenedAt > 0 ? m.lastOpenedAt : 0
  const count =
    Number.isInteger(m.openCount) && m.openCount > 0 ? m.openCount : 0
  if (!openedAt) return '尚未打开'
  return `最近打开 ${formatDate(openedAt)}${count > 0 ? ` · 共 ${count} 次` : ''}`
})

/** 点击星标设置评分（点击当前评分则清零） */
async function onSetRating(value) {
  const model = selectedModel.value
  if (!model) return
  const next = effectiveRating(model) === value ? 0 : value
  try {
    await setRating(model.id, next)
  } catch (err) {
    toast('error', `评分失败: ${err.message}`)
  }
}
</script>

<template>
  <div class="flags-row">
    <button
      class="fav-toggle"
      :class="{ active: effectiveFavorite(selectedModel) }"
      type="button"
      :title="effectiveFavorite(selectedModel) ? '取消收藏' : '收藏该模型'"
      @click="onToggleFavorite"
    >
      <svg
        viewBox="0 0 24 24"
        width="12"
        height="12"
        :fill="effectiveFavorite(selectedModel) ? 'currentColor' : 'none'"
        stroke="currentColor"
        stroke-width="2"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path
          d="M12 3.6l2.5 5.2 5.7.7-4.2 3.9 1.1 5.6L12 16.1 6.9 19l1.1-5.6-4.2-3.9 5.7-.7z"
        />
      </svg>
      {{ effectiveFavorite(selectedModel) ? '已收藏' : '收藏' }}
    </button>
    <button
      class="nsfw-toggle"
      :class="{ active: effectiveNsfw(selectedModel) }"
      type="button"
      :title="
        effectiveNsfw(selectedModel)
          ? '取消 NSFW 标记'
          : '标记为 NSFW（首页预览图将模糊展示，可在设置中关闭）'
      "
      @click="onToggleNsfw"
    >
      NSFW
    </button>
    <div class="rating" title="点击星标评分，再次点击当前星标清除">
      <span class="rating-label">评分</span>
      <button
        v-for="i in 5"
        :key="i"
        class="star"
        :class="{ on: i <= effectiveRating(selectedModel) }"
        type="button"
        @click="onSetRating(i)"
      >
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          :fill="i <= effectiveRating(selectedModel) ? 'currentColor' : 'none'"
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
    <span class="usage-info">{{ usageText }}</span>
  </div>
</template>

<style scoped>
.flags-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
}

.fav-toggle {
  border: 1px solid var(--glass-border-bright);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--text-muted);
  font-size: var(--font-xs);
  padding: 6px 16px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition:
    color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}

.fav-toggle:hover {
  border-color: var(--favorite);
  color: var(--favorite);
}

.fav-toggle.active {
  border-color: var(--favorite);
  color: var(--favorite);
  font-weight: 600;
  box-shadow: var(--glow-favorite);
}

/* NSFW 标记按钮：激活时红色高亮，提示首页预览图将被模糊 */
.nsfw-toggle {
  border: 1px solid var(--glass-border-bright);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--text-muted);
  font-size: var(--font-xs);
  padding: 6px 16px;
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}

.nsfw-toggle:hover {
  border-color: var(--danger);
  color: var(--danger);
}

.nsfw-toggle.active {
  border-color: var(--danger);
  color: var(--danger);
  font-weight: 600;
  background: color-mix(in srgb, var(--danger) 8%, transparent);
}

.rating {
  display: flex;
  align-items: center;
  gap: 2px;
}

.usage-info {
  margin-left: auto;
  color: var(--text-muted);
  font-size: var(--font-xs);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.rating-label {
  font-size: var(--font-xs);
  color: var(--text-muted);
  margin-right: 6px;
}

.star {
  border: none;
  background: transparent;
  color: var(--border);
  line-height: 1;
  padding: 1px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  transition:
    color var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out),
    filter var(--dur-fast) var(--ease-out);
}

.star:hover {
  transform: scale(1.15);
}

.star.on {
  color: var(--favorite);
  filter: drop-shadow(0 0 4px rgba(245, 179, 1, 0.35));
}
</style>
