<script setup>
import { computed } from 'vue'
import SidebarDynamicViews from './sidebar/SidebarDynamicViews.vue'
import SidebarRoots from './sidebar/SidebarRoots.vue'
import SidebarTypes from './sidebar/SidebarTypes.vue'
import SidebarViews from './sidebar/SidebarViews.vue'
import { chooseFolder, openSettings, openStats, scanModels, state } from '../store/appStore'

/**
 * 侧栏编排壳（OPT-01 拆分）：
 * - 模型库切换（E7 多根目录 + 失效标记）→ sidebar/SidebarRoots.vue
 * - 智能视图（组合筛选收藏 + 内联命名表单）→ sidebar/SidebarViews.vue
 * - 动态视图（FN-07 内置规则实时求值）→ sidebar/SidebarDynamicViews.vue
 * - 分类筛选（全部 + 五大类型计数）→ sidebar/SidebarTypes.vue
 * - 板块标题样式（.side-section h3）→ main.css 公共类
 * 本文件保留：侧栏布局、模型文件夹信息、操作按钮区、底部页面入口。
 * 窄屏 960px 断点与 TopBar.vue 联动，各子组件自带同断点隐藏规则。
 */

const folderName = computed(() => {
  if (!state.folder) return '未选择文件夹'
  const parts = state.folder.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || state.folder
})

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
    <SidebarRoots />

    <!-- 智能视图（组合筛选收藏）：当前搜索/分类/收藏/排序组合存为命名视图，一键切换 -->
    <SidebarViews />

    <!-- 动态视图（FN-07）：内置规则随模型实时求值（未评分/近 30 天/长期未更新） -->
    <SidebarDynamicViews />

    <!-- 分类筛选 -->
    <SidebarTypes />

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
   960px 与窗口 minWidth 对齐：100% DPI 下拖到最窄即可触达（原 900px 存在死区）。
   库列表/视图/分类板块的窄屏规则在各自子组件内（sidebar/*.vue） */
@media (max-width: 960px) {
  .sidebar {
    width: 64px;
    padding: 16px 6px;
  }
  .folder-box,
  .side-section h3,
  .action-section {
    display: none;
  }
}
</style>
