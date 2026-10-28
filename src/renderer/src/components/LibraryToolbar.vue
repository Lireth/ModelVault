<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  filteredModels,
  saveSettings,
  SORT_OPTIONS,
  sortDirectional,
  state,
  toggleMultiSelectMode,
} from '../store/appStore'
import {
  SEARCH_SYNTAX,
  applySearchSuggestion,
  caretAfterSuggestion,
  suggestSearchSyntax,
} from '../store/search-syntax'
import { useSearchInput } from '../composables/useSearchInput'

/**
 * 库视图顶部工具行（O-5 自 App.vue 拆出）：
 * 搜索框（防抖经 useSearchInput）+ 结果计数 + 收藏筛选 + 多选开关 +
 * 排序（方式/方向）+ 列表/网格视图切换。
 * searchFieldEl 与 clearSearch 经 defineExpose 转供给全局快捷键
 * （App 的 Ctrl+F 聚焦 / Esc 清空搜索）。
 * 搜索语法辅助（FEAT-1）：「?」按钮帮助面板（示例点击插入）与
 * 输入自动补全（前缀/值两级候选，方向键选择、Enter 应用、Esc 关闭），
 * 目录单一来源见 store/search-syntax.js。
 */

const { searchInput, searchFieldEl, clearSearch } = useSearchInput()

/** 切换排序方式：立即生效并静默持久化，重启后保持用户选择 */
async function onSortChange(e) {
  state.sortBy = e.target.value
  await saveSettings({ sortBy: state.sortBy })
}

/** 收藏优先/按评分为固定语义排序，方向切换无意义（O1） */
const sortDirEnabled = computed(() => sortDirectional(state.sortBy))

/** 切换排序方向（U2）：翻转当前排序结果并持久化 */
async function onSortDirChange() {
  state.sortAsc = !state.sortAsc
  await saveSettings({ sortAsc: state.sortAsc })
}

/** 切换列表/网格视图：立即生效并静默持久化，重启后保持用户选择 */
async function onToggleViewMode() {
  state.viewMode = state.viewMode === 'grid' ? 'list' : 'grid'
  await saveSettings({ viewMode: state.viewMode })
}

/* ---------------- 搜索语法帮助面板（FEAT-1） ---------------- */

const syntaxHelpOpen = ref(false)
/** 搜索框容器（面板外点击关闭的判定范围） */
const searchBoxEl = ref(null)

function toggleSyntaxHelp() {
  syntaxHelpOpen.value = !syntaxHelpOpen.value
}

/** 面板示例点击：追加为搜索框 token 并聚焦输入框 */
async function insertSyntaxExample(s) {
  const base = searchInput.value.trimEnd()
  searchInput.value = base ? `${base} ${s.example} ` : `${s.example} `
  syntaxHelpOpen.value = false
  await nextTick()
  searchFieldEl.value?.focus()
}

/** 面板外 mousedown 关闭（mousedown 先于 click，避免抢走示例按钮点击） */
function onDocMouseDown(e) {
  if (
    syntaxHelpOpen.value &&
    searchBoxEl.value &&
    !searchBoxEl.value.contains(e.target)
  ) {
    syntaxHelpOpen.value = false
  }
}

onMounted(() => document.addEventListener('mousedown', onDocMouseDown))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocMouseDown))

/* ---------------- 输入自动补全（FEAT-1） ---------------- */

/** 当前补全建议（suggestSearchSyntax 结果；null 表示无候选） */
const suggestion = ref(null)
/** 键盘高亮的候选下标 */
const suggestionIndex = ref(0)

/** 输入时重算建议（用 input 事件携带的实时光标位置） */
function onSearchInput(e) {
  const el = e.target
  suggestion.value = suggestSearchSyntax(
    el.value,
    el.selectionStart ?? undefined,
  )
  suggestionIndex.value = 0
}

function onSearchKeydown(e) {
  if (e.isComposing) return // 输入法组合中的按键不拦截
  const sugg = suggestion.value
  if (sugg && sugg.items.length) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = sugg.items.length
      suggestionIndex.value =
        (suggestionIndex.value + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      applyActiveSuggestion()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      suggestion.value = null
      return
    }
  }
  if (syntaxHelpOpen.value && e.key === 'Escape') {
    e.preventDefault()
    syntaxHelpOpen.value = false
  }
}

/** 应用当前高亮候选：替换区间文本并把光标落到插入文本末尾 */
async function applyActiveSuggestion() {
  const sugg = suggestion.value
  if (!sugg || !sugg.items.length) return
  const item = sugg.items[suggestionIndex.value]
  searchInput.value = applySearchSuggestion(searchInput.value, sugg, item)
  suggestion.value = null
  await nextTick()
  const el = searchFieldEl.value
  const caret = caretAfterSuggestion(sugg, item)
  el?.setSelectionRange(caret, caret)
}

