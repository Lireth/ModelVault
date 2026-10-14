<script setup>
import { computed, ref, watch } from 'vue'
import { civitaiComplete, civitaiIdentify, selectedModel, state } from '../../store/appStore'

/**
 * Civitai 在线识别面板（详情页）：
 * - 识别：按文件 SHA256 经 Civitai API 反查模型版本，成功时在详情页展示
 *   模型页链接（外链经主进程白名单拉起系统浏览器）；
 * - 一键补全：仅填充空缺的触发词/备注（主进程保证不覆盖用户标注）。
 * 功能开关由设置页 civitaiEnabled 控制（关闭时整个面板隐藏）。
 * 识别/补全结果写入主进程元数据并同步到本地列表；列表元素替换会触发
 * 父组件表单重填（表单无脏编辑时），无需再上抛事件。
 */

/** 最近一次识别结论：'' | 'notfound'（未收录） */
const lastResult = ref('')
const identifying = ref(false)
const completing = ref(false)

const model = computed(() => selectedModel.value)
/** 已识别：详情页展示模型页链接 */
const identified = computed(() => !!model.value?.civitaiUrl)

// 切换模型时清空上次识别结论（URL 本身随模型对象走，无需清理）
watch(
  () => model.value?.id,
  () => {
    lastResult.value = ''
  }
)

/** 点击识别：大文件哈希计算可能耗时数十秒，期间禁用按钮并提示 */
async function onIdentify() {
  if (!model.value || identifying.value || completing.value) return
  identifying.value = true
  lastResult.value = ''
  try {
    const res = await civitaiIdentify(model.value.id)
    if (!res.error && !res.found) lastResult.value = 'notfound'
  } finally {
    identifying.value = false
  }
}

/** 点击一键补全（仅填充空缺字段，结果提示由 store 层 toast） */
async function onComplete() {
  if (!model.value || identifying.value || completing.value) return
  completing.value = true
  try {
    await civitaiComplete(model.value.id)
  } finally {
    completing.value = false
  }
}
</script>

<template>
  <div v-if="state.settings.civitaiEnabled" class="civitai-panel">
    <div class="civitai-head">
      <span class="civitai-title">Civitai 识别</span>
    </div>

    <!-- 已识别：展示模型页链接 + 一键补全 -->
    <template v-if="identified">
      <a
        class="civitai-link"
        :href="model.civitaiUrl"
        target="_blank"
        rel="noopener noreferrer"
        :title="`${model.civitaiUrl}（点击在浏览器打开）`"
      >在 Civitai 打开模型页 ↗</a>
      <div class="civitai-actions">
        <button
          class="btn btn-primary"
          type="button"
          :disabled="completing || identifying"
          :title="model.triggerWords || model.note ? '仅填充空缺的触发词与备注，不覆盖已有内容' : '从 Civitai 拉取触发词与描述填充空缺字段'"
          @click="onComplete"
        >{{ completing ? '补全中…' : '一键补全' }}</button>
      </div>
    </template>

    <!-- 未识别：识别入口 -->
    <template v-else>
      <div class="civitai-actions">
        <button
          class="btn"
          type="button"
          :disabled="identifying"
          title="计算文件 SHA256 并在 Civitai 查询匹配的模型版本"
          @click="onIdentify"
        >{{ identifying ? '识别中…' : '识别 Civitai 模型' }}</button>
      </div>
      <span v-if="identifying" class="civitai-hint">
        正在计算文件哈希并查询 Civitai，大文件可能耗时较长…
      </span>
      <span v-else-if="lastResult === 'notfound'" class="civitai-hint">
        未在 Civitai 找到匹配的模型（自训或其他来源的模型无法识别）
      </span>
      <span v-else class="civitai-hint">
        识别成功后可展示模型页链接，并对空缺的触发词/备注一键补全
      </span>
    </template>
  </div>
</template>

<style scoped>
.civitai-panel {
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  padding: 12px 16px;
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

.civitai-link {
  font-size: var(--font-xs);
  color: var(--accent);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.civitai-link:hover {
  text-decoration: underline;
}

.civitai-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.civitai-hint {
  font-size: 11px;
  color: var(--text-muted);
}
</style>
