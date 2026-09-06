<script setup>
import { computed } from 'vue'
import { MODEL_TYPES, state, typeCounts, formatSize } from '../store/appStore'

const emit = defineEmits(['select-type'])

const folderName = computed(() => {
  if (!state.folder) return '未选择文件夹'
  const parts = state.folder.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || state.folder
})

function selectType(key) {
  state.typeFilter = key
  emit('select-type', key)
}
</script>

<template>
  <aside class="sidebar">
    <div class="side-section">
      <h3>模型文件夹</h3>
      <div class="folder-box" :title="state.folder || '点击顶栏「选择文件夹」'">
        <span class="folder-name">{{ folderName }}</span>
        <span v-if="state.lastScan" class="folder-stat">
          {{ state.lastScan.count }} 个模型 · {{ (state.lastScan.durationMs / 1000).toFixed(1) }}s
        </span>
      </div>
    </div>

    <div class="side-section">
      <h3>分类</h3>
      <ul class="type-list">
        <li>
          <button
            class="type-item"
            :class="{ active: state.typeFilter === 'all' }"
            @click="selectType('all')"
          >
            <span class="type-dot all-dot"></span>
            <span class="type-label">全部</span>
            <span class="type-count">{{ typeCounts.all }}</span>
          </button>
        </li>
        <li v-for="t in MODEL_TYPES" :key="t.key">
          <button
            class="type-item"
            :class="{ active: state.typeFilter === t.key }"
            @click="selectType(t.key)"
          >
            <span class="type-dot" :style="{ background: t.color }"></span>
            <span class="type-label">{{ t.label }}</span>
            <span class="type-count">{{ typeCounts[t.key] || 0 }}</span>
          </button>
        </li>
      </ul>
    </div>

    <div class="side-section">
      <h3>排序</h3>
      <div class="sort-group">
        <button
          v-for="opt in [
            { key: 'name', label: '按名称' },
            { key: 'size', label: '按大小' },
            { key: 'mtime', label: '按修改时间' }
          ]"
          :key="opt.key"
          class="sort-btn"
          :class="{ active: state.sortBy === opt.key }"
          @click="state.sortBy = opt.key"
        >
          {{ opt.label }}
        </button>
      </div>
    </div>

    <div class="side-footer">
      <span v-if="state.folder" class="muted-small" :title="state.folder">{{ state.folder }}</span>
      <span class="muted-small">数据保存在本地，重启后不丢失</span>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 232px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--bg-card);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 16px 12px;
  gap: 18px;
}

.side-section h3 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-muted);
  margin-bottom: 8px;
  padding-left: 6px;
}

.folder-box {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.folder-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder-stat {
  font-size: 11px;
  color: var(--text-muted);
}

.type-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.type-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}

.type-item:hover {
  background: var(--bg-hover);
}

.type-item.active {
  background: var(--bg-active);
}

.type-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
}

.all-dot {
  background: linear-gradient(135deg, #4f9cf9, #b18cff);
}

.type-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.type-count {
  font-size: 11px;
  color: var(--text-muted);
  background: var(--bg);
  border-radius: 10px;
  padding: 1px 8px;
  min-width: 20px;
  text-align: center;
}

.sort-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sort-btn {
  padding: 7px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}

.sort-btn:hover {
  background: var(--bg-hover);
}

.sort-btn.active {
  background: var(--bg-active);
  color: var(--accent);
}

.side-footer {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.muted-small {
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 900px) {
  .sidebar {
    width: 64px;
    padding: 16px 6px;
  }
  .folder-box,
  .side-footer,
  .sort-group,
  .type-label,
  .type-count,
  .side-section h3 {
    display: none;
  }
  .type-item {
    justify-content: center;
    padding: 9px 0;
  }
}
</style>
