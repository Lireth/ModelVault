<script setup>
import { computed, ref } from 'vue'
import {
  BASE_MODEL_FAMILIES,
  duplicateIdSet,
  duplicateWastedBytes,
  formatSize,
  LORA_TAGS,
  selectRedundantDuplicates,
  state,
  toast,
  typeInfo,
  visibleModels,
  visibleTags,
} from '../store/appStore'

/**
 * 结果栏筛选 chips（O-5 自 App.vue 拆出，FEAT-1/F-2/F-5）：
 * 主分类 chip、重复模型筛选与冗余清理入口、疑似损坏筛选、LoRA 二级分类 /
 * 基底模型家族 / 自由标签三个子筛选。全部状态与动作内聚于 store（与工具行解耦）。
 */

/** 重复模型数（重复组内全部成员；0 表示当前无可见的重复项，隐藏筛选入口） */
const duplicateCount = computed(() => duplicateIdSet.value.size)

/** 疑似损坏模型数（FEAT-01）：装饰阶段标记 0 字节/头部非法/数据区截断 */
const suspectCount = computed(() =>
  visibleModels.value.reduce((n, m) => n + (m.suspect === true ? 1 : 0), 0),
)

/** 重复清理：每组保留最优一份，冗余副本加入多选，交由用户复核后批量删除 */
function onSelectRedundant() {
  const n = selectRedundantDuplicates()
  if (n > 0) toast('info', `已选中 ${n} 个冗余副本，复核后按 Delete 移入回收站`)
}

/* ---------------- 多标签筛选（FEAT-01） ---------------- */

/** 同时生效的标签上限（与智能视图 schema 的 tagFilters 上限一致） */
const MAX_TAG_FILTERS = 20
/** 无检索词时的快选展示上限：保持下拉轻量，完整标签池由检索覆盖 */
const QUICK_TAG_LIMIT = 50
/** 检索命中展示上限：防止一次渲染数千个复选框拖慢下拉 */
const SEARCH_TAG_LIMIT = 200

/** 标签检索关键词（大小写不敏感包含匹配） */
const tagSearch = ref('')

/**
 * 标签下拉数据：已选置顶 + 全量可见标签池。
 * - 无关键词时只展示前 QUICK_TAG_LIMIT 个，保留原快选体验；
 * - 有关键词时在全量池中检索，避免稀有标签不可选；
 * - 已选标签始终保留（即使不匹配关键词），保证活动筛选可随时取消。
 */
const tagOptionState = computed(() => {
  const keyword = tagSearch.value.trim().toLowerCase()
  const selected = Array.isArray(state.tagFilters) ? state.tagFilters : []
  // 已选置顶：包含已跌出可见池（隐藏模型/重扫）的标签
  const base = [
    ...selected,
    ...visibleTags.value.filter((tag) => !selected.includes(tag)),
  ]
  const matched = keyword
    ? base.filter(
        (tag) => selected.includes(tag) || tag.toLowerCase().includes(keyword),
      )
    : base
  const limit = keyword ? SEARCH_TAG_LIMIT : QUICK_TAG_LIMIT
  return {
    options: matched.slice(0, limit),
    total: matched.length,
    limited: matched.length > limit,
    keyword,
  }
})

const tagOptions = computed(() => tagOptionState.value.options)

/** 标签下拉是否有可展示内容（空库且无已选时不显示入口） */
const hasTagPool = computed(
  () => visibleTags.value.length > 0 || state.tagFilters.length > 0,
)

/** 截断提示（仅在总量超过展示上限时出现） */
const tagLimitHint = computed(() => {
  const { total, options, limited, keyword } = tagOptionState.value
  if (!limited) return ''
  return keyword
    ? `匹配 ${total} 个标签，仅显示前 ${options.length} 个，请继续输入缩小范围`
    : `共 ${total} 个标签，显示前 ${options.length} 个，输入关键词检索全部`
})

/**
 * 切换单个标签的选中态（多标签为 AND 语义）。
 * 数组整体替换保持 shallowReactive 的数组级响应约定。
 * @param {string} tag 标签
 */
