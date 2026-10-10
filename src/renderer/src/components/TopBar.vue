<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  chooseFolder,
  exportModels,
  scanModels,
  state
} from '../store/appStore'

/**
 * 窄屏操作菜单（OPT-1）：
 * 侧边栏操作区（重新扫描/选择文件夹/导出）在窗口宽度 <900px 时
 * 被 Sidebar.vue 的媒体查询整体隐藏，核心操作在窄窗口下不可达。
 * 此处于标题栏提供替代入口（☰ 按钮 + 下拉菜单），仅在同样 <900px 时显示；
 * 宽屏下 display:none，桌面端布局与交互零变化。
 */

/** 下拉菜单根元素（判断指针事件是否来自菜单外部） */
const menuRoot = ref(null)
/** 菜单开合状态 */
const menuOpen = ref(false)

function toggleMenu() {
  menuOpen.value = !menuOpen.value
}

function closeMenu() {
  menuOpen.value = false
}

/** 重新扫描（与侧边栏按钮同规则：扫描中/未选择文件夹时禁用） */
function onRescan() {
  closeMenu()
  if (!state.scanning) scanModels()
}

function onChooseFolder() {
  closeMenu()
  chooseFolder()
}

/** 导出当前筛选后的模型列表（E2，格式与侧边栏入口一致） */
function onExport(format) {
  closeMenu()
  exportModels(format)
}

/** 点击菜单外部区域关闭（pointerdown 先于 click，避免误触菜单项后状态残留） */
function onWindowPointerDown(e) {
  if (menuOpen.value && !menuRoot.value?.contains(e.target)) closeMenu()
}

/**
 * ESC 关闭菜单（F1 同款独占策略）：捕获阶段拦截并 stopPropagation，
 * 阻止事件冒泡到窗口上的其他 ESC 处理器（详情页/设置页关闭），
 * 避免关闭菜单的同时误关其他面板。
 */
function onWindowKeydown(e) {
  if (e.key === 'Escape' && menuOpen.value) {
    e.stopPropagation()
    closeMenu()
  }
}

/** 断点与 Sidebar.vue 的 900px 联动：跨回宽屏时关闭菜单，避免触发按钮已隐藏而菜单残留 */
const narrowQuery = window.matchMedia('(max-width: 900px)')
function onNarrowChange(e) {
  if (!e.matches) closeMenu()
}

onMounted(() => {
  window.addEventListener('pointerdown', onWindowPointerDown)
  window.addEventListener('keydown', onWindowKeydown, { capture: true })
  narrowQuery.addEventListener('change', onNarrowChange)
})

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onWindowPointerDown)
  window.removeEventListener('keydown', onWindowKeydown, { capture: true })
  narrowQuery.removeEventListener('change', onNarrowChange)
})
</script>

<template>
  <!-- 标题栏：整行可拖动移动窗口；右上角为原生窗口控件（WCO） -->
  <header class="titlebar">
    <div class="brand">
      <span class="brand-name">模匣</span>
      <span class="brand-en">ModelVault</span>
    </div>

    <!-- 窄屏操作入口（OPT-1）：仅 <900px 显示，替代被隐藏的侧边栏操作区 -->
    <div ref="menuRoot" class="narrow-actions">
      <button
        class="wc-btn narrow-actions-btn"
        title="更多操作"
        aria-haspopup="true"
        :aria-expanded="menuOpen"
        @click="toggleMenu"
      >
        ☰
      </button>
      <div v-if="menuOpen" class="narrow-actions-menu" role="menu">
        <button
          class="menu-item"
          role="menuitem"
          title="重新扫描当前模型文件夹"
          :disabled="state.scanning || !state.folder"
          @click="onRescan"
        >
          {{ state.scanning ? '扫描中…' : '重新扫描' }}
        </button>
        <button
          class="menu-item"
          role="menuitem"
          title="选择模型文件夹"
          @click="onChooseFolder"
        >
          选择文件夹
        </button>
        <button
          class="menu-item"
          role="menuitem"
          title="将当前列表导出为 CSV 文件（可被 Excel 打开）"
          :disabled="!state.models.length"
          @click="onExport('csv')"
        >
          导出 CSV
        </button>
      </div>
    </div>
  </header>
</template>

<style scoped>
/* 窄屏操作入口（OPT-1）：默认隐藏，<900px 时显示（断点与 Sidebar.vue 联动） */
.narrow-actions {
  display: none;
  position: relative;
  /* 紧随品牌区之后布局，避开右上角原生窗口控件（WCO）区域 */
  margin-right: auto;
}

.narrow-actions-btn {
  font-size: 16px;
  line-height: 1;
  /* 标题栏整行为拖拽区，交互按钮必须排除拖动，否则点击被拖动区域吞掉 */
  -webkit-app-region: no-drag;
}

.narrow-actions-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  /* 高于内容区，低于详情弹层(100)/Toast(200)/确认层(210) */
  z-index: 50;
  min-width: 168px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
}

.menu-item {
  padding: 8px 12px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
  -webkit-app-region: no-drag;
}

.menu-item:hover:not(:disabled) {
  background: var(--bg-hover);
}

.menu-item:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 900px) {
  .narrow-actions {
    display: block;
  }
}
</style>