/** 焦点离开输入框时收起候选（候选点击经 mousedown.prevent 保留焦点先行） */
function onSearchBlur() {
  suggestion.value = null
}

defineExpose({ searchFieldEl, clearSearch })
</script>

<template>
  <!-- 搜索 + 排序：位于模型清单上方（选择文件夹后显示） -->
  <div class="search-row">
    <div ref="searchBoxEl" class="search-box">
      <span class="search-icon" aria-hidden="true">
        <svg
          viewBox="0 0 16 16"
          width="13"
          height="13"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        >
          <circle cx="7" cy="7" r="4.6" />
          <path d="M10.6 10.6 14 14" />
        </svg>
      </span>
      <input
        ref="searchFieldEl"
        v-model="searchInput"
        type="text"
        placeholder="搜索名称 / 备注 / 触发词…（支持 base: tag: size:>1gb score:>=4 语法）"
        spellcheck="false"
        autocomplete="off"
        role="combobox"
        :aria-expanded="Boolean(suggestion && suggestion.items.length)"
        aria-controls="search-syntax-suggest"
        @input="onSearchInput"
        @keydown="onSearchKeydown"
        @blur="onSearchBlur"
      />
      <button
        class="search-help"
        :class="{ active: syntaxHelpOpen }"
        title="搜索语法帮助"
        aria-label="搜索语法帮助"
        :aria-expanded="syntaxHelpOpen"
        @click="toggleSyntaxHelp"
      >
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6.2" />
          <path
            d="M6.3 6.3c0-1 .8-1.8 1.7-1.8s1.7.7 1.7 1.6c0 1.2-1.7 1.3-1.7 2.6"
          />
          <path d="M8 11.4v.01" stroke-width="1.9" />
        </svg>
      </button>
      <button
        v-if="searchInput"
        class="search-clear"
        title="清空搜索"
        @click="clearSearch"
      >
        <svg
          viewBox="0 0 16 16"
          width="10"
          height="10"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>

      <!-- 搜索语法帮助面板（FEAT-1）：目录单一来源 search-syntax.js，示例点击插入 -->
      <div
        v-if="syntaxHelpOpen"
        class="search-help-panel"
        role="group"
        aria-label="结构化搜索语法帮助"
      >
        <div class="help-head">
          结构化语法（与筛选叠加，多条件 AND；点击示例插入搜索框）
        </div>
        <ul class="help-list">
          <li v-for="s in SEARCH_SYNTAX" :key="s.prefix" class="help-row">
            <button
              class="help-example"
              :title="`插入 ${s.example}`"
              @click="insertSyntaxExample(s)"
            >
              {{ s.example }}
            </button>
            <span class="help-label">{{ s.label }}</span>
            <span class="help-desc">{{ s.desc }}</span>
          </li>
        </ul>
      </div>

      <!-- 输入自动补全（FEAT-1）：前缀/值两级候选，Enter 应用、Esc 关闭 -->
      <ul
        v-if="suggestion && suggestion.items.length"
        id="search-syntax-suggest"
        class="search-suggest"
        role="listbox"
        aria-label="搜索语法建议"
      >
        <li
          v-for="(item, i) in suggestion.items"
          :key="item.key"
          role="option"
          :aria-selected="i === suggestionIndex"
          :class="{ active: i === suggestionIndex }"
          @mousedown.prevent
          @click="applyActiveSuggestion"
        >
          <code>{{ item.insert }}</code>
          <span class="suggest-label">{{ item.label }}</span>
        </li>
      </ul>
    </div>

    <!-- 统计与快捷筛选（原结果栏）：与搜索框/排序同一行，减少纵向占用 -->
    <span class="muted result-count"
      >共 {{ filteredModels.length }} 个模型</span
    >
    <!-- 收藏筛选：仅显示收藏的模型 -->
    <button
      class="fav-filter"
      :class="{ active: state.showFavoritesOnly }"
      :title="state.showFavoritesOnly ? '显示全部模型' : '仅显示收藏的模型'"
      @click="state.showFavoritesOnly = !state.showFavoritesOnly"
    >
      <svg
        viewBox="0 0 24 24"
        width="11"
        height="11"
        :fill="state.showFavoritesOnly ? 'currentColor' : 'none'"
        stroke="currentColor"
        stroke-width="2"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path
          d="M12 3.6l2.5 5.2 5.7.7-4.2 3.9 1.1 5.6L12 16.1 6.9 19l1.1-5.6-4.2-3.9 5.7-.7z"
        />
      </svg>
      收藏
    </button>
    <!-- 多选模式开关（E4） -->
    <button
      class="fav-filter"
      :class="{ active: state.multiSelect.active }"
      :title="
        state.multiSelect.active ? '退出多选模式' : '进入多选模式，批量管理模型'
      "
      @click="toggleMultiSelectMode"
    >
      <svg
        viewBox="0 0 16 16"
        width="11"
        height="11"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        aria-hidden="true"
      >
        <rect x="2" y="2" width="12" height="12" rx="3" />
        <path
          d="M5 8.2l2.1 2.1L11.4 6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      多选
    </button>

    <div class="sort-select" title="排序方式">
      <span class="sort-label">排序</span>
      <select :value="state.sortBy" @change="onSortChange">
        <option v-for="s in SORT_OPTIONS" :key="s.key" :value="s.key">
          {{ s.label }}
        </option>
      </select>
      <button
        class="sort-dir"
        :disabled="!sortDirEnabled"
        :title="
          !sortDirEnabled
            ? '该排序为固定方向（收藏/高分在前），不支持切换'
            : state.sortAsc
              ? '当前升序，点击切换为降序'
              : '当前降序，点击切换为升序'
        "
        @click="onSortDirChange"
      >
        <svg
          v-if="state.sortAsc"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" />
        </svg>
        <svg
          v-else
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M8 3.5v9M4.5 9 8 12.5 11.5 9" />
        </svg>
      </button>
    </div>

    <!-- 列表/网格视图切换 -->
    <button
      class="view-toggle"
      :title="
        state.viewMode === 'grid'
          ? '当前网格视图，点击切换为列表视图'
          : '当前列表视图，点击切换为网格视图'
      "
      :aria-label="
        state.viewMode === 'grid' ? '切换为列表视图' : '切换为网格视图'
      "
      @click="onToggleViewMode"
    >
      <svg
        v-if="state.viewMode === 'grid'"
        viewBox="0 0 16 16"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
        <circle cx="5" cy="4" r="0.4" fill="currentColor" />
        <circle cx="5" cy="8" r="0.4" fill="currentColor" />
        <circle cx="5" cy="12" r="0.4" fill="currentColor" />
      </svg>
      <svg
        v-else
        viewBox="0 0 16 16"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        aria-hidden="true"
      >
        <rect x="2" y="2" width="5.4" height="5.4" rx="1.2" />
        <rect x="8.6" y="2" width="5.4" height="5.4" rx="1.2" />
        <rect x="2" y="8.6" width="5.4" height="5.4" rx="1.2" />
        <rect x="8.6" y="8.6" width="5.4" height="5.4" rx="1.2" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.search-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.search-box {
  position: relative;
  display: flex;
  align-items: center;
  width: min(360px, 40vw);
}

