<script setup>
import { computed, nextTick, ref } from 'vue'
import {
  MODEL_TYPES,
  state,
  typeCounts,
  chooseFolder,
  openSettings,
  openStats,
  removeRoot,
  scanModels,
  switchRoot,
  savedViews,
  activeSavedViewId,
  viewSummary,
  saveCurrentAsView,
  applySavedView,
  deleteSavedView
} from '../store/appStore'

const folderName = computed(() => {
  if (!state.folder) return '未选择文件夹'
  const parts = state.folder.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || state.folder
})

/* ---------------- 智能视图（组合筛选收藏） ---------------- */

/** 内联保存表单状态：savingView 展开中、viewName 输入值、savingBusy 防重复提交 */
const savingView = ref(false)
const viewName = ref('')
const savingBusy = ref(false)
const viewNameInput = ref(null)

function startSaveView() {
  savingView.value = true
  viewName.value = ''
  nextTick(() => viewNameInput.value?.focus())
}

function cancelSaveView() {
  savingView.value = false
}

async function onSaveViewConfirm() {
  if (savingBusy.value) return
  savingBusy.value = true
  try {
    if (await saveCurrentAsView(viewName.value)) savingView.value = false
  } finally {
    savingBusy.value = false
  }
}

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

    <!-- 操作按钮区：位于「模型文件夹」与「分类」之间；常用操作两两并排 -->
    <div class="side-section action-section">
      <div class="action-grid">
        <button class="btn action-btn" title="重新扫描当前模型文件夹" :disabled="state.scanning || !state.folder" @click="onScanClick">
          {{ state.scanning ? '扫描中…' : '重新扫描' }}
        </button>
        <button class="btn action-btn" title="选择模型文件夹" @click="chooseFolder">选择文件夹</button>
      </div>
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
              role="button"
              tabindex="0"
              title="从模型库列表移除（磁盘数据不受影响）"
              :aria-label="`将模型库 ${rootName(f)} 从列表移除`"
              @click.stop="removeRoot(f)"
              @keydown.enter.stop.prevent="removeRoot(f)"
              @keydown.space.stop.prevent="removeRoot(f)"
            >✕</span>
          </button>
        </li>
      </ul>
    </div>

    <!-- 智能视图（组合筛选收藏）：当前搜索/分类/收藏/排序组合存为命名视图，一键切换 -->
    <div class="side-section views-section">
      <h3>智能视图</h3>
      <ul v-if="savedViews.length" class="view-list">
        <li v-for="v in savedViews" :key="v.id">
          <button
            class="view-item"
            :class="{ active: v.id === activeSavedViewId }"
            :title="`${viewSummary(v)}（点击应用）`"
            @click="applySavedView(v.id)"
          >
            <span class="view-name">{{ v.name }}</span>
            <span
              class="view-remove"
              role="button"
              tabindex="0"
              title="删除该视图（不影响筛选状态）"
              :aria-label="`删除视图 ${v.name}`"
              @click.stop="deleteSavedView(v.id)"
              @keydown.enter.stop.prevent="deleteSavedView(v.id)"
              @keydown.space.stop.prevent="deleteSavedView(v.id)"
            >✕</span>
          </button>
        </li>
      </ul>
      <div v-if="savingView" class="view-save-form">
        <input
          ref="viewNameInput"
          v-model="viewName"
          type="text"
          maxlength="30"
          placeholder="视图名称…"
          spellcheck="false"
          @keydown.enter="onSaveViewConfirm"
          @keydown.esc="cancelSaveView"
        />
        <div class="view-save-actions">
          <button class="btn btn-primary" :disabled="savingBusy" @click="onSaveViewConfirm">保存</button>
          <button class="btn" @click="cancelSaveView">取消</button>
        </div>
      </div>
      <button
        v-else
        class="btn view-save-btn"
        :disabled="!state.folder"
        title="将当前搜索 / 分类 / 收藏 / 排序组合保存为视图，便于一键切换"
        @click="startSaveView"
      >
        保存当前筛选为视图
      </button>
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

    <!-- 底部页面入口：统计页 + 设置页（同占内容区，互斥打开） -->
    <div class="page-entry">
      <button class="btn stats-btn" title="查看库统计" @click="openStats">
        统计
      </button>
      <button class="btn settings-btn" title="打开设置" @click="openSettings">
        设置
      </button>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: 232px;
  flex-shrink: 0;
  border-right: 1px solid var(--glass-border);
  /* 玻璃侧栏：磨砂透出底层极光 */
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 16px 12px;
  gap: 20px;
}

