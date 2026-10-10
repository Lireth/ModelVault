<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { ancestorDirs, buildFolderTree, flattenTree } from '../store/folder-tree'

/**
 * 库内目录树（B-01 结构概览 / B-06 应用内整理共用）：
 * - 数据来自模型 relDir 聚合（零磁盘 IO）；extraDirs 补充空目录（整理面板）；
 * - selectable：点击目录设置筛选/移动目标；
 * - droppable：接受 ModelCard 拖拽（自定义 MIME application/x-modelvault-ids），
 *   放置后 emit move({ ids, dir })；
 * - manageable：行内「新建子文件夹 / 重命名」操作，内联输入行提交后 emit
 *   create({ parentDir, name }) / rename({ dir, newName })，由父组件执行 IPC。
 */
const props = defineProps({
  models: { type: Array, required: true },
  extraDirs: { type: Array, default: () => [] },
  /** 当前选中目录（'' 为虚拟根/全部） */
  selected: { type: String, default: '' },
  selectable: { type: Boolean, default: true },
  droppable: { type: Boolean, default: false },
  manageable: { type: Boolean, default: false },
  rootLabel: { type: String, default: '全部目录' },
  showCounts: { type: Boolean, default: true }
})

const emit = defineEmits(['select', 'move', 'create', 'rename'])

/** 展开的目录集合（虚拟根恒展开，不受此集合控制） */
const expanded = ref(new Set())
/** 当前拖拽悬停的目录（放置高亮） */
const dropPath = ref('')

const tree = computed(() => buildFolderTree(props.models, props.extraDirs))
const rows = computed(() => flattenTree(tree.value, expanded.value))

function toggleExpand(path) {
  const next = new Set(expanded.value)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  expanded.value = next
}

function onRowClick(path) {
  if (props.selectable) emit('select', path)
}

/** 选中深层目录时自动展开其祖先链 */
watch(
  () => props.selected,
  (dir) => {
    if (!dir) return
    const chain = ancestorDirs(dir)
    if (chain.length === 0) return
    const next = new Set(expanded.value)
    let changed = false
    for (const d of chain) {
      if (!next.has(d)) {
        next.add(d)
        changed = true
      }
    }
    if (changed) expanded.value = next
  },
  { immediate: true }
)

/* ---------------- 拖拽归位（B-06） ---------------- */

/** 自定义拖拽 MIME：ModelCard dragstart 写入，区别于操作系统文件拖入 */
const MOVE_MIME = 'application/x-modelvault-ids'

function onDragOver(e, path) {
  if (!props.droppable) return
  if (!Array.from(e.dataTransfer?.types || []).includes(MOVE_MIME)) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  if (dropPath.value !== path) dropPath.value = path
}

function onDragLeave(path) {
  if (dropPath.value === path) dropPath.value = ''
}

function onDrop(e, path) {
  if (!props.droppable) return
  dropPath.value = ''
  const raw = e.dataTransfer?.getData(MOVE_MIME)
  if (!raw) return
  let ids
  try {
    ids = JSON.parse(raw)
  } catch {
    return
  }
  if (Array.isArray(ids) && ids.length > 0) {
    e.preventDefault()
    emit('move', { ids, dir: path })
  }
}

/* ---------------- 内联新建/重命名（B-06） ---------------- */

/**
 * 内联编辑状态：
 * - { mode:'create', parent } 在 parent 目录下新建（parent='' 为根直属）
 * - { mode:'rename', dir } 重命名 dir 的末段
 */
const editing = ref(null)
const editInput = ref(null)

/**
 * 函数 ref：输入框位于 v-for 行内，字符串 ref 会被收集成数组，
 * 用函数 ref 始终拿到当前编辑行的 input 元素（null 为卸载回调）
 */
function setEditInputEl(el) {
  editInput.value = el
}

function startCreate(parent) {
  editing.value = { mode: 'create', parent, value: '' }
}

function startRename(dir) {
  if (!dir) return
  const name = dir.split('/').pop()
  editing.value = { mode: 'rename', dir, value: name }
}

function cancelEdit() {
  editing.value = null
}

function commitEdit() {
  const ed = editing.value
  if (!ed) return
  const name = ed.value.trim()
  editing.value = null
  if (!name) return
  if (ed.mode === 'create') emit('create', { parentDir: ed.parent, name })
  else emit('rename', { dir: ed.dir, newName: name })
}

watch(editing, async (ed) => {
  if (!ed) return
  await nextTick()
  editInput.value?.focus()
  if (ed.mode === 'rename') editInput.value?.select()
})

function onEditKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault()
    commitEdit()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancelEdit()
  }
}

/** 行操作按钮的鼠标/键盘事件不得触发行选中 */
function stopRowActivate(e) {
  e.stopPropagation()
}

/** 目录末段名（行标题展示用） */
function nodeName(node) {
  return node.path === '' ? props.rootLabel : node.name
}
</script>

<template>
  <ul class="folder-tree" role="tree">
    <li
      v-for="{ node, depth } in rows"
      :key="node.path || '__root__'"
      role="treeitem"
      :aria-expanded="node.children.length ? expanded.has(node.path) || depth === 0 : undefined"
      :aria-selected="selected === node.path"
    >
      <div
        class="tree-row"
        :class="{
          active: selected === node.path,
          'drop-target': droppable && dropPath === node.path,
          'is-root': depth === 0
        }"
        :style="{ paddingLeft: `${depth * 12 + 6}px` }"
        @click="onRowClick(node.path)"
        @dragover="onDragOver($event, node.path)"
        @dragleave="onDragLeave(node.path)"
        @drop="onDrop($event, node.path)"
      >
        <button
          class="tree-caret"
          :class="{ invisible: node.children.length === 0 }"
          :title="expanded.has(node.path) ? '折叠' : '展开'"
          tabindex="-1"
          @click.stop="toggleExpand(node.path)"
        >{{ expanded.has(node.path) || depth === 0 ? '▾' : '▸' }}</button>

        <span class="tree-icon">{{ depth === 0 ? '🗂️' : '📁' }}</span>

        <!-- 内联新建/重命名输入行 -->
        <input
          v-if="editing && ((editing.mode === 'create' && editing.parent === node.path) ||
            (editing.mode === 'rename' && editing.dir === node.path))"
          :ref="setEditInputEl"
          v-model="editing.value"
          class="tree-edit-input"
          :maxlength="200"
          spellcheck="false"
          @click.stop
          @keydown="onEditKeydown"
          @blur="commitEdit"
        />
        <span v-else class="tree-name" :title="node.path || rootLabel">{{ nodeName(node) }}</span>

        <span v-if="showCounts" class="tree-count">{{ node.totalCount }}</span>

        <span v-if="manageable" class="tree-actions">
          <button
            class="tree-action"
            title="在此目录下新建文件夹"
            @click.stop="startCreate(node.path)"
            @mousedown="stopRowActivate"
          >＋</button>
          <button
            v-if="depth !== 0"
            class="tree-action"
            title="重命名此文件夹"
            @click.stop="startRename(node.path)"
            @mousedown="stopRowActivate"
          >✎</button>
        </span>
      </div>
    </li>
  </ul>
</template>

<style scoped>
.folder-tree {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px 4px 6px;
  border-radius: 7px;
  font-size: 12.5px;
  color: var(--text);
  cursor: default;
  user-select: none;
}

.tree-row {
  cursor: pointer;
}

.tree-row:hover {
  background: var(--bg-hover);
}

.tree-row.active {
  background: var(--bg-active);
  font-weight: 600;
}

.tree-row.drop-target {
  outline: 2px dashed var(--accent);
  outline-offset: -2px;
  background: var(--bg-active);
}

.tree-caret {
  flex-shrink: 0;
  width: 16px;
  height: 18px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 10px;
  line-height: 18px;
  cursor: pointer;
}

.tree-caret.invisible {
  visibility: hidden;
}

.tree-icon {
  flex-shrink: 0;
  font-size: 12px;
}

.tree-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-count {
  flex-shrink: 0;
  font-size: 10.5px;
  color: var(--text-muted);
  background: var(--bg);
  border-radius: 9px;
  padding: 0 7px;
  min-width: 18px;
  text-align: center;
}

.tree-row.active .tree-count {
  color: var(--accent);
}

/* 行内操作：悬停/键盘聚焦行时显现，与侧栏模型库移除按钮同模式 */
.tree-actions {
  flex-shrink: 0;
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.tree-row:hover .tree-actions,
.tree-action:focus-visible {
  opacity: 1;
}

.tree-action {
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}

.tree-action:hover {
  background: var(--bg-active);
  color: var(--accent);
}

.tree-edit-input {
  flex: 1;
  min-width: 0;
  padding: 2px 6px;
  font-size: 12px;
  border: 1px solid var(--accent);
  border-radius: 5px;
  background: var(--bg);
  color: var(--text);
  outline: none;
}
</style>
