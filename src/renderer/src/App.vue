<script setup>
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref } from 'vue'
import TopBar from './components/TopBar.vue'
import Sidebar from './components/Sidebar.vue'
import BatchBar from './components/BatchBar.vue'
import ConfirmOverlay from './components/ConfirmOverlay.vue'
import LibraryPickerOverlay from './components/LibraryPickerOverlay.vue'
import LibraryStates from './components/LibraryStates.vue'
import LibraryToolbar from './components/LibraryToolbar.vue'
import ModelCompare from './components/ModelCompare.vue'
import ModelDetail from './components/ModelDetail.vue'
import ResultBar from './components/ResultBar.vue'
import ToastHost from './components/ToastHost.vue'
import VirtualModelGrid from './components/VirtualModelGrid.vue'
import VirtualModelList from './components/VirtualModelList.vue'
import { useGlobalShortcuts } from './composables/useGlobalShortcuts'
import { useMainProcessEvents } from './composables/useMainProcessEvents'
import { filteredModels, initApp, relocateFolder, scanModels, state } from './store/appStore'

// 次要页面异步加载（OP-01）：设置页/统计页仅在打开时渲染，按需加载可显著
// 缩减启动期首包解析与执行量。详情页保持同步引用——其 Teleport 骨架常驻，
// 延迟加载不会节省启动成本，且同步挂载保证关闭时的焦点归还时序不变。
const SettingsPage = defineAsyncComponent(() => import('./components/SettingsPage.vue'))
const StatsPage = defineAsyncComponent(() => import('./components/StatsPage.vue'))

/**
 * 应用根布局（O-4/O-5 拆分）：
 * - 全局快捷键（B-03）→ composables/useGlobalShortcuts.js
 * - 主进程事件订阅与自动重扫防抖（E8/A-07a）→ composables/useMainProcessEvents.js
 * - 搜索防抖/排序/视图切换/收藏与多选开关 → LibraryToolbar（useSearchInput）
 * - 启动加载/引导/扫描/失败/空库五态 → LibraryStates（末分支渲染默认插槽）
 * - 筛选 chips（重复/LoRA/基底/标签）→ ResultBar
 * 本文件保留：布局壳与页面互斥切换、扫描错误横幅、窗口级拖放兜底、
 * 应用初始化编排、快捷键与工具行的转接（Ctrl+F / Esc 所需的搜索框引用）。
 */

const toolbarRef = ref(null)
// 搜索框 DOM 引用与清空动作由 LibraryToolbar 持有（搜索防抖状态随其生灭），
// 经 defineExpose 转供给全局快捷键：Ctrl+F 聚焦 / Esc 逐层退出的清空搜索。
// 快捷键读取时机为按键时（惰性求值），工具行未挂载（面板打开/无文件夹）时为
// null，与 useGlobalShortcuts 的空值守卫语义一致
const searchFieldEl = computed(() => toolbarRef.value?.searchFieldEl || null)

function clearSearch() {
  toolbarRef.value?.clearSearch()
}

// 全局快捷键（依赖搜索框引用与清空搜索动作）
useGlobalShortcuts(searchFieldEl, clearSearch)

// 主进程事件订阅：先于 initApp 就位（App onMounted 注册在其后）
const mainEvents = useMainProcessEvents()

/**
 * 拖放兜底（B13）：阻止非文件拖放（文本/链接等）触发默认导航覆盖当前窗口。
 * 文件拖入封面的业务处理在 ModelDetail 内完成（含 preventDefault），
 * 未被业务处理消费的拖放一律在此阻止默认行为。
 */
function onWindowDragOver(e) {
  e.preventDefault()
}

function onWindowDrop(e) {
  // 仅拦截文件类拖放（封面导入业务自行处理 preventDefault）；
  // 纯文本/链接拖放放行给目标控件（如排除目录 textarea）的默认插入行为（U7）
  if (Array.from(e.dataTransfer?.types || []).includes('Files')) {
    e.preventDefault()
  }
}

onMounted(async () => {
  window.addEventListener('dragover', onWindowDragOver)
  window.addEventListener('drop', onWindowDrop)
  // 订阅主进程事件（扫描进度/菜单动作/缩略图/落盘失败/目录变更/哈希预热）
  mainEvents.subscribe()
  await initApp()
})

onUnmounted(() => {
  window.removeEventListener('dragover', onWindowDragOver)
  window.removeEventListener('drop', onWindowDrop)
  mainEvents.unsubscribeAll()
})
</script>