function toggleTagFilter(tag) {
  if (
    !state.tagFilters.includes(tag) &&
    state.tagFilters.length >= MAX_TAG_FILTERS
  ) {
    toast('warn', `最多同时筛选 ${MAX_TAG_FILTERS} 个标签`)
    return
  }
  const next = state.tagFilters.includes(tag)
    ? state.tagFilters.filter((t) => t !== tag)
    : [...state.tagFilters, tag]
  state.tagFilters = next
}

/** 清空标签筛选与检索词 */
function clearTagFilters() {
  state.tagFilters = []
  tagSearch.value = ''
}
</script>

<template>
  <div class="result-bar">
    <span v-if="state.typeFilter !== 'all'" class="chip">
      {{ typeInfo(state.typeFilter).label }}
    </span>
    <!-- 重复筛选（FEAT-1）：仅显示与其他模型文件完全相同（SHA256 一致）的模型。
         哈希由后台预热渐进就绪，无可见重复项时隐藏入口 -->
    <button
      v-if="duplicateCount > 0"
      class="fav-filter"
      :class="{ active: state.showDuplicatesOnly }"
      :title="
        state.showDuplicatesOnly
          ? '显示全部模型'
          : `仅显示重复模型（${duplicateCount} 个，冗余副本占 ${formatSize(duplicateWastedBytes)}）`
      "
      @click="state.showDuplicatesOnly = !state.showDuplicatesOnly"
    >
      <svg
        viewBox="0 0 24 24"
        width="11"
        height="11"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="8" y="8" width="12" height="12" rx="2" />
        <path d="M16 4H6a2 2 0 0 0-2 2v10" />
      </svg>
      重复 {{ duplicateCount }}
    </button>
    <!-- 疑似损坏筛选（FEAT-01）：只显示装饰阶段标记 suspect 的模型；
         与搜索语法 broken:yes 同语义，便于集中重新下载/替换坏文件 -->
    <button
      v-if="suspectCount > 0"
      class="fav-filter"
      :class="{ active: state.showSuspectOnly }"
      :title="
        state.showSuspectOnly
          ? '显示全部模型'
          : `仅显示疑似损坏模型（${suspectCount} 个：0 字节/头部不可解析/数据区截断）`
      "
      @click="state.showSuspectOnly = !state.showSuspectOnly"
    >
      <svg
        viewBox="0 0 24 24"
        width="11"
        height="11"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M12 3 2 21h20L12 3Z" />
        <path d="M12 9v5" />
        <path d="M12 17h.01" />
      </svg>
      疑似损坏 {{ suspectCount }}
    </button>
    <!-- 重复清理（FEAT-1）：重复筛选开启时提供「保留最优、选中冗余」的一键辅助，
         交由既有批量删除（回收站）完成清理 -->
    <button
      v-if="state.showDuplicatesOnly && duplicateCount > 0"
      class="fav-filter"
      title="每个重复组自动保留最优一份（评分高/已收藏/最新优先），其余加入多选待删除"
      @click="onSelectRedundant"
    >
      选中冗余项
    </button>
    <!-- LoRA 分类筛选：仅选中 LoRA 分类时显示（即使筛选结果为空也保持可见） -->
    <label
      v-if="state.typeFilter === 'lora'"
      class="sort-select sub-filter"
      title="按 LoRA 分类筛选"
    >
      <span class="sort-label">分类</span>
      <select v-model="state.subFilter">
        <option value="">全部</option>
        <option v-for="t in LORA_TAGS" :key="t.key" :value="t.key">
          {{ t.label }}
        </option>
      </select>
    </label>
    <!-- 基底模型家族筛选（F-2）：LoRA/Checkpoint 视图可用；
         数据为装饰层合成的 baseModel（safetensors 解析 + Civitai 识别回填），
         归一化到有限家族后命中 -->
    <label
      v-if="state.typeFilter === 'lora' || state.typeFilter === 'checkpoint'"
      class="sort-select"
      :class="{ 'sub-filter': state.typeFilter !== 'lora' }"
      title="按基底模型筛选"
    >
      <span class="sort-label">基底</span>
      <select v-model="state.baseFilter">
        <option value="">全部</option>
        <option v-for="b in BASE_MODEL_FAMILIES" :key="b.key" :value="b.key">
          {{ b.label }}
        </option>
      </select>
    </label>
    <!-- 自由标签筛选（F-5/FEAT-01）：多选 AND 语义；库内存在标签时显示；
         跨类型维度，不随主分类切换清空（与收藏筛选同类） -->
    <details
      v-if="hasTagPool"
      class="filter-menu tag-filter-menu"
      :class="{
        'sub-filter':
          state.typeFilter !== 'lora' && state.typeFilter !== 'checkpoint',
      }"
    >
      <summary
        class="tag-trigger"
        :class="{ active: state.tagFilters.length > 0 }"
        :title="
          state.tagFilters.length > 0
            ? `仅显示同时包含所选 ${state.tagFilters.length} 个标签的模型`
            : '按标签筛选（可多选，同时包含）'
        "
      >
        标签
        <span v-if="state.tagFilters.length" class="tag-filter-count">
          {{ state.tagFilters.length }}
        </span>
      </summary>
      <div
        class="tag-pop"
        role="group"
        aria-label="按标签筛选（多标签同时包含）"
      >
        <input
          v-model="tagSearch"
          class="tag-search-input"
          type="search"
          placeholder="搜索标签…"
          maxlength="64"
          spellcheck="false"
          aria-label="搜索标签后勾选筛选"
        />
        <p v-if="tagOptions.length === 0" class="tag-empty">没有匹配的标签</p>
        <label v-for="t in tagOptions" :key="t" class="tag-option">
          <input
            type="checkbox"
            :checked="state.tagFilters.includes(t)"
            @change="toggleTagFilter(t)"
          />
          <span class="tag-option-text">{{ t }}</span>
        </label>
        <p v-if="tagLimitHint" class="tag-options-hint">{{ tagLimitHint }}</p>
        <button
          v-if="state.tagFilters.length > 0"
          class="tag-clear"
          type="button"
          @click="clearTagFilters"
        >
          清除标签筛选
        </button>
      </div>
    </details>
  </div>
