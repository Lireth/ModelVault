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

/** 触发词候选（来自训练集高频标签 ss_tag_frequency，需用户确认后保存）。
 *  F3 修正：不限 LoRA——不少 Checkpoint 同样内嵌训练标签，此前被静默丢弃 */
const autoTriggerCandidates = computed(
  () => autoInfo.value?.triggerCandidates || [],
)

/** 张量索引统计（F-1，本地零网络；旧装饰缓存/非 safetensors 无此字段） */
const tensorStats = computed(() => autoInfo.value?.tensorStats || null)

/** 参数量紧凑展示：B（十亿）/ M（百万）/ K（千），AI 社区通用记法 */
const paramText = computed(() => {
  const n = tensorStats.value?.paramCount
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
})

/** 组件字节占比（0-1 → 百分比；无已分类字节时 null 不渲染） */
const componentPcts = computed(() => {
  const r = tensorStats.value?.componentRatios
  if (!r) return null
  const total = r.textEncoder + r.unet + r.vae
  if (total <= 0) return null
  return {
    textEncoder: Math.round(r.textEncoder * 100),
    unet: Math.round(r.unet * 100),
    vae: Math.max(
      0,
      100 - Math.round(r.textEncoder * 100) - Math.round(r.unet * 100),
    ),
  }
})

function applyResolution() {
  const a = autoInfo.value
  if (!a || !Number.isFinite(a.resMin)) return
  emit(
    'apply-resolution',
    a.resMin,
    Number.isFinite(a.resMax) ? a.resMax : a.resMin,
  )
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
          {{ autoInfo.networkModule
          }}<template v-if="autoInfo.networkAlpha !== null"
            >（α={{ autoInfo.networkAlpha }}）</template
          >
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
      <!-- 张量索引统计（F-1，本地零网络推导）：架构家族 / 参数量 / 主精度 -->
      <template v-if="tensorStats?.architecture">
        <dt>架构（推导）</dt>
        <dd>{{ tensorStats.architecture }}</dd>
      </template>
      <template v-if="paramText">
        <dt>参数量</dt>
        <dd>{{ paramText }}</dd>
      </template>
      <template v-if="tensorStats?.dtypeMain">
        <dt>张量 / 精度</dt>
        <dd>
          {{ tensorStats.tensorCount.toLocaleString() }} 个张量 ·
          {{ tensorStats.dtypeMain }} 为主
        </dd>
      </template>
    </dl>
    <!-- 组件字节构成（F-1）：文本编码器 / UNet(DiT) / VAE 占比条 -->
    <div v-if="componentPcts" class="autoinfo-components">
      <div class="autoinfo-bar" aria-hidden="true">
        <div
          class="autoinfo-seg te"
          :style="{ width: componentPcts.textEncoder + '%' }"
        ></div>
        <div
          class="autoinfo-seg unet"
          :style="{ width: componentPcts.unet + '%' }"
        ></div>
        <div
          class="autoinfo-seg vae"
          :style="{ width: componentPcts.vae + '%' }"
        ></div>
      </div>
      <span class="autoinfo-comp-legend">
        文本编码器 {{ componentPcts.textEncoder }}% · UNet/DiT
        {{ componentPcts.unet }}% · VAE {{ componentPcts.vae }}%
      </span>
    </div>
    <div v-if="autoTriggerCandidates.length" class="autoinfo-words">
      <span
        v-for="w in autoTriggerCandidates"
        :key="w"
        class="autoinfo-word"
        :title="w"
        >{{ w }}</span
      >
    </div>
    <div
      v-if="Number.isFinite(autoInfo.resMin) || autoTriggerCandidates.length"
      class="autoinfo-actions"
    >
      <button
        v-if="Number.isFinite(autoInfo.resMin)"
        class="btn"
        type="button"
        @click="applyResolution"
      >
        填入推荐分辨率
      </button>
      <button
        v-if="autoTriggerCandidates.length"
        class="btn btn-primary"
        type="button"
        @click="applyTriggers"
      >
        填入触发词
      </button>
    </div>
  </div>
</template>

<style scoped>
.autoinfo-panel {
  /* 玻璃信息面板：半透明底 + 亮边，与详情磨砂面板拉开层次 */
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  padding: 12px 16px;
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
  font-size: var(--font-xs);
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
  border-radius: var(--radius-full);
  border: 1px solid var(--glass-border);
  background: color-mix(in srgb, var(--bg-card) 60%, transparent);
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

/* 组件字节构成条（F-1）：三段式占比条 + 图例 */
.autoinfo-components {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.autoinfo-bar {
  display: flex;
  height: 6px;
  border-radius: 3px;
  overflow: hidden;
  background: var(--bg-hover);
}

.autoinfo-seg.te {
  background: var(--accent);
}

.autoinfo-seg.unet {
  background: var(--favorite);
}

.autoinfo-seg.vae {
  background: var(--text-muted);
}

.autoinfo-comp-legend {
  font-size: 11px;
  color: var(--text-muted);
}
</style>
