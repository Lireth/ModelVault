<script setup>
import {
  computed,
  defineAsyncComponent,
  onMounted,
  onUnmounted,
  ref,
} from 'vue'
import TopBar from './components/TopBar.vue'
import Sidebar from './components/Sidebar.vue'
import BatchBar from './components/BatchBar.vue'
import BatchFailuresBar from './components/BatchFailuresBar.vue'
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
import { MAX_IMPORT_PATHS } from '../../shared/app-enums'
import { MODEL_EXTENSION_SET } from '../../shared/model-extensions'
import {
  cancelImport,
  filteredModels,
  importModels,
  initApp,
  relocateFolder,
  scanModels,
  state,
  toast,
} from './store/appStore'

// 次要页面异步加载（OP-01）：设置页/统计页仅在打开时渲染，按需加载可显著
// 缩减启动期首包解析与执行量。详情页保持同步引用——其 Teleport 骨架常驻，
// 延迟加载不会节省启动成本，且同步挂载保证关闭时的焦点归还时序不变。
const SettingsPage = defineAsyncComponent(
  () => import('./components/SettingsPage.vue'),
)
const StatsPage = defineAsyncComponent(
  () => import('./components/StatsPage.vue'),
)

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
// .content-scroll 滚动区引用：驱动返回顶部按钮的显隐与滚动复位
const scrollEl = ref(null)

/* ---------------- 返回顶部按钮（U-滚动） ---------------- */

/** 滚动超过该距离（px）才显示按钮，避免顶部误触 */
const BACK_TOP_THRESHOLD = 240
const showBackTop = ref(false)
let backTopRafId = 0

/** 滚动事件 rAF 合帧：同一帧多次事件只取最后位置驱动显隐 */
function onContentScroll() {
  if (backTopRafId) return
  backTopRafId = requestAnimationFrame(() => {
    backTopRafId = 0
    showBackTop.value = (scrollEl.value?.scrollTop || 0) > BACK_TOP_THRESHOLD
  })
}

/** 平滑滚回顶部；虚拟滚动随 scroll 事件逐帧收敛，锚捕获同步更新 */
function backToTop() {
  scrollEl.value?.scrollTo({ top: 0, behavior: 'smooth' })
}

// 搜索框 DOM 引用与清空动作由 LibraryToolbar 持有（搜索防抖状态随其生灭），
// 经 defineExpose 转供给全局快捷键：Ctrl+F 聚焦 / Esc 逐层退出的清空搜索。
// 快捷键读取时机为按键时（惰性求值），工具行未挂载（面板打开/无文件夹）时为
// null，与 useGlobalShortcuts 的空值守卫语义一致
const searchFieldEl = computed(() => toolbarRef.value?.searchFieldEl || null)

/** OPT-02：导入进度百分比（优先按字节，未知体积时按条目） */
const importPercent = computed(() => {
  const p = state.importProgress
  if (!p) return 0
  if (Number.isFinite(p.totalBytes) && p.totalBytes > 0) {
    return Math.min(100, Math.round(((p.bytes || 0) / p.totalBytes) * 100))
  }
  if (Number.isFinite(p.total) && p.total > 0) {
    return Math.min(100, Math.round(((p.done || 0) / p.total) * 100))
  }
  return 0
})
/** 取消请求已发出（等待主进程清理当前未完成文件） */
const importCancelPending = computed(() =>
  Boolean(state.importProgress?.canceled || state.importProgress?.canceling),
)

function clearSearch() {
  toolbarRef.value?.clearSearch()
}

// 全局快捷键（依赖搜索框引用与清空搜索动作）
useGlobalShortcuts(searchFieldEl, clearSearch)

// 主进程事件订阅：先于 initApp 就位（App onMounted 注册在其后）
const mainEvents = useMainProcessEvents()

/**
 * 拖放兜底（B13）：阻止非文件拖放（文本/链接等）触发默认导航覆盖当前窗口。
 * 文件拖入封面/详情页的业务处理自行 preventDefault；
 * 未被业务处理消费的文件拖放由下方拖拽导入链路接管（F-4）。
 */

