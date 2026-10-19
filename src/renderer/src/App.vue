<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import TopBar from './components/TopBar.vue'
import Sidebar from './components/Sidebar.vue'
import BatchBar from './components/BatchBar.vue'
import ConfirmOverlay from './components/ConfirmOverlay.vue'
import ModelDetail from './components/ModelDetail.vue'
import SettingsPage from './components/SettingsPage.vue'
import ToastHost from './components/ToastHost.vue'
import VirtualModelGrid from './components/VirtualModelGrid.vue'
import VirtualModelList from './components/VirtualModelList.vue'
import { useGlobalShortcuts } from './composables/useGlobalShortcuts'
import { useMainProcessEvents } from './composables/useMainProcessEvents'
import {
  allTags,
  cancelScan,
  chooseFolder,
  duplicateIdSet,
  duplicateWastedBytes,
  BASE_MODEL_FAMILIES,
  filteredModels,
  formatSize,
  initApp,
  LORA_TAGS,
  saveSettings,
  scanModels,
  selectRedundantDuplicates,
  SORT_OPTIONS,
  sortDirectional,
  state,
  toast,
  toggleMultiSelectMode,
  typeInfo
} from './store/appStore'

/**
 * 应用根布局（O-4 拆分）：
 * - 全局快捷键（B-03）→ composables/useGlobalShortcuts.js
 * - 主进程事件订阅与自动重扫防抖（E8/A-07a）→ composables/useMainProcessEvents.js
 * 本文件保留：搜索防抖、排序/视图切换、重复筛选入口、窗口级拖放兜底、
 * 应用初始化编排与整体模板/样式。
 */

const searchInput = ref(state.search)
/** 搜索框 DOM 引用（Ctrl+F 聚焦用） */
const searchFieldEl = ref(null)
let searchTimer = null

// 搜索输入防抖，避免大量模型时每键触发过滤
watch(searchInput, (value) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    state.search = value
  }, 200)
})

// 反向同步（智能视图应用等外部路径改写 state.search）：回填搜索框显示。
// 不等才赋值——输入防抖链路随后写回同值，不会形成回环
watch(
  () => state.search,
  (value) => {
    if (value !== searchInput.value) {
      clearTimeout(searchTimer)
      searchInput.value = value
    }
  }
)

function clearSearch() {
  clearTimeout(searchTimer)
  searchInput.value = ''
  state.search = ''
}

// 全局快捷键（依赖搜索框引用与清空搜索动作）
useGlobalShortcuts(searchFieldEl, clearSearch)

// 主进程事件订阅：先于 initApp 就位（App onMounted 注册在其后）
const mainEvents = useMainProcessEvents()

/** 切换排序方式：立即生效并静默持久化，重启后保持用户选择 */
async function onSortChange(e) {
  state.sortBy = e.target.value
  await saveSettings({ sortBy: state.sortBy })
}

/** 收藏优先/按评分为固定语义排序，方向切换无意义（O1） */
const sortDirEnabled = computed(() => sortDirectional(state.sortBy))

/** 切换排序方向（U2）：翻转当前排序结果并持久化 */
async function onSortDirChange() {
  state.sortAsc = !state.sortAsc
  await saveSettings({ sortAsc: state.sortAsc })
}

/** 切换列表/网格视图：立即生效并静默持久化，重启后保持用户选择 */
async function onToggleViewMode() {
  state.viewMode = state.viewMode === 'grid' ? 'list' : 'grid'
  await saveSettings({ viewMode: state.viewMode })
}

/* ---------------- 重复模型检测（FEAT-1，F9 闭环） ---------------- */

/** 重复模型数（重复组内全部成员；0 表示当前无可见的重复项，隐藏筛选入口） */
const duplicateCount = computed(() => duplicateIdSet.value.size)

