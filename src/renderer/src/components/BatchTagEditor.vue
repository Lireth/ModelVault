<script setup>
import { computed, nextTick, onMounted, ref } from 'vue'
import { allTags, state } from '../store/appStore'

/**
 * 批量自由标签编辑层（FEAT-01）：
 * 从批量栏「更多」打开，支持添加 / 移除 / 替换三种模式。标签以「回车添加、
 * 逗号分隔粘贴」的 chips 方式输入，可从库内标签池点选；提交时仅把最终标签
 * 数组交给 store，覆盖范围与进度由 store 统一处理。
 *
 * 键盘：Esc 关闭（批量进行中不关闭）；Tab 在弹层内循环；Enter 添加标签。
 */

const emit = defineEmits(['close', 'apply'])

/** 单模型标签上限与单个标签长度上限（与 IPC schema 一致） */
const MAX_TAGS = 20
const MAX_TAG_LEN = 32

const MODES = [
  { key: 'add', label: '添加', title: '保留现有标签，追加输入的新标签' },
  { key: 'remove', label: '移除', title: '从每个选中模型移除输入的同名标签' },
  {
    key: 'replace',
    label: '替换',
    title: '用输入标签整体替换每个模型的现有标签',
  },
]

const mode = ref('add')
const tags = ref([])
const input = ref('')
const inputEl = ref(null)
const dialogEl = ref(null)

const selectedCount = computed(() => state.multiSelect.ids.length)

const summaryText = computed(() => {
  if (mode.value === 'add') {
    return `为选中的 ${selectedCount.value} 个模型追加标签；已存在的标签不会重复添加`
  }
  if (mode.value === 'remove') {
    return `从选中的 ${selectedCount.value} 个模型移除以下同名标签；未命中的标签不影响模型`
  }
  return `将选中的 ${selectedCount.value} 个模型的现有标签整体替换为以下标签`
})

/** 库内标签建议（排除已选中的；输入文本时按包含匹配过滤） */
const suggestions = computed(() => {
  const keyword = input.value.trim().toLowerCase()
  const selected = new Set(tags.value)
  return allTags.value
    .filter(
      (tag) =>
        !selected.has(tag) && (!keyword || tag.toLowerCase().includes(keyword)),
    )
    .slice(0, 30)
})

/**
 * 把一段文本加入待应用标签：支持逗号/中文逗号分隔粘贴；单个标签保留内部空格。
 * @param {string} text 原始输入
 */
function addTagsFromText(text) {
  const parts = String(text || '').split(/[,，]/)
  const next = [...tags.value]
  for (const part of parts) {
    const tag = part.trim().slice(0, MAX_TAG_LEN)
    if (!tag || next.includes(tag)) continue
    if (next.length >= MAX_TAGS) break
    next.push(tag)
  }
  tags.value = next
  input.value = ''
}

/** 输入框回车：加入当前文本 */
function commitInput() {
  addTagsFromText(input.value)
}

/** 移除一个待应用标签 */
function removeTag(tag) {
  tags.value = tags.value.filter((t) => t !== tag)
}

/** 点选库内标签建议 */
function chooseSuggestion(tag) {
  addTagsFromText(tag)
}

/** 输入框键盘：回车添加；空输入退格删除最后一个 chip；输入法组合中不处理 */
function onInputKeydown(e) {
  if (e?.isComposing) return
  if (e.key === 'Enter') {
    e.preventDefault()
    commitInput()
    return
  }
  if (e.key === 'Backspace' && !input.value && tags.value.length > 0) {
    tags.value = tags.value.slice(0, -1)
  }
}

/** 关闭弹层（批量进行中不允许关闭） */
function close() {
  if (state.multiSelect.busy) return
  emit('close')
}

/**
 * 提交：先把输入框未回车的文本并入，再交给父组件执行批量更新。
 * 空标签或无选中模型时不提交。
 */
function submit() {
  if (state.multiSelect.busy) return
  if (input.value.trim()) addTagsFromText(input.value)
  if (tags.value.length === 0) return
  emit('apply', { mode: mode.value, tags: [...tags.value] })
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
  nextTick(() => inputEl.value?.focus())
})
</script>