.side-section h3 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  color: var(--text-muted);
  margin-bottom: 8px;
  padding-left: 6px;
}

.folder-box {
  /* 半透明底透出侧栏磨砂，亮边模拟玻璃切面 */
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  padding: 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.folder-name {
  font-size: var(--font-sm);
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
  padding: 6px 12px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text);
  font-size: var(--font-xs);
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
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 10px;
  cursor: pointer;
  /* 键盘可达（OPT-2）：以透明度替代 display:none——后者会移出 Tab 序列；
     隐藏态同时屏蔽指针事件，保持既有点击语义（隐藏时点击该区域仍作用于
     父级「切换模型库」按钮）；悬停或键盘聚焦（:focus-visible）时显现并可交互 */
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--dur-fast) var(--ease-out);
}

.root-item:hover .root-remove,
.root-remove:focus-visible {
  opacity: 1;
  pointer-events: auto;
}

.root-remove:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.root-remove:hover {
  background: var(--danger);
  color: #fff;
}

/* ---------- 智能视图（组合筛选收藏） ---------- */
.view-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 8px;
}

.view-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text);
  font-size: var(--font-xs);
  cursor: pointer;
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}

.view-item:hover {
  background: var(--bg-hover);
}

/* 当前筛选命中的视图：与分类选中态一致的强调光条 */
.view-item.active {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--accent) 16%, transparent),
    color-mix(in srgb, var(--accent) 4%, transparent) 70%,
    transparent
  );
  box-shadow: inset 2px 0 0 var(--accent);
}

.view-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 删除按钮：键盘可达（OPT-2），装配语义与 .root-remove 一致 */
.view-remove {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 10px;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--dur-fast) var(--ease-out);
}

.view-item:hover .view-remove,
.view-remove:focus-visible {
  opacity: 1;
  pointer-events: auto;
}

.view-remove:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.view-remove:hover {
  background: var(--danger);
  color: #fff;
}

.view-save-btn {
  width: 100%;
  text-align: center;
  padding: 7px 6px;
  font-size: var(--font-xs);
}

/* 内联命名表单：玻璃输入框（与搜索框同族），操作按钮右对齐 */
.view-save-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.view-save-form input {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--text);
  font-size: var(--font-xs);
  outline: none;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}

.view-save-form input:focus {
  border-color: var(--accent);
  box-shadow: var(--glow-accent);
}

.view-save-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.view-save-actions .btn {
  padding: 5px 14px;
  font-size: var(--font-xs);
}

.type-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text);
  font-size: var(--font-sm);
  cursor: pointer;
  text-align: left;
}

.type-item {
  transition: background var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}

.type-item:hover {
  background: var(--bg-hover);
}

/* 选中分类：左侧强调光条 + 渐变淡出的极光底色 */
.type-item.active {
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--accent) 16%, transparent),
    color-mix(in srgb, var(--accent) 4%, transparent) 70%,
    transparent
  );
  box-shadow: inset 2px 0 0 var(--accent);
}

/* 类型色点样式（.type-dot）为 main.css 公共类；此处仅补「全部」渐变变体 */
.all-dot {
  background: var(--accent-grad);
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
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-full);
  padding: 0 8px;
  min-width: 20px;
  text-align: center;
}

/* ---------- 操作按钮区（模型文件夹与分类之间） ---------- */
.action-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 两列网格：压缩纵向空间；半宽按钮用更紧凑的内边距与小字号 */
.action-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.action-btn {
  width: 100%;
  text-align: center;
}

.action-grid .action-btn {
  padding: 7px 6px;
  font-size: var(--font-xs);
}

/* ---------- 底部页面入口（统计/设置，固定侧边栏最底部，全宽） ---------- */
.page-entry {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
  margin-top: auto;
}

.stats-btn,
.settings-btn {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 12px;
}

/* 窄屏图标栏（OPT-1）：断点 960px 与 TopBar.vue 的窄屏操作菜单联动——
   此范围内操作区（重新扫描/选择文件夹/导出）整体隐藏，
   改由标题栏 ☰ 菜单提供同等入口；改动任一侧断点时须同步另一侧。
   960px 与窗口 minWidth 对齐：100% DPI 下拖到最窄即可触达（原 900px 存在死区） */
@media (max-width: 960px) {
  .sidebar {
    width: 64px;
    padding: 16px 6px;
  }
  .folder-box,
  .type-label,
  .type-count,
  .side-section h3,
  .action-section,
  .views-section {
    display: none;
  }
  .type-item {
    justify-content: center;
    padding: 9px 0;
  }
}
</style>
