<script setup>
import {
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
    await setNsfw(model.id, !model.nsfw)
  } catch (err) {
    toast('error', `NSFW 标记操作失败: ${err.message}`)
  }
}

/** 点击星标设置评分（点击当前评分则清零） */
async function onSetRating(value) {
  const model = selectedModel.value
  if (!model) return
  const next = model.rating === value ? 0 : value
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
      :class="{ active: selectedModel.favorite }"
      type="button"
      :title="selectedModel.favorite ? '取消收藏' : '收藏该模型'"
      @click="onToggleFavorite"
    >
      <svg
        viewBox="0 0 24 24"
        width="12"
        height="12"
        :fill="selectedModel.favorite ? 'currentColor' : 'none'"
        stroke="currentColor"
        stroke-width="2"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path
          d="M12 3.6l2.5 5.2 5.7.7-4.2 3.9 1.1 5.6L12 16.1 6.9 19l1.1-5.6-4.2-3.9 5.7-.7z"
        />
      </svg>
      {{ selectedModel.favorite ? '已收藏' : '收藏' }}
    </button>
    <button
      class="nsfw-toggle"
      :class="{ active: selectedModel.nsfw }"
      type="button"
      :title="
        selectedModel.nsfw
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
        :class="{ on: i <= (selectedModel.rating || 0) }"
        type="button"
        @click="onSetRating(i)"
      >
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          :fill="i <= (selectedModel.rating || 0) ? 'currentColor' : 'none'"
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