/* ---------------- 拖拽模型导入（F-4） ---------------- */

/** 整窗拖拽提示层是否可见（dragenter/dragleave 计数驱动） */
const dropActive = ref(false)
let dropDepth = 0
/** 拖离窗口的延迟隐藏定时器：dragleave 后短暂保留，若仍在窗口内
 *  下一条 dragover/dragenter 会取消它，避免子元素切换造成闪烁或卡层 */
let dropHideTimer = 0

function clearDropHideTimer() {
  if (dropHideTimer) {
    clearTimeout(dropHideTimer)
    dropHideTimer = 0
  }
}

/** 拖放数据是否包含文件（纯文本/链接拖放仍放行给输入控件的默认行为，U7） */
function hasDroppedFiles(dataTransfer) {
  return Array.from(dataTransfer?.types || []).includes('Files')
}

/**
 * 拖放目标是否为业务自身的文件接收区（详情页封面导入等）：
 * 命中时不显示模型导入提示层，drop 也由业务处理（其 preventDefault 后
 * 本链路按 defaultPrevented 跳过），避免图片拖入封面被当成模型导入。
 */
function isBusinessDropTarget(target) {
  return Boolean(target?.closest?.('[data-drop-images]'))
}

/**
 * 拖入文件名是否为支持的模型扩展名（兼容 WebUI 的 `.disabled` 双重后缀）。
 * 与主进程 isImportableModelFile 同一语义；渲染层先行过滤，避免无模型时
 * 仍弹出目标目录选择框。
 */
function isSupportedModelFile(fileName) {
  const lower = String(fileName || '').toLowerCase()
  const name = lower.endsWith('.disabled')
    ? lower.slice(0, -'.disabled'.length)
    : lower
  const dot = name.lastIndexOf('.')
  return dot > 0 && MODEL_EXTENSION_SET.has(name.slice(dot))
}

/** 从拖放数据解析可导入的绝对路径（preload webUtils；失败项静默跳过） */
function modelPathsFromDrop(dataTransfer) {
  const paths = []
  for (const file of Array.from(dataTransfer?.files || [])) {
    if (!isSupportedModelFile(file?.name)) continue
    try {
      const filePath = window.api.getPathForFile(file)
      if (typeof filePath === 'string' && filePath) paths.push(filePath)
    } catch {
      /* 路径解析失败按未拖入处理 */
    }
  }
  return paths
}

function onWindowDragOver(e) {
  e.preventDefault()
  // 拖拽仍在窗口内：取消「拖离窗口」的延迟隐藏
  if (dropActive.value) clearDropHideTimer()
}

function onWindowDragEnter(e) {
  if (!hasDroppedFiles(e.dataTransfer)) return
  if (isBusinessDropTarget(e.target)) {
    // 进入业务接收区（封面等）：收起模型导入提示，drop 让位给业务处理
    clearDropHideTimer()
    dropDepth = 0
    dropActive.value = false
    return
  }
  clearDropHideTimer()
  dropDepth += 1
  dropActive.value = true
}

/** 子元素间移动会成对触发 dragleave/dragenter：计数归零才隐藏提示层 */
function onWindowDragLeave() {
  if (!dropActive.value) return
  dropDepth = Math.max(0, dropDepth - 1)
  if (dropDepth > 0) return
  clearDropHideTimer()
  dropHideTimer = setTimeout(() => {
    dropHideTimer = 0
    dropDepth = 0
    dropActive.value = false
  }, 150)
}

