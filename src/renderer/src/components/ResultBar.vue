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
</style>