.search-icon {
  position: absolute;
  left: 10px;
  display: inline-flex;
  color: var(--text-muted);
  opacity: 0.7;
  pointer-events: none;
}

.search-box input {
  width: 100%;
  padding: 8px 56px 8px 30px;
  /* 玻璃输入框：半透明底 + 亮边 */
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--text);
  font-size: var(--font-sm);
  outline: none;
  transition:
    border-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out);
}

.search-box input:focus {
  border-color: var(--accent);
  box-shadow: var(--glow-accent);
}

.search-clear {
  position: absolute;
  right: 4px;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.search-clear:hover {
  background: var(--bg-hover);
  color: var(--text);
}

/* 语法帮助按钮（FEAT-1）：与清空按钮并排，位于其左侧 */
.search-help {
  position: absolute;
  right: 28px;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.search-help:hover,
.search-help.active {
  background: var(--bg-hover);
  color: var(--accent);
}

/* 语法帮助面板：玻璃浮层，覆盖在搜索框下方 */
.search-help-panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 60;
  width: max(100%, 440px);
  padding: 10px 12px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: var(--glass-bg-strong);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: var(--shadow-lg);
  font-size: var(--font-xs);
}

.help-head {
  margin-bottom: 8px;
  color: var(--text-muted);
}

.help-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.help-row {
  display: grid;
  grid-template-columns: auto auto 1fr;
  gap: 8px;
  align-items: baseline;
}

.help-example {
  justify-self: start;
  padding: 1px 6px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}

.help-example:hover {
  border-color: var(--accent);
  background: var(--bg-hover);
}

.help-label {
  color: var(--text);
  white-space: nowrap;
}

.help-desc {
  color: var(--text-muted);
  line-height: 1.5;
}

/* 输入自动补全候选（FEAT-1）：前缀/值两级，键盘上下选择 */
.search-suggest {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  z-index: 60;
  max-height: 260px;
  overflow-y: auto;
  margin: 0;
  padding: 4px;
  list-style: none;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: var(--glass-bg-strong);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: var(--shadow-lg);
  font-size: var(--font-xs);
}

.search-suggest li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.search-suggest li.active {
  background: var(--bg-hover);
}

.search-suggest code {
  color: var(--accent);
  font-family: var(--font-mono);
  white-space: nowrap;
}

.suggest-label {
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 结果统计（搜索行内，靠右与排序对齐） */
.result-count {
  margin-left: auto;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
</style>
