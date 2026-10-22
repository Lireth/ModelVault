<script setup>
import { computed, ref, nextTick } from 'vue'
import {
  allTags,
  confirmDialog,
  removeTagGlobally,
  renameTagGlobally,
  tagCounts,
  toast
} from '../../store/appStore'

/**
 * 设置页「标签管理」板块（F4）：全库自由标签的管理闭环——
 * 重命名/合并（目标名已存在时整库合并）与移除，操作整库生效并即时落盘，
 * 本地模型列表由 tag-admin 同步（无需重扫）。
 * 数据源为 allTags 标签池（按使用次数降序，上限 50，与侧栏筛选同一来源）。
 */

/** 行内编辑状态：正在重命名的标签名（null = 无编辑行） */
const editingTag = ref(null)
const editValue = ref('')
/** 编辑框 DOM 引用（进入编辑态自动聚焦） */
const editInputEl = ref(null)
const busy = ref(false)

/** 标签行（名称 + 使用模型数），随本地列表即时刷新 */
const rows = computed(() =>
  allTags.value.map((tag) => ({ tag, count: tagCounts.value.get(tag) || 0 }))
)

async function startEdit(tag) {
  editingTag.value = tag
  editValue.value = tag
  await nextTick()
  editInputEl.value?.focus()
  editInputEl.value?.select()
}

/**
 * 编辑框函数引用（行在 v-for 内，字符串 ref 会收敛成数组）：
 * 仅编辑行渲染输入框，直接持有当前元素。
 */
function setEditInputRef(el) {
  editInputEl.value = el
}

function cancelEdit() {
  editingTag.value = null
  editValue.value = ''
}

/** 保存重命名：目标名已存在时经确认层告知合并语义 */
async function saveEdit() {
  const from = editingTag.value
  const to = editValue.value.trim()
  if (!from || busy.value) return
  if (!to) {
    toast('info', '标签名称不能为空')
    return
  }
  if (to === from) {
    cancelEdit()
    return
  }
  if (allTags.value.includes(to)) {
    const ok = await confirmDialog(
      `标签「${to}」已存在，重命名将与「${to}」合并：两个标签下的模型都将拥有合并后的「${to}」。`
    )
    if (!ok) return
  }
  busy.value = true
  try {
    await renameTagGlobally(from, to)
    cancelEdit()
  } finally {
    busy.value = false
  }
}

/** 移除标签（确认层明示影响范围与不可逆性） */
async function onRemove(tag) {
  if (busy.value) return
  const count = tagCounts.value.get(tag) || 0
  const ok = await confirmDialog(
    `确定从 ${count} 个模型上移除标签「${tag}」吗？仅移除该标签，不影响模型文件与其他标注。`
  )
  if (!ok) return
  busy.value = true
  try {
    await removeTagGlobally(tag)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <!-- 标签管理（O-4 拆分：settings/SettingsTags.vue）：重命名/合并/移除 -->
  <h3>标签管理</h3>
  <div class="settings-group">
    <div v-if="rows.length === 0" class="setting-row">
      <div class="setting-info">
        <span class="setting-desc">当前模型库还没有自由标签，可在模型详情页为模型添加标签。</span>
      </div>
    </div>

    <div v-for="row in rows" :key="row.tag" class="setting-row">
      <template v-if="editingTag === row.tag">
        <div class="setting-info">
          <input
            :ref="setEditInputRef"
            v-model="editValue"
            class="tag-edit-input"
            type="text"
            maxlength="32"
            spellcheck="false"
            :disabled="busy"
            @keyup.enter="saveEdit"
            @keyup.esc="cancelEdit"
          />
          <span class="setting-desc">
            输入已有标签名可与该标签合并；当前 {{ row.count }} 个模型使用「{{ row.tag }}」
          </span>
        </div>
        <div class="setting-actions">
          <button
            class="btn btn-primary"
            :disabled="busy || !editValue.trim() || editValue.trim() === row.tag"
            title="保存重命名"
            @click="saveEdit"
          >保存</button>
          <button class="btn" :disabled="busy" @click="cancelEdit">取消</button>
        </div>
      </template>
      <template v-else>
        <div class="setting-info">
          <span class="setting-title">{{ row.tag }}</span>
          <span class="setting-desc">{{ row.count }} 个模型使用</span>
        </div>
        <div class="setting-actions">
          <button class="btn" :disabled="busy" title="重命名；输入已有标签名可合并" @click="startEdit(row.tag)">
            重命名 / 合并
          </button>
          <button
            class="btn btn-danger"
            :disabled="busy"
            :title="`从 ${row.count} 个模型上移除该标签`"
            @click="onRemove(row.tag)"
          >移除</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tag-edit-input {
  width: 240px;
  max-width: 100%;
  padding: 7px 12px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--text);
  font-size: var(--font-sm);
  outline: none;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}

.tag-edit-input:focus {
  border-color: var(--accent);
  box-shadow: var(--glow-accent);
}
</style>
