<script setup>
import { computed } from 'vue'
import {
  allTags,
  BASE_MODEL_FAMILIES,
  duplicateIdSet,
  duplicateWastedBytes,
  formatSize,
  LORA_TAGS,
  selectRedundantDuplicates,
  state,
  toast,
  typeInfo,
} from '../store/appStore'

/**
 * 结果栏筛选 chips（O-5 自 App.vue 拆出，FEAT-1/F-2/F-5）：
 * 主分类 chip、重复模型筛选与冗余清理入口、LoRA 二级分类 / 基底模型家族 /
 * 自由标签三个子筛选。全部状态与动作内聚于 store（与工具行解耦）。
 */

/** 重复模型数（重复组内全部成员；0 表示当前无可见的重复项，隐藏筛选入口） */
const duplicateCount = computed(() => duplicateIdSet.value.size)

/** 重复清理：每组保留最优一份，冗余副本加入多选，交由用户复核后批量删除 */
function onSelectRedundant() {
  const n = selectRedundantDuplicates()
  if (n > 0) toast('info', `已选中 ${n} 个冗余副本，复核后按 Delete 移入回收站`)
}

/* ---------------- 多标签筛选（FEAT-01） ---------------- */

/** 同时生效的标签上限（与智能视图 schema 的 tagFilters 上限一致） */
const MAX_TAG_FILTERS = 20

/**
 * 标签下拉选项：库内标签池 + 已选但不在池中的标签（保证活动筛选始终可见，
 * 例如智能视图应用了已跌出前 50 的标签时仍可取消）。
 */
const tagOptions = computed(() => {
  const pool = allTags.value
  const missing = state.tagFilters.filter((t) => !pool.includes(t))
  return missing.length > 0 ? [...missing, ...pool] : pool
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

/** 清空标签筛选 */
function clearTagFilters() {
  state.tagFilters = []
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
      v-if="tagOptions.length"
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
        <label v-for="t in tagOptions" :key="t" class="tag-option">
          <input
            type="checkbox"
            :checked="state.tagFilters.includes(t)"
            @change="toggleTagFilter(t)"
          />
          <span class="tag-option-text">{{ t }}</span>
        </label>
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
