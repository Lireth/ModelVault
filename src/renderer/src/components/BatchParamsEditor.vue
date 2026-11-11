<script setup>
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import {
  PARAM_LIMITS,
  PRECISIONS,
  SAMPLERS,
  SCHEDULERS,
} from '../constants/modelParams'
import { normalizeBatchParamsPatch, state, toast } from '../store/appStore'

/**
 * 批量推荐参数编辑层（F5）：
 * 从批量栏「更多 → 参数」打开，只填写需要修改的字段；留空字段保持各模型
 * 原值不变，不做整包覆写。提交时把原始表单交给 store 的
 * normalizeBatchParamsPatch 预检，失败留在弹层内提示，成功后由父组件
 * 关闭并执行批量更新。
 *
 * 键盘：Esc 关闭（批量进行中不关闭）；Tab 在弹层内循环。
 */

const emit = defineEmits(['close', 'apply'])

const form = reactive({
  steps: '',
  cfgMin: '',
  cfgMax: '',
  sampler: '',
  scheduler: '',
  precision: '',
  resMin: '',
  resMax: '',
})
const dialogEl = ref(null)
const firstInputEl = ref(null)

const selectedCount = computed(() => state.multiSelect.ids.length)

/** 至少填写一个字段才允许提交（具体范围校验在提交时统一执行） */
const hasInput = computed(() =>
  Object.values(form).some((value) => String(value).trim() !== ''),
)

const summaryText = computed(
  () =>
    `为选中的 ${selectedCount.value} 个模型更新推荐参数；留空字段保持各模型原值不变`,
)

/** 关闭弹层（批量进行中不允许关闭） */
function close() {
  if (state.multiSelect.busy) return
  emit('close')
}

/** 提交：归一化/校验通过后交给父组件执行 */
function submit() {
  if (state.multiSelect.busy) return
  const { patch, error } = normalizeBatchParamsPatch(form)
  if (error) {
    toast('error', error)
    return
  }
  emit('apply', patch)
}

