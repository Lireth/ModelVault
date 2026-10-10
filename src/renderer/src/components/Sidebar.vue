<script setup>
import { computed } from 'vue'
import {
  MODEL_TYPES,
  state,
  typeCounts,
  chooseFolder,
  exportModels,
  openDedupe,
  openDiskUsage,
  removeRoot,
  scanModels,
  openSettings,
  switchRoot
} from '../store/appStore'

const folderName = computed(() => {
  if (!state.folder) return '未选择文件夹'
  const parts = state.folder.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || state.folder
})

/** 模型库列表（E7 多根目录）：剔除当前激活库后仍存在的其他库 */
const otherRoots = computed(() =>
  (state.settings.modelsFolders || []).filter(
    (f) => f.toLowerCase() !== state.folder.toLowerCase()
  )
)

/** 库显示名：取路径末段 */
function rootName(f) {
  const parts = f.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || f
}

function selectType(key) {
  state.typeFilter = key
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
      <!-- 导出当前筛选后的模型列表（E2） -->
      <button class="btn action-btn" title="将当前列表导出为 CSV 文件（可被 Excel 打开）" :disabled="!state.models.length" @click="exportModels('csv')">
        导出 CSV
      </button>
      <button class="btn action-btn" title="将当前列表导出为 JSON 文件" :disabled="!state.models.length" @click="exportModels('json')">
        导出 JSON
      </button>
      <!-- 重复模型检测（E5） -->
      <button class="btn action-btn" title="按文件哈希查找内容完全相同的重复模型" :disabled="!state.models.length" @click="openDedupe">
        重复检测
      </button>
      <!-- 磁盘占用分析（FEAT-1） -->
      <button class="btn action-btn" title="按分类与目录统计模型文件占用的磁盘空间" :disabled="!state.models.length" @click="openDiskUsage">
        占用分析
      </button>
    </div>

    <!-- 模型库切换（E7 多根目录）：存在其他库时显示 -->
    <div v-if="otherRoots.length" class="side-section">
      <h3>模型库</h3>
      <ul class="root-list">
        <li v-for="f in otherRoots" :key="f">
          <button
            class="root-item"
            :title="`${f}（点击切换）`"
            @click="switchRoot(f)"
          >
            <span class="root-dot"></span>
            <span class="root-name">{{ rootName(f) }}</span>
            <span
              class="root-remove"
              title="从模型库列表移除（磁盘数据不受影响）"
              @click.stop="removeRoot(f)"
            >✕</span>
          </button>
        </li>
      </ul>
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
      设置
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

/* ---------- 模型库切换（E7） ---------- */
.root-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.root-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}

.root-item:hover {
  background: var(--bg-hover);
}

.root-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1.5px solid var(--text-muted);
  flex-shrink: 0;
}

.root-item:hover .root-dot {
  border-color: var(--accent);
}

.root-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.root-remove {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: none;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  color: var(--text-muted);
  font-size: 10px;
}

.root-item:hover .root-remove {
  display: flex;
}

.root-remove:hover {
  background: var(--danger);
  color: #fff;
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

/* 窄屏图标栏（OPT-1）：断点 900px 与 TopBar.vue 的窄屏操作菜单联动——
   此范围内操作区（重新扫描/选择文件夹/导出/重复检测）整体隐藏，
   改由标题栏 ☰ 菜单提供同等入口；改动任一侧断点时须同步另一侧 */
@media (max-width: 900px) {
  .sidebar {
    width: 64px;
    padding: 16px 6px;
  }
  .folder-box,
  .type-label,
  .type-count,
  .side-section h3,
  .action-section {
    display: none;
  }
  .type-item {
    justify-content: center;
    padding: 9px 0;
  }
}
</style>
