<script setup>
import { SEARCH_SYNTAX } from '../store/search-syntax'

/**
 * 搜索语法辅助展示层（FEAT-1，O-2 自 LibraryToolbar.vue 拆出）：
 * 「?」帮助面板（操作符目录，示例点击插入）与输入自动补全候选列表
 * （前缀/值两级，方向键选择、Enter 应用、Esc 关闭）。
 * 纯展示组件：状态（面板开关/候选/高亮下标）与输入框事件由父组件
 * LibraryToolbar 持有并经 props 下发，交互经事件回传——搜索框容器定位、
 * 输入联动与焦点管理保持在父组件。DOM 类名与拆分前一致。
 */

defineProps({
  /** 「?」帮助面板可见性 */
  helpOpen: { type: Boolean, default: false },
  /** 当前补全建议（suggestSearchSyntax 结果；null 表示无候选） */
  suggestion: { type: Object, default: null },
  /** 键盘高亮的候选下标 */
  suggestionIndex: { type: Number, default: 0 },
})

defineEmits([
  /** 点击帮助面板中的示例（负载为语法条目） */
  'insert-example',
  /** 点击/确认应用当前高亮候选 */
  'apply-suggestion',
])
</script>

<template>
  <!-- 搜索语法帮助面板（FEAT-1）：目录单一来源 search-syntax.js，示例点击插入 -->
  <div
    v-if="helpOpen"
    class="search-help-panel"
    role="group"
    aria-label="结构化搜索语法帮助"
  >
    <div class="help-head">
      结构化语法（与筛选叠加，多条件 AND；点击示例插入搜索框）
    </div>
    <ul class="help-list">
      <li v-for="s in SEARCH_SYNTAX" :key="s.prefix" class="help-row">
        <button
          class="help-example"
          :title="`插入 ${s.example}`"
          @click="$emit('insert-example', s)"
        >
          {{ s.example }}
        </button>
        <span class="help-label">{{ s.label }}</span>
        <span class="help-desc">{{ s.desc }}</span>
      </li>
    </ul>
  </div>

  <!-- 输入自动补全（FEAT-1）：前缀/值两级候选，Enter 应用、Esc 关闭 -->
  <ul
    v-if="suggestion && suggestion.items.length"
    id="search-syntax-suggest"
    class="search-suggest"
    role="listbox"
    aria-label="搜索语法建议"
  >
    <li
      v-for="(item, i) in suggestion.items"
      :key="item.key"
      role="option"
      :aria-selected="i === suggestionIndex"
      :class="{ active: i === suggestionIndex }"
      @mousedown.prevent
      @click="$emit('apply-suggestion')"
    >
      <code>{{ item.insert }}</code>
      <span class="suggest-label">{{ item.label }}</span>
    </li>
  </ul>
</template>

<style scoped>
/* 语法帮助面板：玻璃浮层，覆盖在搜索框下方 */
.search-help-panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 60;
  width: max(100%, 440px);
  padding: 10px 12px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: var(--glass-bg-strong);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: var(--shadow-lg);
  font-size: var(--font-xs);
}

.help-head {
  margin-bottom: 8px;
  color: var(--text-muted);
}

.help-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.help-row {
  display: grid;
  grid-template-columns: auto auto 1fr;
  gap: 8px;
  align-items: baseline;
}

.help-example {
  justify-self: start;
  padding: 1px 6px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}

.help-example:hover {
  border-color: var(--accent);
  background: var(--bg-hover);
}

.help-label {
  color: var(--text);
  white-space: nowrap;
}

.help-desc {
  color: var(--text-muted);
  line-height: 1.5;
}

/* 输入自动补全候选（FEAT-1）：前缀/值两级，键盘上下选择 */
.search-suggest {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  z-index: 60;
  max-height: 260px;
  overflow-y: auto;
  margin: 0;
  padding: 4px;
  list-style: none;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: var(--glass-bg-strong);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: var(--shadow-lg);
  font-size: var(--font-xs);
}

.search-suggest li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.search-suggest li.active {
  background: var(--bg-hover);
}

.search-suggest code {
  color: var(--accent);
  font-family: var(--font-mono);
  white-space: nowrap;
}

.suggest-label {
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
