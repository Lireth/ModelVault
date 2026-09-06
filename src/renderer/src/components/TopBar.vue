<script setup>
import { ref, watch } from 'vue'
import { state, chooseFolder, scanModels } from '../store/appStore'

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

function onScanClick() {
  if (!state.scanning) scanModels()
}
</script>

<template>
  <!-- 第一行：标题栏，整行可拖动移动窗口；右上角为原生窗口控件（WCO） -->
  <header class="titlebar">
    <div class="brand">
      <span class="brand-name">模匣</span>
      <span class="brand-en">ModelVault</span>
    </div>
  </header>

  <!-- 第二行：功能工具栏（不占用拖动区） -->
  <div class="toolbar-row">
    <div class="search-box" title="按模型名称搜索">
      <span class="search-icon">🔍</span>
      <input
        v-model="searchInput"
        type="text"
        placeholder="搜索模型名称…"
        spellcheck="false"
      />
      <button v-if="searchInput" class="search-clear" title="清空搜索" @click="clearSearch">✕</button>
    </div>

    <button class="btn" title="重新扫描当前模型文件夹" :disabled="state.scanning || !state.folder" @click="onScanClick">
      {{ state.scanning ? '扫描中…' : '重新扫描' }}
    </button>
    <button class="btn btn-primary" title="选择模型文件夹" @click="chooseFolder">选择文件夹</button>
  </div>
</template>

<style scoped>
.toolbar-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-card);
  flex-shrink: 0;
}

.toolbar-row .btn {
  flex-shrink: 0;
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

@media (max-width: 1100px) {
  .brand-en {
    display: none;
  }
}
</style>