<template>
  <Teleport to="body">
    <div class="bte-overlay" @click.self="close" @keydown="onKeydown">
      <section
        ref="dialogEl"
        class="bte-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bte-title"
      >
        <header class="bte-header">
          <div>
            <h2 id="bte-title">批量编辑标签</h2>
            <p class="bte-summary">{{ summaryText }}</p>
          </div>
          <button
            class="bte-close"
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

        <div class="bte-modes" role="radiogroup" aria-label="标签编辑模式">
          <label
            v-for="m in MODES"
            :key="m.key"
            class="bte-mode"
            :class="{ on: mode === m.key }"
            :title="m.title"
          >
            <input v-model="mode" type="radio" :value="m.key" />
            <span>{{ m.label }}</span>
          </label>
        </div>

        <div class="bte-tags">
          <span v-for="tag in tags" :key="tag" class="bte-chip">
            {{ tag }}
            <button
              type="button"
              class="bte-chip-remove"
              :title="`移除「${tag}」`"
              :aria-label="`移除标签「${tag}」`"
              @click="removeTag(tag)"
            >
              ×
            </button>
          </span>
          <input
            ref="inputEl"
            v-model="input"
            class="bte-input"
            type="text"
            placeholder="输入标签，回车添加（可逗号分隔）"
            spellcheck="false"
            @keydown="onInputKeydown"
          />
        </div>
        <div class="bte-tag-meta">
          <span>已输入 {{ tags.length }}/{{ MAX_TAGS }}</span>
          <span v-if="mode === 'remove'" class="bte-hint"
            >未选中的标签不会变化</span
          >
        </div>

        <div v-if="suggestions.length > 0" class="bte-suggestions">
          <span class="bte-suggestions-label">库内标签</span>
          <button
            v-for="tag in suggestions"
            :key="tag"
            type="button"
            class="bte-suggestion"
            @click="chooseSuggestion(tag)"
          >
            {{ tag }}
          </button>
        </div>

        <p v-if="mode === 'replace'" class="bte-warning" role="alert">
          替换会清空所选模型的现有标签，请确认输入内容无误。
        </p>

        <footer class="bte-actions">
          <span v-if="state.multiSelect.busy" class="bte-busy">处理中…</span>
          <button
            class="btn"
            type="button"
            :disabled="state.multiSelect.busy"
            @click="close"
          >
            取消
          </button>
          <button
            class="btn btn-primary bte-apply"
            type="button"
            :disabled="
              state.multiSelect.busy || tags.length === 0 || selectedCount === 0
            "
            @click="submit"
          >
            {{ MODES.find((m) => m.key === mode)?.label }}标签
          </button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.bte-overlay {
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

.bte-dialog {
  width: min(560px, 100%);
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

.bte-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.bte-header h2 {
  font-size: var(--font-lg);
}

.bte-summary {
  margin-top: 6px;
  color: var(--text-muted);
  font-size: var(--font-xs);
  line-height: 1.5;
}

.bte-close {
  flex-shrink: 0;
  padding: 4px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.bte-close:hover {
  color: var(--text);
  background: var(--bg-hover);
}

.bte-modes {
  display: flex;
  gap: 8px;
  margin: 16px 0 12px;
}

.bte-mode {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-full);
  color: var(--text-muted);
  font-size: var(--font-xs);
  cursor: pointer;
  transition:
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}

.bte-mode input {
  accent-color: var(--accent);
}

.bte-mode.on {
  border-color: var(--accent);
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

.bte-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  padding: 8px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg-card) 55%, transparent);
}

.bte-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
  font-size: var(--font-xs);
}

.bte-chip-remove {
  border: none;
  background: transparent;
  color: inherit;
  line-height: 1;
  padding: 0;
  cursor: pointer;
}

.bte-input {
  flex: 1;
  min-width: 180px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: var(--font-xs);
  font-family: inherit;
}

.bte-tag-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 6px;
  color: var(--text-muted);
  font-size: 11px;
}

.bte-hint {
  opacity: 0.8;
}

.bte-suggestions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--border);
  max-height: 124px;
  overflow-y: auto;
}

.bte-suggestions-label {
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: 11px;
}

.bte-suggestion {
  padding: 2px 8px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  cursor: pointer;
}

.bte-suggestion:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.bte-warning {
  margin-top: 12px;
  padding: 8px 10px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--warning) 14%, transparent);
  color: var(--warning);
  font-size: var(--font-xs);
  line-height: 1.5;
}

.bte-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}

.bte-busy {
  margin-right: auto;
  color: var(--text-muted);
  font-size: var(--font-xs);
}
</style>
