<script setup>
import { onMounted, onUnmounted } from 'vue'
import TopBar from './components/TopBar.vue'
import Sidebar from './components/Sidebar.vue'
import ModelCard from './components/ModelCard.vue'
import ModelDetail from './components/ModelDetail.vue'
import ToastHost from './components/ToastHost.vue'
import {
  filteredModels,
  initApp,
  state,
  typeInfo,
  chooseFolder
} from './store/appStore'

let unsubscribeProgress = null

onMounted(async () => {
  // 订阅扫描进度事件
  unsubscribeProgress = window.api.models.onScanProgress((progress) => {
    state.progress = progress
  })
  await initApp()
})

onUnmounted(() => {
  unsubscribeProgress?.()
})
</script>

<template>
  <div class="layout">
    <TopBar />

    <div class="main-area">
      <Sidebar />

      <main class="content">
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
        </div>

        <!-- 空结果 -->
        <div v-else-if="filteredModels.length === 0" class="empty-state">
          <div class="empty-icon">🔍</div>
          <h2>没有匹配的模型</h2>
          <p class="muted">
            {{
              state.models.length === 0
                ? '当前文件夹中未发现支持的模型文件（.safetensors / .ckpt / .pt / .pth / .bin），可尝试点击顶栏「重新扫描」。'
                : '当前筛选或搜索条件下没有模型，试试切换分类或清空搜索词。'
            }}
          </p>
        </div>

        <!-- 模型网格 -->
        <template v-else>
          <div class="result-bar">
            <span class="muted">共 {{ filteredModels.length }} 个模型</span>
            <span v-if="state.typeFilter !== 'all'" class="chip">
              {{ typeInfo(state.typeFilter).label }}
            </span>
          </div>
          <div class="model-grid">
            <ModelCard v-for="m in filteredModels" :key="m.id" :model="m" />
          </div>
        </template>
      </main>
    </div>

    <footer class="footer">
      <span>模匣 · 本地 AI 绘画模型管理</span>
      <span v-if="state.folder" class="footer-path" :title="state.folder">{{ state.folder }}</span>
      <span>Ctrl+Shift+I 开发者工具</span>
    </footer>

    <ModelDetail />
    <ToastHost />
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
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  align-content: start;
}

.result-bar {
  display: flex;
  align-items: center;
  gap: 10px;
}

.chip {
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--bg-active);
  color: var(--accent);
}

.model-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 14px;
  align-content: start;
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
  font-family: Consolas, monospace;
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

.footer-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 45vw;
  font-family: Consolas, monospace;
}
</style>
