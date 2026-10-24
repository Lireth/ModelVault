<script setup>
import { activeDynamicViewKey, applyDynamicView, dynamicViews } from '../../store/appStore'

/**
 * 侧栏「动态视图」板块（OPT-01 自 Sidebar.vue 按域拆出）：
 * FN-07 内置规则随模型实时求值（未评分/近 30 天/长期未更新），
 * 点击应用对应筛选组合。
 */
</script>

<template>
  <div class="side-section views-section">
    <h3>动态视图</h3>
    <ul class="view-list dynamic-view-list">
      <li v-for="v in dynamicViews" :key="v.key">
        <button
          class="view-item"
          :class="{ active: v.key === activeDynamicViewKey }"
          :title="`${v.title}（${v.count} 个，点击应用）`"
          @click="applyDynamicView(v.key)"
        >
          <span class="view-name">{{ v.label }}</span>
          <span class="view-count">{{ v.count }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.view-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 8px;
}

.dynamic-view-list {
  margin-bottom: 4px;
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

/* 当前命中的动态视图：与分类选中态一致的强调光条 */
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

/* 动态视图实时计数 */
.view-count {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

/* 窄屏图标栏（OPT-1）：与 Sidebar.vue 的 960px 断点联动，整块隐藏 */
@media (max-width: 960px) {
  .views-section {
    display: none;
  }
}
</style>