/** 弹层内可聚焦元素（Tab 焦点陷阱） */
function focusables() {
  if (!dialogEl.value) return []
  return [
    ...dialogEl.value.querySelectorAll(
      'button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((el) => !el.disabled && el.offsetParent !== null)
}

/** 弹层键盘：Esc 关闭、Tab 首末循环（避免焦点穿透到背景批量栏/网格） */
function onKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    close()
    return
  }
  if (e.key !== 'Tab') return
  const items = focusables()
  if (items.length === 0) return
  const first = items[0]
  const last = items[items.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

onMounted(() => {
  nextTick(() => firstInputEl.value?.focus())
})
</script>

<template>
  <Teleport to="body">
    <div class="bpe-overlay" @click.self="close" @keydown="onKeydown">
      <section
        ref="dialogEl"
        class="bpe-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bpe-title"
      >
        <header class="bpe-header">
          <div>
            <h2 id="bpe-title">批量编辑推荐参数</h2>
            <p class="bpe-summary">{{ summaryText }}</p>
          </div>
          <button
            class="bpe-close"
            type="button"
            title="关闭（Esc）"
            aria-label="关闭"
            @click="close"
          >
            <svg
              viewBox="0 0 16 16"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        <p class="bpe-hint">
          只更新已填写的字段；留空字段保持各模型原值，不会被清空。
        </p>

        <div class="bpe-grid">
          <label class="bpe-field">
            <span>采样步数</span>
            <input
              ref="firstInputEl"
              v-model="form.steps"
              type="number"
              :min="PARAM_LIMITS.steps.min"
              :max="PARAM_LIMITS.steps.max"
              placeholder="留空不修改，如 28"
            />
          </label>
          <label class="bpe-field bpe-range-field">
            <span>CFG 值（范围）</span>
            <div class="bpe-range">
              <input
                v-model="form.cfgMin"
                type="number"
                :min="PARAM_LIMITS.cfg.min"
                :max="PARAM_LIMITS.cfg.max"
                step="0.5"
                placeholder="最小"
              />
              <input
                v-model="form.cfgMax"
                type="number"
                :min="PARAM_LIMITS.cfg.min"
                :max="PARAM_LIMITS.cfg.max"
                step="0.5"
                placeholder="最大"
              />
            </div>
          </label>
          <label class="bpe-field bpe-range-field">
            <span>推荐分辨率（宽 = 高，px）</span>
            <div class="bpe-range">
              <input
                v-model="form.resMin"
                type="number"
                :min="PARAM_LIMITS.res.min"
                :max="PARAM_LIMITS.res.max"
                placeholder="最小"
              />
              <input
                v-model="form.resMax"
                type="number"
                :min="PARAM_LIMITS.res.min"
                :max="PARAM_LIMITS.res.max"
                placeholder="最大"
              />
            </div>
          </label>
          <label class="bpe-field">
            <span>采样器 (Sampler)</span>
            <input
              v-model="form.sampler"
              list="bpe-sampler-list"
              maxlength="100"
              placeholder="留空不修改"
            />
            <datalist id="bpe-sampler-list">
              <option v-for="s in SAMPLERS" :key="s" :value="s" />
            </datalist>
          </label>
          <label class="bpe-field">
            <span>调度器 (Scheduler)</span>
            <input
              v-model="form.scheduler"
              list="bpe-scheduler-list"
              maxlength="100"
              placeholder="留空不修改"
            />
            <datalist id="bpe-scheduler-list">
              <option v-for="s in SCHEDULERS" :key="s" :value="s" />
            </datalist>
          </label>
          <label class="bpe-field">
            <span>精度 (Precision)</span>
            <input
              v-model="form.precision"
              list="bpe-precision-list"
              maxlength="20"
              placeholder="留空不修改，如 FP16"
            />
            <datalist id="bpe-precision-list">
              <option v-for="p in PRECISIONS" :key="p" :value="p" />
            </datalist>
          </label>
        </div>

        <footer class="bpe-actions">
          <span v-if="state.multiSelect.busy" class="bpe-busy">处理中…</span>
          <button
            class="btn"
            type="button"
            :disabled="state.multiSelect.busy"
            @click="close"
          >
            取消
          </button>
          <button
            class="btn btn-primary"
            type="button"
            :disabled="
              state.multiSelect.busy || !hasInput || selectedCount === 0
            "
            @click="submit"
          >
            应用参数
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.bpe-overlay {
  position: fixed;
  top: var(--titlebar-height);
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--z-detail);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--overlay-strong);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

.bpe-dialog {
  width: min(680px, 100%);
  max-height: calc(100vh - var(--titlebar-height) - 48px);
  overflow-y: auto;
  padding: 20px 22px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-xl);
  background: var(--glass-bg-strong);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: var(--shadow-lg);
}

.bpe-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.bpe-header h2 {
  font-size: var(--font-lg);
}

.bpe-summary {
  margin-top: 6px;
  color: var(--text-muted);
  font-size: var(--font-xs);
  line-height: 1.5;
}

.bpe-close {
  flex-shrink: 0;
  padding: 4px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.bpe-close:hover {
  color: var(--text);
  background: var(--bg-hover);
}

.bpe-hint {
  margin: 14px 0 10px;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  color: var(--text-muted);
  font-size: var(--font-xs);
  line-height: 1.5;
}

.bpe-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
}

.bpe-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.bpe-field span {
  color: var(--text-muted);
  font-size: var(--font-xs);
}

.bpe-field input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--text);
  font-size: var(--font-sm);
  outline: none;
}

.bpe-field input:focus {
  border-color: var(--accent);
}

.bpe-range {
  display: flex;
  gap: 6px;
}

.bpe-range input {
  min-width: 0;
  flex: 1;
}

.bpe-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 18px;
}

.bpe-busy {
  margin-right: auto;
  color: var(--text-muted);
  font-size: var(--font-xs);
  animation: bpe-busy-pulse 1.2s ease-in-out infinite;
}

@keyframes bpe-busy-pulse {
  50% {
    opacity: 0.45;
  }
}
</style>
