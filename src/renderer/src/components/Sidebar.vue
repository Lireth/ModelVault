<script setup>
import { computed } from 'vue'
import { MODEL_TYPES, state, typeCounts, formatSize, chooseFolder, scanModels, openSettings } from '../store/appStore'

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

function onScanClick() {
  if (!state.scanning) scanModels()
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

    <!-- 操作按钮区：位于「模型文件夹」与「分类」之间 -->
    <div class="side-section action-section">
      <button class="btn action-btn" title="重新扫描当前模型文件夹" :disabled="state.scanning || !state.folder" @click="onScanClick">
        {{ state.scanning ? '扫描中…' : '重新扫描' }}
      </button>
      <button class="btn action-btn" title="选择模型文件夹" @click="chooseFolder">选择文件夹</button>
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

    <!-- 设置按钮：固定在侧边栏最底部，宽度自适应侧边栏 -->
    <button class="btn settings-btn" title="打开设置" @click="openSettings">
      <span class="settings-icon">⚙</span>
      <span class="settings-text">设置</span>
    </button>
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

/* ---------- 操作按钮区（模型文件夹与分类之间） ---------- */
.action-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.action-btn {
  width: 100%;
  text-align: center;
}

/* ---------- 设置按钮（固定侧边栏最底部，全宽） ---------- */
.settings-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 10px;
  flex-shrink: 0;
  margin-top: auto;
}

.settings-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  border-color: var(--accent);
}

.settings-icon {
  font-size: 13px;
}

@media (max-width: 900px) {
  .sidebar {
    width: 64px;
    padding: 16px 6px;
  }
  .folder-box,
  .type-label,
  .type-count,
  .side-section h3,
  .action-section,
  .settings-text {
    display: none;
  }
  .type-item {
    justify-content: center;
    padding: 9px 0;
  }
}
</style>