<template>
  <div class="layout">
    <TopBar />

    <div class="main-area">
      <Sidebar />

      <main class="content">
        <!-- 库统计页 / 设置页面：占用模型预览区位置（互斥） -->
        <StatsPage v-if="state.statsOpen" />
        <SettingsPage v-else-if="state.settingsOpen" />

        <!-- 模型预览区 -->
        <template v-else>
          <!-- 离线横幅（F1-offline 双形态之一）：库路径失效但有缓存模型可展示时
               顶部提示（区别于金色 scan-error-bar 的普通扫描失败）；空库时的
               全屏形态由 LibraryStates 离线分支承担 -->
          <div v-if="state.folderMissing && state.models.length > 0" class="offline-bar">
            <span class="offline-text" :title="state.folder">
              ⚠ 模型文件夹不可用：{{ state.folder }}（可能被移动、重命名或盘符未挂载，重新定位后标注自动恢复）
            </span>
            <button class="offline-btn" @click="relocateFolder">重新定位</button>
            <button class="offline-btn" @click="scanModels()">重试</button>
          </div>

          <!-- 重扫失败但仍有上次结果：顶部错误横幅（B15）；
               离线态语义更明确，优先由离线形态承担（F1-offline） -->
          <div v-if="state.scanError && !state.folderMissing && !state.scanning && state.models.length > 0" class="scan-error-bar alert-gold">
            <span class="scan-error-text" :title="state.scanError">⚠ {{ state.scanError }}</span>
            <button class="scan-error-retry" @click="scanModels">重试</button>
          </div>

          <!-- 搜索 + 排序 + 视图切换（选择文件夹后显示；两种离线形态都隐藏工具栏） -->
          <LibraryToolbar v-if="state.folder && !state.folderMissing" ref="toolbarRef" />

          <!-- 启动/引导/扫描/失败/空库五态互斥；库中有模型时渲染默认插槽 -->
          <LibraryStates>
            <!-- 筛选 chips（重复/LoRA/基底/标签） -->
            <ResultBar />

            <!-- 多选批量操作栏（E4/E6，O9 拆分为 BatchBar）：
                 位于多选开关所在的结果行与模型清单之间，靠近操作对象 -->
            <BatchBar />

            <!-- 空结果（有筛选条件时保留结果栏，便于切换分类/取消收藏筛选/清空搜索） -->
            <div v-if="filteredModels.length === 0" class="empty-state">
              <div class="empty-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="52" height="52" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.3 15.3 20.5 20.5" /></svg>
              </div>
              <h2>没有匹配的模型</h2>
              <p class="muted">当前筛选或搜索条件下没有模型，试试切换分类、取消「收藏」筛选或清空搜索词。</p>
            </div>

            <!-- 模型列表区：网格/紧凑列表双视图，虚拟滚动仅渲染视口附近行 -->
            <VirtualModelGrid v-if="state.viewMode === 'grid'" :models="filteredModels" />
            <VirtualModelList v-else :models="filteredModels" />
          </LibraryStates>
        </template>
      </main>
    </div>

    <footer class="footer">
      <span>模匣 · 本地 AI 绘画模型管理</span>
    </footer>

    <ModelDetail />
    <ModelCompare />
    <ToastHost />

    <!-- 自定义确认层（U4，O9 拆分为 ConfirmOverlay 组件）：
         替代 window.confirm，覆盖区不包含标题栏（保持窗口控制可达） -->
    <ConfirmOverlay />
    <!-- 跨库传输选择层（F-3）：目标库列表 + 复制/移动模式 -->
    <LibraryPickerOverlay />
  </div>
</template>

<style scoped>
.main-area {
  flex: 1;
  display: flex;
  min-height: 0;
}

.content {
  flex: 1;
  overflow-y: auto;
  /* 预留滚动条空间，避免滚动条出现/消失时模块左右错位 */
  scrollbar-gutter: stable;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  align-content: start;
}

/* ---------- 离线横幅（F1-offline）：warning 色系，区别于金色 scan-error-bar ---------- */
.offline-bar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--warning);
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  border-radius: var(--radius-md);
}

.offline-text {
  flex: 1;
  min-width: 0;
  font-size: var(--font-xs);
  color: var(--warning);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.offline-btn {
  flex-shrink: 0;
  font-size: var(--font-xs);
  padding: 3px 16px;
  border-radius: var(--radius-full);
  border: 1px solid var(--warning);
  background: transparent;
  color: var(--warning);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}

.offline-btn:hover {
  background: var(--warning);
  color: var(--on-accent);
}

/* ---------- 扫描错误警示条：容器视觉为 main.css 公共类 .alert-gold ---------- */
.scan-error-bar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.scan-error-text {
  flex: 1;
  min-width: 0;
  font-size: var(--font-xs);
  color: var(--favorite);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scan-error-retry {
  flex-shrink: 0;
  font-size: var(--font-xs);
  padding: 3px 16px;
  border-radius: var(--radius-full);
  border: 1px solid var(--favorite);
  background: transparent;
  color: var(--favorite);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}

.scan-error-retry:hover {
  background: var(--favorite);
  color: var(--on-accent);
}
</style>