async function onWindowDrop(e) {
  // 业务接收区（封面拖图等）已处理：不再重复走模型导入
  const handledByBusiness = e.defaultPrevented
  const hasFiles = hasDroppedFiles(e.dataTransfer)
  if (hasFiles) e.preventDefault()
  clearDropHideTimer()
  dropDepth = 0
  dropActive.value = false
  if (!hasFiles || handledByBusiness) return

  const paths = modelPathsFromDrop(e.dataTransfer)
  if (paths.length === 0) {
    toast(
      'warn',
      '未检测到受支持的模型文件（支持 safetensors / ckpt / pt / pth / bin）',
    )
    return
  }
  if (paths.length > MAX_IMPORT_PATHS) {
    toast(
      'warn',
      `一次最多导入 ${MAX_IMPORT_PATHS} 个模型，已截取前 ${MAX_IMPORT_PATHS} 个`,
    )
  }
  // 默认复制入台；按住 Shift 松开则移动入台（与资源管理器拖放语义近似）
  await importModels(
    e.shiftKey ? 'move' : 'copy',
    paths.slice(0, MAX_IMPORT_PATHS),
  )
}

onMounted(async () => {
  window.addEventListener('dragenter', onWindowDragEnter)
  window.addEventListener('dragleave', onWindowDragLeave)
  window.addEventListener('dragover', onWindowDragOver)
  window.addEventListener('drop', onWindowDrop)
  // 返回顶部按钮：监听内容区滚动（rAF 合帧，仅驱动显隐）
  scrollEl.value?.addEventListener('scroll', onContentScroll, { passive: true })
  // 订阅主进程事件（扫描进度/菜单动作/缩略图/落盘失败/目录变更/哈希预热）
  mainEvents.subscribe()
  await initApp()
})

onUnmounted(() => {
  clearDropHideTimer()
  window.removeEventListener('dragenter', onWindowDragEnter)
  window.removeEventListener('dragleave', onWindowDragLeave)
  window.removeEventListener('dragover', onWindowDragOver)
  window.removeEventListener('drop', onWindowDrop)
  mainEvents.unsubscribeAll()
  // 返回顶部：清理滚动监听与未完成的 rAF 合帧
  scrollEl.value?.removeEventListener('scroll', onContentScroll)
  if (backTopRafId) cancelAnimationFrame(backTopRafId)
})
</script>

