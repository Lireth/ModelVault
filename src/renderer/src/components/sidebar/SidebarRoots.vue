<script setup>
import { computed } from 'vue'
import { removeRoot, state, switchRoot } from '../../store/appStore'

/**
 * 侧栏「模型库」板块（OPT-01 自 Sidebar.vue 按域拆出）：
 * E7 多根目录切换——剔除当前激活库后列出其他库，点击切换；
 * 失效库条目（F1-offline）灰显 + 警示点，点击仍可切换进入离线态。
 */

/** 模型库列表（E7 多根目录）：剔除当前激活库后仍存在的其他库 */
const otherRoots = computed(() =>
  (state.settings.modelsFolders || []).filter(
    (f) => f.toLowerCase() !== state.folder.toLowerCase()
  )
)

/** 库显示名：取路径末段 */
function rootName(f) {
  const parts = f.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || f
}

/**
 * 失效库标记（F1-offline）：missingRoots 为小写路径清单（启动时 loadStore
 * 回填，切换/扫描联动增删）；失效条目灰显 + 警示点，点击仍可切换——
 * 切换后进入离线态，语义自洽
 */
function isRootMissing(f) {
  return state.missingRoots.includes(f.toLowerCase())
}
</script>

<template>
  <div v-if="otherRoots.length" class="side-section">
    <h3>模型库</h3>
    <ul class="root-list">
      <li v-for="f in otherRoots" :key="f">
        <button
          class="root-item"
          :class="{ 'root-offline': isRootMissing(f) }"
          :title="isRootMissing(f) ? `${f}（文件夹不可用——点击切换后可重新定位）` : `${f}（点击切换）`"
          @click="switchRoot(f)"
        >
          <span class="root-dot" :class="{ 'root-dot-offline': isRootMissing(f) }"></span>
          <span class="root-name">{{ rootName(f) }}</span>
          <span
            class="root-remove"
            role="button"
            tabindex="0"
            title="从模型库列表移除（磁盘数据不受影响）"
            :aria-label="`将模型库 ${rootName(f)} 从列表移除`"
            @click.stop="removeRoot(f)"
            @keydown.enter.stop.prevent="removeRoot(f)"
            @keydown.space.stop.prevent="removeRoot(f)"
          >✕</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.root-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.root-item {
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
}

.root-item:hover {
  background: var(--bg-hover);
}

.root-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1.5px solid var(--text-muted);
  flex-shrink: 0;
}

.root-item:hover .root-dot {
  border-color: var(--accent);
}

/* 失效库条目（F1-offline）：名称灰显 + 警示点（金色填充）；
   双类提升优先级，防止 .root-item:hover .root-dot 规则盖掉警示色 */
.root-item.root-offline .root-name {
  color: var(--text-muted);
}

.root-item .root-dot.root-dot-offline,
.root-item:hover .root-dot.root-dot-offline {
  border-color: var(--favorite);
  background: color-mix(in srgb, var(--favorite) 40%, transparent);
}

.root-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.root-remove {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 10px;
  cursor: pointer;
  /* 键盘可达（OPT-2）：以透明度替代 display:none——后者会移出 Tab 序列；
     隐藏态同时屏蔽指针事件，保持既有点击语义（隐藏时点击该区域仍作用于
     父级「切换模型库」按钮）；悬停或键盘聚焦（:focus-visible）时显现并可交互 */
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--dur-fast) var(--ease-out);
}

.root-item:hover .root-remove,
.root-remove:focus-visible {
  opacity: 1;
  pointer-events: auto;
}

.root-remove:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.root-remove:hover {
  background: var(--danger);
  color: #fff;
}

/* 窄屏图标栏（OPT-1）：与 Sidebar.vue 的 960px 断点联动——
   隐藏板块标题，库条目保留（与原行为一致） */
@media (max-width: 960px) {
  .side-section h3 {
    display: none;
  }
}
</style>
