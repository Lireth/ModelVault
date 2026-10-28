<script setup>
import { onMounted, onUnmounted } from 'vue'
import CrossLibraryOverview from './CrossLibraryOverview.vue'
import StatsSection from './StatsSection.vue'
import { closeStats, state } from '../store/appStore'
import { useDialogFocus } from '../composables/useDialogFocus'

/**
 * 库统计页（自设置页独立成页）：
 * 全屏展示 StatsSection 的库总览/分类占比/标注覆盖率/基底分布/
 * 重复占用/TOP 5；数据全部由渲染层 state.models 派生，打开即最新。
 * 页面骨架与设置页同族（玻璃容器 + 头部关闭 + 可滚动主体），
 * ESC 关闭（确认层可见时让位，F1 独占策略）。
 * 焦点管理（O10/OPT-03）：页面级视图（非遮罩模态，trap=false）——
 * 挂载（打开）时焦点移入页面容器，关闭（卸载）时归还触发元素，
 * 与详情页/对比面板共用 useDialogFocus 同一可达性标准。
 */

// 组件随打开态挂载（App 侧 v-if），故在挂载时机做焦点进入
const { containerRef, focusIn } = useDialogFocus({ trap: false })
onMounted(focusIn)

function onKeydown(e) {
  if (state.confirm.visible) return
  if (e.key === 'Escape' && state.statsOpen) closeStats()
}

onUnmounted(() => window.removeEventListener('keydown', onKeydown))
onMounted(() => window.addEventListener('keydown', onKeydown))
</script>

<template>
  <div
    ref="containerRef"
    class="stats-page"
    tabindex="-1"
    role="region"
    aria-label="库统计"
  >
    <header class="stats-header">
      <h2>库统计</h2>
      <button class="wc-btn" title="关闭统计页" @click="closeStats">
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </button>
    </header>

    <div class="stats-body">
      <!-- 跨库存储总览（FN-01）：只读汇总所有已登记模型库 -->
      <CrossLibraryOverview />
      <StatsSection />
    </div>
  </div>
</template>

<style scoped>
/* 统计页：占据主内容区位置（与设置页同款玻璃容器） */
.stats-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--glass-bg-strong);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  /* 自适应水平缩进：与设置页同款（窄窗保底 24px，按比例扩展，宽窗封顶 140px） */
  --page-inset: clamp(24px, 8%, 140px);
}

.stats-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px var(--page-inset);
  border-bottom: 1px solid var(--glass-border);
  flex-shrink: 0;
}

.stats-header h2 {
  font-size: var(--font-lg);
}

/* 主体自适应缩进：与设置页一致，内容区随窗口保持适当占用 */
.stats-body {
  padding: 16px var(--page-inset);
  overflow-y: auto;
  scrollbar-gutter: stable;
}
</style>
