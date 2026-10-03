<script setup>
import { computed } from 'vue'
import { selectedModel } from '../../store/appStore'

/**
 * 文件元数据自动解析面板（C1 自 ModelDetail.vue 拆出）：
 * 展示 safetensors 头部解析信息（kohya ss_* / modelspec.*），提供
 * 训练分辨率与触发词候选的一键填入（事件上抛，表单归属父组件）。
 * 只展示与填入，不写入元数据、不覆盖用户标注。
 */

/** safetensors 头部自动解析信息（仅 .safetensors 且含有效元信息时非空） */
const autoInfo = computed(() => selectedModel.value?.autoInfo || null)

/** 触发词候选（来自训练集高频标签，仅 LoRA 提供填入，需用户确认后保存） */
const autoTriggerCandidates = computed(() =>
  selectedModel.value?.type === 'lora' ? autoInfo.value?.triggerCandidates || [] : []
)

function applyResolution() {
  const a = autoInfo.value
  if (!a || !Number.isFinite(a.resMin)) return
  emit('apply-resolution', a.resMin, Number.isFinite(a.resMax) ? a.resMax : a.resMin)
}

function applyTriggers() {
  if (autoTriggerCandidates.value.length === 0) return
  emit('apply-triggers', autoTriggerCandidates.value)
}

const emit = defineEmits(['apply-resolution', 'apply-triggers'])
</script>

<template>
  <div v-if="autoInfo" class="autoinfo-panel">
    <div class="autoinfo-head">
      <span class="autoinfo-title">文件元数据（自动解析）</span>
    </div>
    <dl class="autoinfo-list">
      <template v-if="autoInfo.title">
        <dt>标题</dt>
        <dd :title="autoInfo.title">{{ autoInfo.title }}</dd>
      </template>
      <template v-if="autoInfo.author">
        <dt>作者</dt>
        <dd>{{ autoInfo.author }}</dd>
      </template>
      <template v-if="autoInfo.baseModel">
        <dt>基底模型</dt>
        <dd>{{ autoInfo.baseModel }}</dd>
      </template>
      <template v-if="autoInfo.networkModule">
        <dt>网络结构</dt>
        <dd>
          {{ autoInfo.networkModule }}<template v-if="autoInfo.networkAlpha !== null">（α={{ autoInfo.networkAlpha }}）</template>
        </dd>
      </template>
      <template v-if="autoInfo.precision">
        <dt>训练精度</dt>
        <dd>{{ autoInfo.precision }}</dd>
      </template>
      <template v-if="Number.isFinite(autoInfo.resMin)">
        <dt>训练分辨率</dt>
        <dd>{{ autoInfo.resMin }} × {{ autoInfo.resMax }}</dd>
      </template>
    </dl>
    <div v-if="autoTriggerCandidates.length" class="autoinfo-words">
      <span v-for="w in autoTriggerCandidates" :key="w" class="autoinfo-word" :title="w">{{ w }}</span>
    </div>
    <div v-if="Number.isFinite(autoInfo.resMin) || autoTriggerCandidates.length" class="autoinfo-actions">
      <button
        v-if="Number.isFinite(autoInfo.resMin)"
        class="btn"
        type="button"
        @click="applyResolution"
      >填入推荐分辨率</button>
      <button
        v-if="autoTriggerCandidates.length"
        class="btn btn-primary"
        type="button"
        @click="applyTriggers"
      >填入触发词</button>
    </div>
  </div>
</template>

<style scoped>
.autoinfo-panel {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.autoinfo-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.autoinfo-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  letter-spacing: 1px;
}

.autoinfo-list {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px 12px;
  font-size: 12px;
}

.autoinfo-list dt {
  color: var(--text-muted);
  flex-shrink: 0;
}

.autoinfo-list dd {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}

/* 触发词标签行与操作行 */
.autoinfo-words {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.autoinfo-word {
  font-size: 11px;
  padding: 3px 9px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-card);
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.autoinfo-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}
</style>