<template>
  <div class="layout">
    <TopBar />

    <div class="main-area">
      <Sidebar />

      <main class="content">
        <!-- 模型视图固定区（仅模型视图渲染）：状态横幅与工具行常驻不滚动，
             滚动仅发生在下方 .content-scroll——列表内容不会经过工具行背后，
             无需玻璃遮罩（替代旧 sticky 吸附方案） -->
        <template v-if="!state.statsOpen && !state.settingsOpen">
          <!-- 离线横幅（F1-offline 双形态之一）：库路径失效但有缓存模型可展示时
               顶部提示（区别于金色 scan-error-bar 的普通扫描失败）；空库时的
               全屏形态由 LibraryStates 离线分支承担 -->
          <div
            v-if="state.folderMissing && state.models.length > 0"
            class="offline-bar"
          >
            <span class="offline-text" :title="state.folder">
              ⚠ 模型文件夹不可用：{{
                state.folder
              }}（可能被移动、重命名或盘符未挂载，重新定位后标注自动恢复）
            </span>
            <button class="offline-btn" @click="relocateFolder">
              重新定位
            </button>
            <button class="offline-btn" @click="scanModels()">重试</button>
          </div>

          <!-- 重扫失败但仍有上次结果：顶部错误横幅（B15）；
               离线态语义更明确，优先由离线形态承担（F1-offline） -->
          <div
            v-if="
              state.scanError &&
              !state.folderMissing &&
              !state.scanning &&
              state.models.length > 0
            "
            class="scan-error-bar alert-gold"
          >
            <span class="scan-error-text" :title="state.scanError"
              >⚠ {{ state.scanError }}</span
            >
            <button class="scan-error-retry" @click="scanModels">重试</button>
          </div>

          <!-- 搜索 + 排序 + 视图切换（选择文件夹后显示；两种离线形态都隐藏工具栏） -->
          <LibraryToolbar
            v-if="state.folder && !state.folderMissing"
            ref="toolbarRef"
          />

          <!-- 返回顶部（U-滚动）：工具行常驻后深位浏览的快速回顶补充。
               固定于内容区右下角，滚动超过阈值淡入（onContentScroll），
               点击平滑回顶；仅模型视图渲染 -->
          <button
            class="back-top"
            :class="{ visible: showBackTop }"
            title="返回顶部"
            aria-label="返回顶部"
            @click="backToTop"
          >
            <svg
              viewBox="0 0 16 16"
              width="15"
              height="15"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M8 13V3.5" />
              <path d="M4.5 7 8 3.5 11.5 7" />
            </svg>
          </button>
        </template>

        <!-- 滚动区：统计/设置/模型视图共用的唯一滚动容器
             （useVirtualScroll 经 overflow-y 向上查找定位到此处） -->
        <div ref="scrollEl" class="content-scroll">
          <!-- 库统计页 / 设置页面：占用模型预览区位置（互斥），内部自带滚动 -->
          <StatsPage v-if="state.statsOpen" />
          <SettingsPage v-else-if="state.settingsOpen" />

          <!-- 模型预览区 -->
          <template v-else>
            <!-- 启动/引导/扫描/失败/空库五态互斥；库中有模型时渲染默认插槽 -->
            <LibraryStates>
              <!-- 筛选 chips（重复/LoRA/基底/标签） -->
              <ResultBar />

              <!-- 多选批量操作栏（E4/E6，O9 拆分为 BatchBar）：
                   位于多选开关所在的结果行与模型清单之间，靠近操作对象 -->
              <BatchBar />

              <!-- 批量失败明细条（B20/F3）：仅在最近一次批量操作有逐项失败时出现，
                   全成功不打扰；可展开定位、可重选失败项后用批量栏重试 -->
              <BatchFailuresBar />

              <!-- 空结果（有筛选条件时保留结果栏，便于切换分类/取消收藏筛选/清空搜索） -->
              <div v-if="filteredModels.length === 0" class="empty-state">
                <div class="empty-icon" aria-hidden="true">
                  <svg
                    viewBox="0 0 24 24"
                    width="52"
                    height="52"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.3"
                    stroke-linecap="round"
                  >
                    <circle cx="10.5" cy="10.5" r="6.5" />
                    <path d="M15.3 15.3 20.5 20.5" />
                  </svg>
                </div>
                <h2>没有匹配的模型</h2>
                <p class="muted">
                  当前筛选或搜索条件下没有模型，试试切换分类、取消「收藏」筛选或清空搜索词。
                </p>
              </div>

              <!-- 模型列表区：网格/紧凑列表双视图，虚拟滚动仅渲染视口附近行 -->
              <VirtualModelGrid
                v-if="state.viewMode === 'grid'"
                :models="filteredModels"
              />
              <VirtualModelList v-else :models="filteredModels" />
            </LibraryStates>
          </template>
        </div>
      </main>
    </div>

    <footer class="footer">
      <span>模匣 · 本地 AI 绘画模型管理</span>
    </footer>

    <ModelDetail />
    <ModelCompare />
    <ToastHost />

    <!-- OPT-02：模型导入任务浮条（全局可见）：进度 + 取消；关闭设置页后
         仍可中止，已完成条目保留，当前未完成目标由主进程清理 -->
    <div
      v-if="
        state.importing &&
        state.importProgress &&
        state.importProgress.total > 0
      "
      class="import-progress"
      role="status"
      aria-live="polite"
    >
      <div class="import-progress-main">
        <span class="import-progress-title">
          导入模型 {{ state.importProgress.done }}/{{
            state.importProgress.total
          }}
          <template v-if="state.importProgress.fileName">
            · {{ state.importProgress.fileName }}</template
          >
        </span>
        <div class="import-progress-track">
          <div
            class="import-progress-fill"
            :style="{ width: `${importPercent}%` }"
          ></div>
        </div>
      </div>
      <button
        class="btn import-progress-cancel"
        :disabled="importCancelPending"
        @click="cancelImport"
      >
        {{ importCancelPending ? '取消中…' : '取消导入' }}
      </button>
    </div>

    <!-- F-4 拖拽模型导入：整窗提示层（不拦截指针，drop 仍落到底层并由
         窗口级监听接管）；松开后由主进程弹出目标文件夹选择 -->
    <div v-if="dropActive" class="drop-import-mask" aria-hidden="true">
      <div class="drop-import-card">
        <svg
          viewBox="0 0 24 24"
          width="42"
          height="42"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M12 3v11" />
          <path d="M7.5 9.5 12 14l4.5-4.5" />
          <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
        </svg>
        <strong>松开以导入模型文件</strong>
        <span>默认复制入台；按住 <kbd>Shift</kbd> 松开则移动入台</span>
        <span class="drop-import-hint"
          >松开后选择目标文件夹（须在当前模型库内）</span
        >
      </div>
    </div>

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
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px 24px 0;
  min-height: 0;
  align-content: start;
}

