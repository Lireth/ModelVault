<script setup>
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import TopBar from './components/TopBar.vue'
import Sidebar from './components/Sidebar.vue'
import ModelDetail from './components/ModelDetail.vue'
import SettingsPage from './components/SettingsPage.vue'
import ToastHost from './components/ToastHost.vue'
import VirtualModelGrid from './components/VirtualModelGrid.vue'
import {
  acceptConfirm,
  applyThumbUpdates,
  cancelScan,
  chooseFolder,
  filteredModels,
  handleMenuAction,
  initApp,
  LORA_TAGS,
  rejectConfirm,
  saveSettings,
  scanModels,
  SORT_OPTIONS,
  state,
  toast,
  typeInfo
} from './store/appStore'

const searchInput = ref(state.search)
let searchTimer = null

// 搜索输入防抖，避免大量模型时每键触发过滤
watch(searchInput, (value) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    state.search = value
  }, 200)
})

function clearSearch() {
  clearTimeout(searchTimer)
  searchInput.value = ''
  state.search = ''
}

/** 切换排序方式：立即生效并静默持久化，重启后保持用户选择 */
async function onSortChange(e) {
  state.sortBy = e.target.value
  await saveSettings({ sortBy: state.sortBy })
}

/** 切换排序方向（U2）：翻转当前排序结果并持久化 */
async function onSortDirChange() {
  state.sortAsc = !state.sortAsc
  await saveSettings({ sortAsc: state.sortAsc })
}

let unsubscribeProgress = null
let unsubscribeMenu = null
let unsubscribeThumbs = null
let unsubscribeStoreError = null

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

/* ---------------- 确认层键盘支持（A8） ---------------- */

const confirmCancelBtn = ref(null)
const confirmOkBtn = ref(null)

/** 确认层键盘交互：ESC=取消、Enter=确认（焦点在按钮上时由按钮原生处理）、
 *  Tab 在两个按钮间循环（简单焦点陷阱），防止焦点穿透到被遮挡内容 */
function onConfirmKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    rejectConfirm()
  } else if (e.key === 'Tab') {
    e.preventDefault()
    ;(e.shiftKey ? confirmOkBtn.value : confirmCancelBtn.value)?.focus()
  } else if (e.key === 'Enter' && e.target?.tagName !== 'BUTTON') {
    e.preventDefault()
    acceptConfirm()
  }
}

// 打开确认层时把焦点移入「取消」按钮（安全默认）：此前焦点仍留在触发按钮上，
// Enter 会再次触发原操作而非确认；Tab 可达「确定」
watch(
  () => state.confirm.visible,
  async (visible) => {
    if (visible) {
      await nextTick()
      confirmCancelBtn.value?.focus()
    }
  }
)

onMounted(async () => {
  window.addEventListener('dragover', onWindowDragOver)
  window.addEventListener('drop', onWindowDrop)
  // 订阅扫描进度事件
  unsubscribeProgress = window.api.models.onScanProgress((progress) => {
    state.progress = progress
  })
  // 订阅右键菜单动作事件
  unsubscribeMenu = window.api.models.onMenuAction(({ id, action }) => {
    handleMenuAction(id, action)
  })
  // 订阅后台缩略图生成完成事件（首扫卡片先显示原图，缩略图补齐后替换）
  unsubscribeThumbs = window.api.models.onThumbsReady(({ updates }) => {
    applyThumbUpdates(updates)
  })
  // 订阅持久化落盘失败事件（B1/C7）：元数据与设置的落盘都在保存响应之后异步发生，
  // 失败须提示用户重试，否则磁盘错误时静默丢失
  unsubscribeStoreError = window.api.models.onStoreError(({ message }) => {
    toast('error', `数据保存失败: ${message}，请检查磁盘后重新保存`)
  })
  await initApp()
})

