<script setup>
import { computed, ref, watch } from 'vue'
import {
  formatSize,
  multiSelectIdSet,
  openDetail,
  showContextMenu,
  state,
  subCategoryInfo,
  toggleFavorite,
  toggleSelect,
  typeInfo
} from '../store/appStore'

const props = defineProps({
  model: { type: Object, required: true }
})

/** 封面 URL 加载失败标记（文件被移动/删除时回退占位符，避免碎图） */
const coverError = ref(false)
watch(
  () => props.model.coverUrl,
  () => {
    coverError.value = false
  }
)

const info = computed(() => typeInfo(props.model.type))

/** 多选模式（E4）：点击卡片切换选中态而非打开详情（O4：Set 命中 O(1)） */
const selected = computed(() => multiSelectIdSet.value.has(props.model.id))

function onCardActivate() {
  if (state.multiSelect.active) toggleSelect(props.model.id)
  else openDetail(props.model.id)
}

/** 收藏/取消收藏（阻止冒泡，避免打开详情页） */
function onToggleFavorite() {
  toggleFavorite(props.model.id)
}

/** 右键菜单（阻止默认浏览器菜单） */
function onContextMenu() {
  showContextMenu(props.model.id)
}

/** 显示名称：备注名优先，为空时回退文件名 */
const displayName = computed(() => props.model.alias || props.model.name)

/** 已标注的分类标签（支持其他模型二级分类、LoRA 分类、大模型基底模型） */
const TAGGED_TYPES = ['other', 'lora', 'checkpoint']
const subTag = computed(() => {
  if (!TAGGED_TYPES.includes(props.model.type) || !props.model.subCategory) return null
  return subCategoryInfo(props.model.subCategory)
})

/** 参数摘要：卡片底部一行展示已填写的推荐参数 */
const paramSummary = computed(() => {
  const p = props.model.params
  if (!p) return ''
  const parts = []
  if (Number.isFinite(p.steps)) parts.push(`${p.steps} 步`)
  // CFG 区间：min/max 相等或缺失时只显示单个值
  if (Number.isFinite(p.cfgMin) && Number.isFinite(p.cfgMax) && p.cfgMin !== p.cfgMax) {
    parts.push(`CFG ${p.cfgMin}~${p.cfgMax}`)
  } else if (Number.isFinite(p.cfgMin)) {
    parts.push(`CFG ${p.cfgMin}`)
  } else if (Number.isFinite(p.cfgMax)) {
    parts.push(`CFG ${p.cfgMax}`)
  }
  if (p.sampler) parts.push(p.sampler)
  if (Number.isFinite(p.resMin) && Number.isFinite(p.resMax)) {
    parts.push(`${p.resMin}~${p.resMax}px`)
  }
  return parts.join(' · ')
})

const mtimeText = computed(() => {
  const d = new Date(props.model.mtimeMs)
  return d.toLocaleDateString('zh-CN')
})
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
    @click="onCardActivate"
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
    >{{ selected ? '✓' : '' }}</span>
    <div class="cover">
      <img
        v-if="model.coverUrl && !coverError"
        :src="model.coverUrl"
        :alt="model.name"
        loading="lazy"
        draggable="false"
        :class="{ blurred: model.nsfw }"
        @error="coverError = true"
      />
      <div v-else class="cover-placeholder">
        <span class="cover-ext">{{ model.ext }}</span>
      </div>
      <span class="type-badge" :style="{ background: info.color }">{{ info.label }}</span>
      <span v-if="model.nsfw" class="nsfw-badge">NSFW</span>
      <span v-if="subTag" class="sub-badge" :style="{ color: subTag.color, borderColor: subTag.color }">
        {{ subTag.label }}
      </span>
    </div>
    <div class="card-body">
      <div class="name-row">
        <h4 class="model-name" :title="model.name">{{ displayName }}</h4>
        <button
          class="fav-btn"
          :class="{ active: model.favorite }"
          :title="model.favorite ? '取消收藏' : '收藏'"
          @click.stop="onToggleFavorite"
        >★</button>
      </div>
      <div v-if="state.settings.showSize || state.settings.showMtime" class="model-meta">
        <span v-if="state.settings.showSize">{{ formatSize(model.size) }}</span>
        <span v-if="state.settings.showMtime">{{ mtimeText }}</span>
      </div>
      <p v-if="state.settings.showParams && paramSummary" class="param-summary" :title="paramSummary">{{ paramSummary }}</p>
      <p v-else-if="state.settings.showParams" class="param-summary empty">未设置推荐参数</p>
    </div>
  </article>
</template>

<style scoped>
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
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
  cursor: pointer;
  transition: color 0.12s ease;
}

.fav-btn:hover {
  color: var(--favorite);
}

.fav-btn.active {
  color: var(--favorite);
}

.name-row .model-name {
  flex: 1;
  min-width: 0;
}
.model-card {
  position: relative;
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

/* 多选选中态（E4）：强调边框 + 勾选角标 */
.model-card.selected {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent) inset;
}

.select-check {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  border: 1.5px solid var(--border);
  background: var(--bg-card);
  color: var(--on-bright);
  font-size: 12px;
  font-weight: 700;
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

.cover {
  position: relative;
  aspect-ratio: 2 / 3;
  background: var(--bg);
  overflow: hidden;
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* NSFW 模型：首页预览图模糊展示（详情页正常显示） */
.cover img.blurred {
  filter: blur(14px);
  transform: scale(1.1); /* 放大避免模糊边缘露出原图 */
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
  font-family: var(--font-mono);
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
  color: var(--on-bright);
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
  background: var(--overlay);
  backdrop-filter: blur(2px);
}

/* NSFW 标记角标：位于封面左下角（左上为类型角标、右上为分类角标） */
.nsfw-badge {
  position: absolute;
  bottom: 8px;
  left: 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1px;
  color: #fff;
  background: var(--danger);
  padding: 2px 8px;
  border-radius: 999px;
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
