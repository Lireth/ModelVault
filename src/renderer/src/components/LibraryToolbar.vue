<script setup>
import { computed } from 'vue'
import {
  filteredModels,
  saveSettings,
  SORT_OPTIONS,
  sortDirectional,
  state,
  toggleMultiSelectMode,
} from '../store/appStore'
import { useSearchInput } from '../composables/useSearchInput'

/**
 * 库视图顶部工具行（O-5 自 App.vue 拆出）：
 * 搜索框（防抖经 useSearchInput）+ 结果计数 + 收藏筛选 + 多选开关 +
 * 排序（方式/方向）+ 列表/网格视图切换。
 * searchFieldEl 与 clearSearch 经 defineExpose 转供给全局快捷键
 * （App 的 Ctrl+F 聚焦 / Esc 清空搜索）。
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

defineExpose({ searchFieldEl, clearSearch })
</script>

<template>
  <!-- 搜索 + 排序：位于模型清单上方（选择文件夹后显示） -->
  <div class="search-row">
    <div
      class="search-box"
      title='搜索名称、备注名、备注与分类标签；支持结构化语法（与筛选叠加）：base:pony tag:"我的标签" type:lora size:>1gb score:>=4 fav:yes nsfw:no'
    >
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
      />
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
  padding: 8px 30px 8px 30px;
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

/* 结果统计（搜索行内，靠右与排序对齐） */
.result-count {
  margin-left: auto;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
</style>