onUnmounted(() => {
  window.removeEventListener('dragover', onWindowDragOver)
  window.removeEventListener('drop', onWindowDrop)
  unsubscribeProgress?.()
  unsubscribeMenu?.()
  unsubscribeThumbs?.()
  unsubscribeStoreError?.()
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
        <div v-if="state.scanError && !state.scanning && state.models.length > 0" class="scan-error-bar">
          <span class="scan-error-text" :title="state.scanError">⚠ {{ state.scanError }}</span>
          <button class="scan-error-retry" @click="scanModels">重试</button>
        </div>

        <!-- 搜索 + 排序：位于模型清单上方（选择文件夹后显示） -->
        <div v-if="state.folder" class="search-row">
          <div class="search-box" title="搜索名称、备注名、备注与分类标签">
            <span class="search-icon">🔍</span>
            <input
              v-model="searchInput"
              type="text"
              placeholder="搜索名称 / 备注 / 触发词…"
              spellcheck="false"
            />
            <button v-if="searchInput" class="search-clear" title="清空搜索" @click="clearSearch">✕</button>
          </div>

          <div class="sort-select" title="排序方式">
            <span class="sort-label">排序</span>
            <select :value="state.sortBy" @change="onSortChange">
              <option v-for="s in SORT_OPTIONS" :key="s.key" :value="s.key">{{ s.label }}</option>
            </select>
            <button
              class="sort-dir"
              :title="state.sortAsc ? '当前升序，点击切换为降序' : '当前降序，点击切换为升序'"
              @click="onSortDirChange"
            >{{ state.sortAsc ? '↑' : '↓' }}</button>
          </div>
        </div>

        <!-- 未选择文件夹 -->
        <div v-if="!state.folder && !state.scanning" class="empty-state">
          <div class="empty-icon">📁</div>
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
          <div class="empty-icon">⚠️</div>
          <h2>扫描失败</h2>
          <p class="muted scan-error-detail">{{ state.scanError }}</p>
          <button class="btn btn-primary btn-large" @click="scanModels">重新扫描</button>
        </div>

        <!-- 库中无任何模型（未应用筛选时；保留结果栏逻辑见下方，避免筛选状态死锁） -->
        <div v-else-if="state.models.length === 0" class="empty-state">
          <div class="empty-icon">🔍</div>
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
            >★ 收藏</button>
            <!-- LoRA 分类筛选：仅选中 LoRA 分类时显示（即使筛选结果为空也保持可见） -->
            <label v-if="state.typeFilter === 'lora'" class="sort-select sub-filter" title="按 LoRA 分类筛选">
              <span class="sort-label">分类</span>
              <select v-model="state.subFilter">
                <option value="">全部</option>
                <option v-for="t in LORA_TAGS" :key="t.key" :value="t.key">{{ t.label }}</option>
              </select>
            </label>
          </div>

          <!-- 空结果（有筛选条件时保留结果栏，便于切换分类/取消收藏筛选/清空搜索） -->
          <div v-if="filteredModels.length === 0" class="empty-state">
            <div class="empty-icon">🔍</div>
            <h2>没有匹配的模型</h2>
            <p class="muted">当前筛选或搜索条件下没有模型，试试切换分类、取消「★ 收藏」筛选或清空搜索词。</p>
          </div>

          <!-- 模型网格：虚拟滚动，仅渲染视口附近的卡片 -->
          <VirtualModelGrid v-else :models="filteredModels" />
        </template>
      </template>
      </main>
    </div>

    <footer class="footer">
      <span>模匣 · 本地 AI 绘画模型管理</span>
    </footer>

    <ModelDetail />
    <ToastHost />

    <!-- 自定义确认层（U4）：替代 window.confirm，覆盖区不包含标题栏（保持窗口控制可达）；
         键盘支持见 onConfirmKeydown（A8：ESC=取消 / Enter=确认 / Tab 焦点陷阱） -->
    <Teleport to="body">
      <div
        v-if="state.confirm.visible"
        class="confirm-overlay"
        @click.self="rejectConfirm"
        @keydown="onConfirmKeydown"
      >
        <div class="confirm-dialog" role="dialog" aria-modal="true" aria-label="操作确认">
          <p class="confirm-text">{{ state.confirm.text }}</p>
          <div class="confirm-actions">
            <button ref="confirmCancelBtn" class="btn" @click="rejectConfirm">取消</button>
            <button ref="confirmOkBtn" class="btn btn-primary confirm-ok" @click="acceptConfirm">确定</button>
          </div>
        </div>
      </div>
    </Teleport>
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

/* ---------- 搜索框（模型清单上方） ---------- */
.scan-error-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border: 1px solid rgba(245, 179, 1, 0.45);
  background: rgba(245, 179, 1, 0.08);
  border-radius: 8px;
}

.scan-error-text {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--favorite);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scan-error-retry {
  flex-shrink: 0;
  font-size: 12px;
  padding: 3px 14px;
  border-radius: 999px;
  border: 1px solid var(--favorite);
  background: transparent;
  color: var(--favorite);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
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
  font-size: 12px;
  opacity: 0.55;
  pointer-events: none;
}

.search-box input {
  width: 100%;
  padding: 8px 30px 8px 30px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  outline: none;
}

.search-box input:focus {
  border-color: var(--accent);
}

.search-clear {
  position: absolute;
  right: 4px;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  cursor: pointer;
  border-radius: 6px;
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
}

.sort-label {
  font-size: 12px;
  color: var(--text-muted);
}

.sort-select select {
  padding: 7px 28px 7px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
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
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  transition: color 0.12s ease, border-color 0.12s ease;
}

.sort-dir:hover,
.sort-dir:focus-visible {
  color: var(--accent);
  border-color: var(--accent);
  outline: none;
}

.result-bar {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* LoRA 分类筛选：靠结果栏右侧 */
.sub-filter {
  margin-left: auto;
}

.chip {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--bg-active);
  color: var(--accent);
}

/* 收藏筛选按钮 */
.fav-filter {
  font-size: 12px;
  padding: 4px 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: color 0.12s ease, border-color 0.12s ease;
}

.fav-filter:hover {
  color: var(--favorite);
  border-color: var(--favorite);
}

.fav-filter.active {
  border-color: var(--favorite);
  color: var(--favorite);
  font-weight: 600;
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

.empty-icon {
  font-size: 44px;
}

.empty-state h2 {
  font-size: 17px;
}

.empty-state p {
  font-size: 13px;
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

.spinner {
  width: 34px;
  height: 34px;
  border: 3px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.btn-large {
  padding: 10px 22px;
  font-size: 14px;
}

/* ---------- 自定义确认层（U4） ---------- */
.confirm-overlay {
  position: fixed;
  /* 不遮标题栏：保留原生标题栏叠加层控件的可达性（项目约定） */
  top: var(--titlebar-height);
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-confirm);
}

.confirm-dialog {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px 24px;
  min-width: 320px;
  max-width: 480px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}

.confirm-text {
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}
</style>