</template>

<style scoped>
.result-bar {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 子筛选下拉：靠结果栏右侧 */
.sub-filter {
  margin-left: auto;
}

/* 多标签筛选（FEAT-01）：原生 details 折叠 + 复选列表 */
.filter-menu {
  position: relative;
  flex-shrink: 0;
}

.tag-trigger {
  list-style: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--text);
  font-size: var(--font-sm);
  cursor: pointer;
  user-select: none;
  transition:
    border-color var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}

.tag-trigger::-webkit-details-marker {
  display: none;
}

.tag-trigger:hover,
.tag-trigger:focus-visible {
  border-color: var(--accent);
  outline: none;
}

.tag-trigger.active {
  border-color: var(--accent);
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

.tag-filter-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--on-bright, #fff);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}

.tag-pop {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 30;
  min-width: 180px;
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: var(--glass-bg-strong);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
}

.tag-search-input {
  position: sticky;
  top: 0;
  z-index: 1;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-sm);
  background: var(--glass-bg-strong);
  color: var(--text);
  font-size: var(--font-xs);
  outline: none;
}

.tag-search-input:focus {
  border-color: var(--accent);
}

.tag-empty,
.tag-options-hint {
  margin: 4px 6px;
  color: var(--text-muted);
  font-size: var(--font-xs);
  line-height: 1.45;
}

.tag-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  font-size: var(--font-xs);
  cursor: pointer;
}

.tag-option:hover {
  background: var(--bg-hover);
}

.tag-option input {
  flex-shrink: 0;
  accent-color: var(--accent);
  cursor: pointer;
}

.tag-option-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag-clear {
  margin-top: 4px;
  padding: 6px 8px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--font-xs);
  text-align: left;
  cursor: pointer;
}

.tag-clear:hover {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 8%, transparent);
}
</style>