/* 滚动区：唯一滚动容器（模型列表/统计/设置共用）。工具行位于其上方常驻，
   列表内容不会滚动到工具行背后；底部内边距随内容滚动，滚到底时留出空隙 */
.content-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* 预留滚动条空间，避免滚动条出现/消失时模块左右错位 */
  scrollbar-gutter: stable;
  padding-bottom: 20px;
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
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
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
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out);
}

.scan-error-retry:hover {
  background: var(--favorite);
  color: var(--on-accent);
}

/* ---------- 导入任务浮条（OPT-02）：进度/文件名/取消 ---------- */
.import-progress {
  position: fixed;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  width: min(560px, calc(100vw - 48px));
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 10px 14px;
  background: var(--glass-bg-strong);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  z-index: var(--z-toast);
}

.import-progress-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.import-progress-title {
  font-size: var(--font-xs);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.import-progress-track {
  height: 4px;
  background: var(--border);
  border-radius: var(--radius-full);
  overflow: hidden;
}

.import-progress-fill {
  height: 100%;
  background: var(--accent-grad);
  transition: width var(--dur-fast) var(--ease-out);
}

.import-progress-cancel {
  flex-shrink: 0;
  font-size: var(--font-xs);
  padding: 3px 12px;
}

/* ---------- 拖拽导入提示层（F-4）：整窗虚线区域 + 中央提示卡 ---------- */
.drop-import-mask {
  position: fixed;
  top: var(--titlebar-height);
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--overlay-strong);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  /* 与详情浮层同层：拖拽期间覆盖全部内容；pointer-events: none 保证
     drop 事件继续落到窗口监听（提示层自身不消费拖放） */
  z-index: var(--z-detail);
  pointer-events: none;
}

.drop-import-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 28px 44px;
  color: var(--text);
  background: var(--glass-bg-strong);
  border: 1px dashed var(--accent);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
  text-align: center;
}

.drop-import-card svg {
  color: var(--accent);
}

.drop-import-card strong {
  font-size: var(--font-lg);
  font-weight: 600;
}

.drop-import-card span {
  font-size: var(--font-xs);
  color: var(--text-muted);
}

.drop-import-card kbd {
  padding: 1px 6px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--bg-card) 60%, transparent);
  font-family: var(--font-mono);
  font-size: var(--font-xs);
  color: var(--text);
}

.drop-import-hint {
  font-size: var(--font-xs);
  color: var(--text-muted);
  opacity: 0.8;
}

/* ---------- 返回顶部按钮（U-滚动）：玻璃圆钮与标题栏/浮条质感一致 ---------- */
.back-top {
  position: fixed;
  right: 24px;
  /* 悬浮于底栏（约 36px 高）上方，与导入浮条（居中）错开 */
  bottom: 52px;
  width: 38px;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--glass-border);
  border-radius: 50%;
  background: var(--glass-bg-strong);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: var(--text-muted);
  cursor: pointer;
  box-shadow: var(--shadow-lg);
  /* 低于详情浮层（--z-detail: 100）/通知，高于页面内容 */
  z-index: calc(var(--z-detail) - 10);
  opacity: 0;
  transform: translateY(10px);
  pointer-events: none;
  transition:
    opacity var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}

/* 滚动超过阈值（onContentScroll）时淡入；隐藏态拦截指针避免误触 */
.back-top.visible {
  opacity: 1;
  transform: none;
  pointer-events: auto;
}

.back-top:hover {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}

.back-top:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