/** 重复清理：每组保留最优一份，冗余副本加入多选，交由用户复核后批量删除 */
function onSelectRedundant() {
  const n = selectRedundantDuplicates()
  if (n > 0) toast('info', `已选中 ${n} 个冗余副本，复核后按 Delete 移入回收站`)
}

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
  // 搜索防抖定时器：回调为裸闭包（写 state.search），卸载后若仍到期
  // 会滞后覆写全局搜索词（测试中跨用例竞态的根源）
  clearTimeout(searchTimer)
  mainEvents.unsubscribeAll()
})
</script>

<template>
  <div class="layout">
    <TopBar />

    <div class="main-area">
      <Sidebar />

      <main class="content">
        <!-- 设置页面：占用模型预览区位置 -->
        <SettingsPage v-if="state.settingsOpen" />

        <!-- 模型预览区 -->
        <template v-else>
        <!-- 重扫失败但仍有上次结果：顶部错误横幅（B15） -->
        <div v-if="state.scanError && !state.scanning && state.models.length > 0" class="scan-error-bar alert-gold">
          <span class="scan-error-text" :title="state.scanError">⚠ {{ state.scanError }}</span>
          <button class="scan-error-retry" @click="scanModels">重试</button>
        </div>

        <!-- 搜索 + 排序：位于模型清单上方（选择文件夹后显示） -->
        <div v-if="state.folder" class="search-row">
          <div class="search-box" title="搜索名称、备注名、备注与分类标签">
            <span class="search-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.6" /><path d="M10.6 10.6 14 14" /></svg>
            </span>
            <input
              ref="searchFieldEl"
              v-model="searchInput"
              type="text"
              placeholder="搜索名称 / 备注 / 触发词…（Ctrl+F 聚焦）"
              spellcheck="false"
            />
            <button v-if="searchInput" class="search-clear" title="清空搜索" @click="clearSearch">
              <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
            </button>
          </div>

          <div class="sort-select" title="排序方式">
            <span class="sort-label">排序</span>
            <select :value="state.sortBy" @change="onSortChange">
              <option v-for="s in SORT_OPTIONS" :key="s.key" :value="s.key">{{ s.label }}</option>
            </select>
            <button
              class="sort-dir"
              :disabled="!sortDirEnabled"
              :title="
                !sortDirEnabled
                  ? '该排序为固定方向（收藏/高分在前），不支持切换'
                  : state.sortAsc
                    ? '当前升序，点击切换为降序'
                    : '当前降序，点击切换为升序'
              "
              @click="onSortDirChange"
            >
              <svg v-if="state.sortAsc" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" /></svg>
              <svg v-else viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3.5v9M4.5 9 8 12.5 11.5 9" /></svg>
            </button>
          </div>

          <!-- 列表/网格视图切换 -->
          <button
            class="view-toggle"
            :title="state.viewMode === 'grid' ? '当前网格视图，点击切换为列表视图' : '当前列表视图，点击切换为网格视图'"
            :aria-label="state.viewMode === 'grid' ? '切换为列表视图' : '切换为网格视图'"
            @click="onToggleViewMode"
          >
            <svg v-if="state.viewMode === 'grid'" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" /><circle cx="5" cy="4" r="0.4" fill="currentColor" /><circle cx="5" cy="8" r="0.4" fill="currentColor" /><circle cx="5" cy="12" r="0.4" fill="currentColor" /></svg>
            <svg v-else viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="2" y="2" width="5.4" height="5.4" rx="1.2" /><rect x="8.6" y="2" width="5.4" height="5.4" rx="1.2" /><rect x="2" y="8.6" width="5.4" height="5.4" rx="1.2" /><rect x="8.6" y="8.6" width="5.4" height="5.4" rx="1.2" /></svg>
          </button>
        </div>

        <!-- 启动加载中（B8）：异步恢复上次模型库的空窗期，已配置过文件夹的
             用户不闪现「开始使用」引导页 -->
        <div v-if="state.booting" class="empty-state">
          <div class="spinner"></div>
          <h2>正在启动…</h2>
        </div>

        <!-- 未选择文件夹 -->
        <div v-else-if="!state.folder && !state.scanning" class="empty-state">
          <div class="empty-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="52" height="52" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /></svg>
          </div>
          <h2>开始使用</h2>
          <p>选择存放 Stable Diffusion 模型、LoRA 等文件的文件夹，<br />模匣将自动识别并分类其中的模型。</p>
          <button class="btn btn-primary btn-large" @click="chooseFolder">选择模型文件夹</button>
        </div>

        <!-- 扫描中 -->
        <div v-else-if="state.scanning" class="empty-state">
          <div class="spinner"></div>
          <h2>正在扫描模型…</h2>
          <p class="muted">
            已扫描 {{ state.progress.dirs }} 个目录，发现 {{ state.progress.found }} 个模型
          </p>
          <p class="scan-current">{{ state.progress.current }}</p>
          <button class="btn" @click="cancelScan">取消扫描</button>
        </div>

        <!-- 扫描失败：展示错误详情并提供重试（B15） -->
        <div v-else-if="state.scanError" class="empty-state">
          <div class="empty-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="52" height="52" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 21.5 20h-19z" /><path d="M12 10v4.5" /><circle cx="12" cy="17.4" r="0.4" fill="currentColor" stroke="none" /></svg>
          </div>
          <h2>扫描失败</h2>
          <p class="muted scan-error-detail">{{ state.scanError }}</p>
          <button class="btn btn-primary btn-large" @click="scanModels">重新扫描</button>
        </div>

        <!-- 库中无任何模型（未应用筛选时；保留结果栏逻辑见下方，避免筛选状态死锁） -->
        <div v-else-if="state.models.length === 0" class="empty-state">
          <div class="empty-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="52" height="52" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.3 15.3 20.5 20.5" /></svg>
          </div>
          <h2>没有匹配的模型</h2>
          <p class="muted">
            当前文件夹中未发现支持的模型文件（.safetensors / .ckpt / .pt / .pth / .bin），可尝试点击侧边栏「重新扫描」。
          </p>
        </div>

        <!-- 模型网格 -->
        <template v-else>
          <div class="result-bar">
            <span class="muted">共 {{ filteredModels.length }} 个模型</span>
            <span v-if="state.typeFilter !== 'all'" class="chip">
              {{ typeInfo(state.typeFilter).label }}
            </span>
            <!-- 收藏筛选：仅显示收藏的模型 -->
            <button
              class="fav-filter"
              :class="{ active: state.showFavoritesOnly }"
              :title="state.showFavoritesOnly ? '显示全部模型' : '仅显示收藏的模型'"
              @click="state.showFavoritesOnly = !state.showFavoritesOnly"
            >
              <svg viewBox="0 0 24 24" width="11" height="11" :fill="state.showFavoritesOnly ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.6l2.5 5.2 5.7.7-4.2 3.9 1.1 5.6L12 16.1 6.9 19l1.1-5.6-4.2-3.9 5.7-.7z" /></svg>
              收藏
            </button>
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
            <!-- 多选模式开关（E4） -->
            <button
              class="fav-filter"
              :class="{ active: state.multiSelect.active }"
              :title="state.multiSelect.active ? '退出多选模式' : '进入多选模式，批量管理模型'"
              @click="toggleMultiSelectMode"
            >
              <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="3" /><path d="M5 8.2l2.1 2.1L11.4 6" stroke-linecap="round" stroke-linejoin="round" /></svg>
              多选
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

          <!-- 多选批量操作栏（E4/E6，O9 拆分为 BatchBar 组件）：
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
        </template>
      </template>
      </main>
    </div>

    <footer class="footer">
      <span>模匣 · 本地 AI 绘画模型管理</span>
    </footer>

    <ModelDetail />
    <ToastHost />

    <!-- 自定义确认层（U4，O9 拆分为 ConfirmOverlay 组件）：
         替代 window.confirm，覆盖区不包含标题栏（保持窗口控制可达） -->
    <ConfirmOverlay />
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

