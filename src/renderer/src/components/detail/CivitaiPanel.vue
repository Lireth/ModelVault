<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { matchCivitai, selectedModel, toast } from '../../store/appStore'

/**
 * Civitai 匹配面板（C1 自 ModelDetail.vue 拆出）：
 * - 面板自持匹配状态（结果/进行中/进度），父组件经模板 ref 调用 match()
 *   触发（详情页头部按钮），经 apply-params / append-words 事件回填表单；
 * - 竞态防护（A2）：大文件哈希需数秒，响应返回时校验仍是发起请求的模型，
 *   晚到响应不再写入已切换模型的详情面板；
 * - 哈希进度与取消（E9）：主进程经 models:civitaiProgress 推送进度，
 *   models:cancelCivitai 可取消进行中的匹配。
 */

const busy = ref(false)
/** 匹配结果（{ matched, hash, info }），切换模型时清空 */
const result = ref(null)
/** 哈希计算进度（{ percent }），无进度数据时为 null */
const progress = ref(null)

const progressPercent = computed(() => {
  const p = progress.value?.percent
  return typeof p === 'number' ? p : 0
})

const progressText = computed(() =>
  progress.value ? `哈希计算中 ${progressPercent.value}%` : '准备中…'
)

/** 请求 Civitai 匹配当前模型（父组件经模板 ref 调用） */
async function match() {
  const model = selectedModel.value
  if (!model || busy.value) return
  busy.value = true
  progress.value = null
  try {
    const res = await matchCivitai(model.id)
    // 请求期间（大文件哈希需数秒）用户可能已切换模型：晚到的响应若无条件写入，
    // A 模型的匹配结果会挂到 B 模型的详情面板下，误导用户错用推荐参数与触发词
    if (selectedModel.value?.id !== model.id) return
    if (res.canceled) return
    if (res.error) {
      toast('error', res.error)
      return
    }
    result.value = res
    if (!res.matched) {
      toast('warn', '未在 Civitai 找到与该文件哈希匹配的模型版本')
    }
  } catch (err) {
    toast('error', `Civitai 匹配失败: ${err.message}`)
  } finally {
    busy.value = false
  }
}

/** 取消进行中的匹配（主进程中止哈希计算并返回 { canceled: true }） */
function onCancel() {
  const model = selectedModel.value
  if (model) window.api.models.cancelCivitai(model.id).catch(() => {})
}

function closeResult() {
  result.value = null
}

// 切换模型时清空匹配结果与进度（原 ModelDetail 独立 watch 迁移）
watch(
  () => selectedModel.value?.id,
  () => {
    result.value = null
    progress.value = null
  }
)

/** 订阅主进程哈希进度推送（仅接受当前模型的进度） */
let unsubscribeProgress = null
onMounted(() => {
  unsubscribeProgress = window.api.models.onCivitaiProgress?.((p) => {
    if (p?.id === selectedModel.value?.id && busy.value) {
      progress.value = p
    }
  })
})
onBeforeUnmount(() => {
  unsubscribeProgress?.()
  unsubscribeProgress = null
})

defineExpose({ match, busy })
</script>

<template>
  <div v-if="busy || result?.matched" class="civitai-panel">
    <div class="civitai-head">
      <span class="civitai-title">Civitai 匹配</span>
      <button v-if="result?.matched" class="civitai-close" title="关闭" type="button" @click="closeResult">✕</button>
    </div>

    <!-- 哈希计算进度（E9）：大文件匹配数秒无反馈易被误认为卡死 -->
    <div v-if="busy" class="civitai-progress">
      <div class="civitai-progress-track">
        <div class="civitai-progress-bar" :style="{ width: `${progressPercent}%` }"></div>
      </div>
      <span class="civitai-progress-text">{{ progressText }}</span>
      <button class="btn civitai-cancel" type="button" @click="onCancel">取消</button>
    </div>

    <template v-if="result?.matched">
      <p class="civitai-name" :title="result.info?.modelName">
        {{ result.info?.modelName || '未知模型' }}
        <span v-if="result.info?.versionName"> · {{ result.info.versionName }}</span>
      </p>
      <p class="civitai-meta">
        <span v-if="result.info?.creator">作者 {{ result.info.creator }}</span>
        <span v-if="result.info?.baseModel">基底 {{ result.info.baseModel }}</span>
        <span v-if="result.info?.precision">{{ result.info.precision }}</span>
      </p>
      <div v-if="result.info?.trainedWords?.length" class="civitai-words">
        <span v-for="w in result.info.trainedWords" :key="w" class="civitai-word" :title="w">{{ w }}</span>
      </div>
      <div class="civitai-actions">
        <button
          v-if="result.info?.trainedWords?.length"
          class="btn"
          type="button"
          @click="$emit('append-words', result.info.trainedWords)"
        >触发词追加到备注</button>
        <button
          v-if="result.info?.exampleParams"
          class="btn btn-primary"
          type="button"
          @click="$emit('apply-params', { exampleParams: result.info.exampleParams, precision: result.info.precision })"
        >应用推荐参数</button>
        <a
          v-if="result.info?.pageUrl"
          class="civitai-link"
          :href="result.info.pageUrl"
          target="_blank"
        >打开模型页面 ↗</a>
      </div>
    </template>
  </div>
</template>

<style scoped>
.civitai-panel {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.civitai-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.civitai-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  letter-spacing: 1px;
}

.civitai-close {
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 6px;
}

.civitai-close:hover {
  background: var(--bg-hover);
  color: var(--text);
}

/* 哈希进度行：细进度条 + 百分比 + 取消按钮 */
.civitai-progress {
  display: flex;
  align-items: center;
  gap: 10px;
}

.civitai-progress-track {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: var(--bg-active);
  overflow: hidden;
}

.civitai-progress-bar {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width 0.15s ease;
}

.civitai-progress-text {
  font-size: 11px;
  color: var(--text-muted);
  min-width: 92px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.civitai-cancel {
  flex-shrink: 0;
  padding: 4px 12px;
  font-size: 12px;
}

.civitai-name {
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.civitai-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 12px;
  color: var(--text-muted);
}

/* 触发词标签行：与 AutoInfoPanel 共用同一套样式（各自 scoped 维护） */
.civitai-words {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.civitai-word {
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

.civitai-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}

.civitai-link {
  font-size: 12px;
  color: var(--accent);
  text-decoration: none;
}

.civitai-link:hover {
  text-decoration: underline;
}
</style>
