<script setup>
import { computed } from 'vue'
import { formatSize, openDetail, subCategoryInfo, typeInfo } from '../store/appStore'

const props = defineProps({
  model: { type: Object, required: true }
})

const info = computed(() => typeInfo(props.model.type))

/** 「其他模型」已标注时的二级分类标签 */
const subTag = computed(() => {
  if (props.model.type !== 'other' || !props.model.subCategory) return null
  return subCategoryInfo(props.model.subCategory)
})

/** 参数摘要：卡片底部一行展示已填写的推荐参数 */
const paramSummary = computed(() => {
  const p = props.model.params
  if (!p) return ''
  const parts = []
  if (Number.isFinite(p.steps)) parts.push(`${p.steps} 步`)
  if (Number.isFinite(p.cfg)) parts.push(`CFG ${p.cfg}`)
  if (p.sampler) parts.push(p.sampler)
  if (Number.isFinite(p.resMinW) && Number.isFinite(p.resMaxW)) {
    parts.push(`${p.resMinW}~${p.resMaxW}px`)
  }
  return parts.join(' · ')
})

const mtimeText = computed(() => {
  const d = new Date(props.model.mtimeMs)
  return d.toLocaleDateString('zh-CN')
})
</script>

<template>
  <article class="model-card" :title="model.id" @click="openDetail(model.id)">
    <div class="cover">
      <img
        v-if="model.coverUrl"
        :src="model.coverUrl"
        :alt="model.name"
        loading="lazy"
        draggable="false"
      />
      <div v-else class="cover-placeholder">
        <span class="cover-ext">{{ model.ext }}</span>
      </div>
      <span class="type-badge" :style="{ background: info.color }">{{ info.label }}</span>
      <span v-if="subTag" class="sub-badge" :style="{ color: subTag.color, borderColor: subTag.color }">
        {{ subTag.label }}
      </span>
    </div>
    <div class="card-body">
      <h4 class="model-name" :title="model.name">{{ model.name }}</h4>
      <div class="model-meta">
        <span>{{ formatSize(model.size) }}</span>
        <span>{{ mtimeText }}</span>
      </div>
      <p v-if="paramSummary" class="param-summary" :title="paramSummary">{{ paramSummary }}</p>
      <p v-else class="param-summary empty">未设置推荐参数</p>
    </div>
  </article>
</template>

<style scoped>
.model-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
  transition: transform 0.12s ease, border-color 0.12s ease;
  display: flex;
  flex-direction: column;
}

.model-card:hover {
  transform: translateY(-2px);
  border-color: var(--accent);
}

.cover {
  position: relative;
  aspect-ratio: 4 / 3;
  background: var(--bg);
  overflow: hidden;
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.cover-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: repeating-linear-gradient(45deg, var(--bg) 0 12px, var(--bg-card) 12px 24px);
}

.cover-ext {
  font-family: Consolas, monospace;
  font-size: 13px;
  color: var(--text-muted);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px 12px;
}

.type-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  font-size: 11px;
  font-weight: 600;
  color: #10141a;
  padding: 3px 9px;
  border-radius: 999px;
  opacity: 0.95;
}

.sub-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid;
  background: rgba(16, 20, 26, 0.75);
  backdrop-filter: blur(2px);
}

.card-body {
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.model-name {
  font-size: 13px;
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
</style>