/* 扫描失败空态的错误详情：允许换行完整展示 */
.scan-error-detail {
  max-width: 70%;
  word-break: break-all;
}

.search-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.search-box {
  position: relative;
  display: flex;
  align-items: center;
  width: min(360px, 40vw);
}

.search-icon {
  position: absolute;
  left: 10px;
  display: inline-flex;
  color: var(--text-muted);
  opacity: 0.7;
  pointer-events: none;
}

.search-box input {
  width: 100%;
  padding: 8px 30px 8px 30px;
  /* 玻璃输入框：半透明底 + 亮边 */
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--text);
  font-size: var(--font-sm);
  outline: none;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}

.search-box input:focus {
  border-color: var(--accent);
  box-shadow: var(--glow-accent);
}

.search-clear {
  position: absolute;
  right: 4px;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.search-clear:hover {
  background: var(--bg-hover);
  color: var(--text);
}

/* ---------- 排序下拉（搜索行最右侧） ---------- */
.sort-select {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  margin-left: auto;
}

.sort-label {
  font-size: var(--font-xs);
  color: var(--text-muted);
}

.sort-select select {
  padding: 7px 28px 7px 12px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--text);
  font-size: var(--font-sm);
  font-family: inherit;
  outline: none;
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%238a97a5' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
}

