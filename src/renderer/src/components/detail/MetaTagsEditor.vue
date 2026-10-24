<script setup>
import { computed, ref } from 'vue'
import {
  selectedModel,
  setModelTags,
  subCategoryInfo,
  tagsForType,
  toast
} from '../../store/appStore'

/**
 * 详情表单列「命名与标签」区（OPT-01 自 MetaForm.vue 按域拆出）：
 * 备注名输入（绑定父组件表单副本）、二级分类标签（自动分配只读）、
 * 自由标签即时编辑（F-5：添加/删除，校验后整体覆写提交）。
 * 板块标题样式为 main.css 公共类（.detail-form-col h3）。
 */

defineProps({
  /** 表单本地副本（MetaForm 持有，reactive 对象） */
  form: { type: Object, required: true }
})

/** 当前生效的分类标签展示信息（自动分配：文件夹名 / Civitai 类型 / 大模型基底） */
const currentSubInfo = computed(() => subCategoryInfo(selectedModel.value?.subCategory))

/* ---------------- 自由标签（F-5，即时保存） ---------------- */

/** 标签上限（与主进程 MAX_TAGS 一致，前置提示用） */
const MAX_TAGS = 20

/** 当前标签列表：以本地模型元素为单一事实源（setModelTags 成功后同步） */
const tags = computed(() => selectedModel.value?.tags || [])

const newTag = ref('')

/** 添加标签：trim + 长度/数量/重复校验后整体覆写提交 */
async function addTag() {
  const model = selectedModel.value
  const t = newTag.value.trim().slice(0, 32)
  newTag.value = ''
  if (!model || !t) return
  if (tags.value.some((x) => x.toLowerCase() === t.toLowerCase())) {
    toast('info', '标签已存在')
    return
  }
  if (tags.value.length >= MAX_TAGS) {
    toast('warn', `标签最多 ${MAX_TAGS} 个`)
    return
  }
  await setModelTags(model.id, [...tags.value, t])
}

/** 删除标签 */
async function removeTag(tag) {
  const model = selectedModel.value
  if (!model) return
  await setModelTags(model.id, tags.value.filter((x) => x !== tag))
}
</script>

<template>
  <h3>命名与标签</h3>
  <label class="field">
    <span>备注名（卡片显示名，为空时显示文件名）</span>
    <input v-model="form.alias" type="text" maxlength="100" :placeholder="selectedModel.name" />
  </label>
  <div class="tags-editor">
    <!-- 二级分类标签：自动分配（所在文件夹名 / Civitai 类型 / 大模型基底），只读 -->
    <span
      v-if="tagsForType(selectedModel.type) && currentSubInfo"
      class="subcat-chip locked"
      :style="{ borderColor: currentSubInfo.color, color: currentSubInfo.color }"
      :title="selectedModel.type === 'checkpoint' ? '大模型自动标注为基底模型' : '二级分类（自动分配）'"
    >{{ currentSubInfo.label }}</span>
    <!-- 自由标签（F-5）：即时保存，与二级分类标签（固定枚举）互补 -->
    <span v-for="t in tags" :key="t" class="tag-chip">
      {{ t }}
      <button
        class="tag-remove"
        type="button"
        :title="`删除标签「${t}」`"
        :aria-label="`删除标签「${t}」`"
        @click="removeTag(t)"
      >×</button>
    </span>
    <input
      v-model="newTag"
      class="tag-input"
      type="text"
      maxlength="32"
      placeholder="添加标签，回车确认"
      spellcheck="false"
      @keydown.enter.prevent="addTag"
    />
  </div>
  <span v-if="tagsForType(selectedModel.type) && !currentSubInfo" class="subcat-hint">
    二级分类未分配（可在文件所在文件夹按标签命名自动匹配，或使用批量栏「Civitai 分配标签」，仅 LoRA）
  </span>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.field span {
  font-size: var(--font-xs);
  color: var(--text-muted);
}

.field input {
  padding: 8px 12px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--text);
  font-size: var(--font-sm);
  outline: none;
  width: 100%;
}

.field input:focus {
  border-color: var(--accent);
}

/* ---------- 自由标签编辑器（F-5） ---------- */
.tags-editor {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px 3px 12px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--accent);
  font-size: var(--font-xs);
  max-width: 200px;
  overflow-wrap: anywhere;
}

.tag-remove {
  border: none;
  background: transparent;
  color: inherit;
  font-size: 13px;
  line-height: 1;
  padding: 0 4px;
  cursor: pointer;
  border-radius: 50%;
}

.tag-remove:hover {
  color: var(--danger);
}

/* 内边距/字号与 .field input 同源，保证与备注名、参数输入框等高（视觉协调） */
.tag-input {
  flex: 1;
  min-width: 140px;
  padding: 8px 12px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--text);
  font-size: var(--font-sm);
  outline: none;
}

.tag-input:focus {
  border-color: var(--accent);
}

.subcat-chip {
  /* 与 .tag-chip 等高：同内边距与字号，二级分类 chip 与自由标签 chip 并排协调 */
  padding: 3px 12px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--text);
  font-size: var(--font-xs);
  cursor: pointer;
}

.subcat-chip:hover {
  border-color: var(--text-muted);
}

.subcat-chip.active {
  background: var(--bg-active);
  border-width: 1.5px;
  font-weight: 600;
}

/* 自动分类标签（如大模型的基底模型）：不可点击更改 */
.subcat-chip.locked {
  cursor: default;
  opacity: 0.9;
}

.subcat-hint {
  font-size: 11px;
  color: var(--text-muted);
}
</style>
