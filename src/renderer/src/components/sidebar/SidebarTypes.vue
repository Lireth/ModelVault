<script setup>
import { MODEL_TYPES, state, typeCounts } from '../../store/appStore'

/**
 * 侧栏「分类」板块（OPT-01 自 Sidebar.vue 按域拆出）：
 * 全部 + 五大模型类型的一键筛选与实时计数。
 */

function selectType(key) {
  state.typeFilter = key
}
</script>

<template>
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
</template>

<style scoped>
.type-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
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

/* 窄屏图标栏（OPT-1）：与 Sidebar.vue 的 960px 断点联动——
   隐藏标题/名称/计数，仅保留色点居中排列 */
@media (max-width: 960px) {
  .side-section h3,
  .type-label,
  .type-count {
    display: none;
  }
  .type-item {
    justify-content: center;
    padding: 9px 0;
  }
}
</style>