.sort-select select:hover,
.sort-select select:focus {
  border-color: var(--accent);
}

/* 排序方向切换按钮（U2） */
.sort-dir {
  padding: 6px 12px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--text-muted);
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  transition: color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}

.sort-dir:hover,
.sort-dir:focus-visible {
  color: var(--accent);
  border-color: var(--accent);
  outline: none;
}

/* 列表/网格视图切换按钮（与排序方向按钮同族） */
.view-toggle {
  padding: 7px 10px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  color: var(--text-muted);
  line-height: 1;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  transition: color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}

.view-toggle:hover,
.view-toggle:focus-visible {
  color: var(--accent);
  border-color: var(--accent);
  outline: none;
}

.result-bar {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* LoRA 分类筛选：靠结果栏右侧 */
.sub-filter {
  margin-left: auto;
}

.chip {
  font-size: 11px;
  padding: 3px 12px;
  border-radius: var(--radius-full);
  background: var(--bg-active);
  color: var(--accent);
}

/* 可取消的筛选 chip（B-01 目录筛选） */
.chip-clearable {
  border: 1px solid var(--accent);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.chip-clear {
  font-size: 10px;
  opacity: 0.7;
}

.chip-clearable:hover .chip-clear {
  opacity: 1;
}

/* 收藏筛选按钮 */
.fav-filter {
  font-size: var(--font-xs);
  padding: 4px 12px;
  border-radius: var(--radius-full);
  border: 1px solid var(--glass-border-bright);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  transition: color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out),
    box-shadow var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}

.fav-filter:hover {
  color: var(--favorite);
  border-color: var(--favorite);
}

.fav-filter.active {
  border-color: var(--favorite);
  color: var(--favorite);
  font-weight: 600;
  background: color-mix(in srgb, var(--favorite) 8%, transparent);
  box-shadow: var(--glow-favorite);
}

/* 空状态 */
.empty-state {
  margin: auto;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 40px;
}

/* 空态线稿图标：强调色与中性色混合，柔和不刺眼 */
.empty-icon {
  color: color-mix(in srgb, var(--accent) 62%, var(--text-muted));
  display: inline-flex;
  filter: drop-shadow(0 0 18px color-mix(in srgb, var(--accent) 22%, transparent));
}

.empty-state h2 {
  font-size: 17px;
}

.empty-state p {
  font-size: var(--font-sm);
  color: var(--text-muted);
  line-height: 1.8;
}

.scan-current {
  font-family: var(--font-mono);
  font-size: 11px;
  opacity: 0.7;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 加载环：极光双色（蓝 → 紫） */
.spinner {
  width: 34px;
  height: 34px;
  border: 3px solid color-mix(in srgb, var(--border) 70%, transparent);
  border-top-color: var(--accent);
  border-right-color: var(--accent-2);
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.btn-large {
  padding: 12px 22px;
  font-size: var(--font-md);
}
</style>
