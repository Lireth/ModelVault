<script setup>
import { computed } from 'vue'
import {
  compatibilityInfo,
  filterCompatibleModels,
  openDetail,
} from '../../store/appStore'

/**
 * 基底兼容性面板（F6）：
 * 详情页按归一化基底家族展示库内可搭配的对向模型（LoRA ↔ Checkpoint），
 * 纯本地派生、零网络。未知基底与「其他基底」明确提示不猜测兼容性；
 * 列表最多展示 6 项，其余以总数提示，避免长列表挤压信息列。
 */

const info = compatibilityInfo

/** 面板最多直接列出的兼容项数量 */
const MAX_VISIBLE = 6

const visibleCounterparts = computed(() =>
  info.value.counterparts.slice(0, MAX_VISIBLE),
)

/** 非 ok 状态的可读说明（ok 时列表自身表达，不重复文案） */
const statusText = computed(() => {
  switch (info.value.status) {
    case 'unknown':
      return '未解析到基底模型，暂无法判断兼容性；Civitai 识别或补充基底信息后可自动判定。'
    case 'unclassified':
      return '基底被归为「其他基底」，为避免误判不展示兼容列表。'
    case 'no-match':
      return `库内暂无同基底的${info.value.counterpartLabel}。`
    case 'unsupported':
      return '仅 LoRA 与 Checkpoint 参与基底兼容性判断。'
    default:
      return ''
  }
})

/** 打开兼容模型详情（复用详情页的脏表单确认与使用轨迹记录） */
function openCounterpart(id) {
  void openDetail(id)
}

/** 在列表中筛选全部同基底对向模型 */
function applyFilter() {
  void filterCompatibleModels()
}
</script>

<template>
  <div v-if="info.supported" class="compat-panel">
    <div class="compat-head">
      <span class="compat-title">基底兼容性</span>
      <span v-if="info.familyLabel" class="compat-chip">{{
        info.familyLabel
      }}</span>
    </div>

    <p v-if="info.rawBaseModel" class="compat-base" :title="info.rawBaseModel">
      基底：{{ info.rawBaseModel }}
    </p>

    <template v-if="info.status === 'ok'">
      <div class="compat-sub">
        兼容 {{ info.counterpartLabel }}（{{ info.total }}）
      </div>
      <div class="compat-list">
        <button
          v-for="model in visibleCounterparts"
          :key="model.id"
          class="compat-item"
          type="button"
          :title="model.alias || model.name"
          @click="openCounterpart(model.id)"
        >
          <span class="compat-name">{{ model.alias || model.name }}</span>
          <span v-if="model.disabled" class="compat-disabled">已禁用</span>
        </button>
        <span v-if="info.total > MAX_VISIBLE" class="compat-more"
          >等 {{ info.total }} 个</span
        >
      </div>
      <button class="btn compat-filter" type="button" @click="applyFilter">
        在列表中筛选{{ info.counterpartLabel }}
      </button>
    </template>

    <p v-else class="compat-note">{{ statusText }}</p>
  </div>
</template>

<style scoped>
.compat-panel {
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.compat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.compat-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  letter-spacing: 1px;
}

.compat-chip {
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--accent);
  font-size: 10px;
  white-space: nowrap;
}

.compat-base {
  color: var(--text-muted);
  font-size: var(--font-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.compat-sub {
  font-size: var(--font-xs);
  color: var(--text-muted);
}

.compat-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.compat-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--bg-card) 55%, transparent);
  color: var(--text);
  font-size: var(--font-xs);
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}

.compat-item:hover {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}

.compat-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.compat-disabled {
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: 10px;
}

.compat-more {
  color: var(--text-muted);
  font-size: 10px;
}

.compat-filter {
  align-self: flex-start;
}

.compat-note {
  color: var(--text-muted);
  font-size: var(--font-xs);
  line-height: 1.5;
}
</style>
