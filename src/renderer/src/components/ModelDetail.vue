<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AutoInfoPanel from './detail/AutoInfoPanel.vue'
import CivitaiPanel from './detail/CivitaiPanel.vue'
import CoverPanel from './detail/CoverPanel.vue'
import MetaForm from './detail/MetaForm.vue'
import { closeDetail, revealModel, selectedModel, showContextMenu, state } from '../store/appStore'

/**
 * 详情页面板骨架（O-4 拆分）：
 * - 中部标注表单列（表单状态/脏检测/保存/收藏评分）→ detail/MetaForm.vue
 * - 左侧封面管理 → detail/CoverPanel.vue（C1，既有拆分）
 * - 右侧信息列：文件元数据（自动解析）+ Civitai 识别信息 →
 *   detail/AutoInfoPanel.vue + detail/CivitaiPanel.vue（本文件编排）。
 *   AutoInfoPanel 的「一键填入」经 MetaForm 暴露的方法写入其本地表单。
 * 本文件保留：遮罩与面板骨架、打开/关闭焦点管理（O10）、Tab 焦点陷阱、
 * ESC 关闭与面板右键菜单。
 */

/** 中部表单列实例：承接 AutoInfoPanel 的「一键填入」（跨列写本地表单） */
const metaFormRef = ref(null)

/* ---------------- 焦点管理（O10：键盘/读屏可达性） ---------------- */

/** 面板容器（打开时焦点移入，tabindex=-1 仅作焦点落点） */
const panelEl = ref(null)
/** 打开详情前的焦点元素（关闭时归还，键盘用户不丢焦点） */
let restoreFocusEl = null

/** 面板内 Tab 序列中的可聚焦元素 */
function focusablesInPanel() {
  if (!panelEl.value) return []
  return [...panelEl.value.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )].filter((el) => !el.disabled && el.offsetParent !== null)
}

// 打开时焦点入面板、关闭时归还触发元素（与确认层同款可达性标准）；
// 模型间切换（model → model）不移动焦点
watch(selectedModel, (m, old) => {
  if (m && !old) {
    restoreFocusEl = document.activeElement
    nextTick(() => panelEl.value?.focus())
  } else if (!m && old) {
    if (restoreFocusEl && typeof restoreFocusEl.focus === 'function') restoreFocusEl.focus()
    restoreFocusEl = null
  }
})

/** Tab 焦点陷阱：Tab 不穿透遮罩聚焦到被遮挡的网格卡片，在面板内首末循环 */
function onPanelTab(e) {
  if (e.key !== 'Tab') return
  const items = focusablesInPanel()
  if (items.length === 0) return
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (e.shiftKey && (active === first || active === panelEl.value)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}

/** ESC 关闭详情页（U1）：设置页打开时让位给它的 ESC 处理；
 *  表单有未保存修改时经 closeDetail 内的确认拦截（C8）。
 *  确认层可见时整键让位（F1）：模态确认期间底层页面不得响应 ESC，
 *  否则会把刚被取消的确认层再次弹出 */
function onWindowKeydown(e) {
  if (state.confirm.visible) return
  if (e.key === 'Escape' && selectedModel.value && !state.settingsOpen) {
    closeDetail()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown)
})

/** 详情面板右键菜单 */
function onPanelContextMenu() {
  if (selectedModel.value) showContextMenu(selectedModel.value.id)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="selectedModel" class="detail-mask" @click.self="closeDetail">
      <section
        ref="panelEl"
        class="detail-panel"
        tabindex="-1"
        role="dialog"
        aria-modal="true"
        :aria-label="`模型详情：${selectedModel.alias || selectedModel.name}`"
        @contextmenu.prevent="onPanelContextMenu"
        @keydown="onPanelTab"
      >
        <header class="detail-header">
          <h2 :title="selectedModel.name">{{ selectedModel.alias || selectedModel.name }}</h2>
          <div class="detail-header-actions">
            <button class="btn" @click="revealModel(selectedModel.id)">打开所在文件夹</button>
            <button class="wc-btn" title="关闭" @click="closeDetail">
              <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
            </button>
          </div>
        </header>

        <div class="detail-body">
          <!-- 左侧：封面管理（CoverPanel，C1） -->
          <CoverPanel />

          <!-- 中部：推荐参数与标注（MetaForm，O-4 拆分） -->
          <MetaForm ref="metaFormRef" />

          <!-- 右侧：识别信息列（文件元数据自动解析 + Civitai 在线识别） -->
          <div class="detail-info-col">
            <AutoInfoPanel
              @apply-resolution="(resMin, resMax) => metaFormRef?.onAutoApplyResolution(resMin, resMax)"
              @apply-triggers="(words) => metaFormRef?.onAutoApplyTriggers(words)"
            />
            <CivitaiPanel />
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.detail-mask {
  position: fixed;
  /* 从标题栏下方开始，不遮挡标题栏与原生窗口控件（最小化/最大化/关闭） */
  top: var(--titlebar-height);
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--overlay-strong);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-detail);
  padding: 24px;
}

.detail-panel {
  /* 磨砂玻璃主面板：透出底层极光与网格 */
  background: var(--glass-bg-strong);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-xl);
  /* 三列布局（封面/表单/信息列）后加宽面板 */
  width: min(1180px, 100%);
  max-height: calc(100vh - var(--titlebar-height) - 48px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: var(--shadow-lg), 0 0 60px color-mix(in srgb, var(--accent) 6%, transparent);
}

.detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--glass-border);
}

.detail-header h2 {
  font-size: var(--font-lg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.detail-body {
  display: grid;
  /* 三列：封面 | 标注表单 | 识别信息（AutoInfo + Civitai） */
  grid-template-columns: 300px minmax(0, 1fr) 280px;
  gap: 20px;
  padding: 20px;
  overflow-y: auto;
}

/* 右侧识别信息列：文件元数据（自动解析）+ Civitai 识别，纵向排布 */
.detail-info-col {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

/* 窄窗口降级：信息列移到封面/表单下方整行铺开，避免三列挤压 */
@media (max-width: 1100px) {
  .detail-body {
    grid-template-columns: 300px minmax(0, 1fr);
  }
  .detail-info-col {
    grid-column: 1 / -1;
  }
}
</style>
