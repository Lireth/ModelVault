<script setup>
import { computed, ref } from 'vue'
import {
  allTags,
  BASE_MODEL_FAMILIES,
  duplicateIdSet,
  duplicateWastedBytes,
  exportModelList,
  formatSize,
  LORA_TAGS,
  selectRedundantDuplicates,
  state,
  toast,
  typeInfo
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

/* ---------------- 模型清单导出（FN-04） ---------------- */

const exportDetails = ref(null)
const exporting = ref(false)

/** 导出当前筛选结果；点击后立即收起菜单，保存对话框由主进程弹出 */
async function onExport(format) {
  if (exportDetails.value) exportDetails.value.open = false
  if (exporting.value) return
  exporting.value = true
  try {
    await exportModelList(format)
  } finally {
    exporting.value = false
  }
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
      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 4H6a2 2 0 0 0-2 2v10" /></svg>
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
    <label v-if="state.typeFilter === 'lora'" class="sort-select sub-filter" title="按 LoRA 分类筛选">
      <span class="sort-label">分类</span>
      <select v-model="state.subFilter">
        <option value="">全部</option>
        <option v-for="t in LORA_TAGS" :key="t.key" :value="t.key">{{ t.label }}</option>
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
        <option v-for="b in BASE_MODEL_FAMILIES" :key="b.key" :value="b.key">{{ b.label }}</option>
      </select>
    </label>
    <!-- 自由标签筛选（F-5）：库内存在标签时显示；跨类型维度，
         不随主分类切换清空（与收藏筛选同类） -->
    <label
      v-if="allTags.length"
      class="sort-select"
      :class="{ 'sub-filter': state.typeFilter !== 'lora' && state.typeFilter !== 'checkpoint' }"
      title="按标签筛选"
    >
      <span class="sort-label">标签</span>
      <select v-model="state.tagFilter">
        <option value="">全部</option>
        <option v-for="t in allTags" :key="t" :value="t">{{ t }}</option>
      </select>
    </label>
    <!-- 模型清单导出（FN-04）：导出当前搜索/筛选/排序结果 -->
    <details ref="exportDetails" class="export-menu">
      <summary class="fav-filter export-trigger" title="导出当前筛选结果">
        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M4 20h16" /></svg>
        导出
      </summary>
      <div class="export-pop">
        <button class="export-option" :disabled="exporting" @click="onExport('csv')">CSV（Excel）</button>
        <button class="export-option" :disabled="exporting" @click="onExport('markdown')">Markdown 表格</button>
        <button class="export-option" :disabled="exporting" @click="onExport('json')">JSON 数据</button>
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

/* 导出菜单（FN-04）：原生 details 折叠，无需额外全局点击监听 */
.export-menu {
  position: relative;
  margin-left: auto;
}

.export-trigger {
  list-style: none;
  cursor: pointer;
  user-select: none;
}

.export-trigger::-webkit-details-marker {
  display: none;
}

.export-pop {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 30;
  min-width: 148px;
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

.export-option {
  padding: 7px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text);
  font-size: var(--font-xs);
  text-align: left;
  cursor: pointer;
}

.export-option:hover {
  background: var(--bg-hover);
}

.export-option:disabled {
  opacity: 0.55;
  cursor: default;
}
</style>
