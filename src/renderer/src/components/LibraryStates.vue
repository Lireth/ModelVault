<script setup>
import { cancelScan, chooseFolder, scanModels, state } from '../store/appStore'

/**
 * 库视图启动与空态五分支（O-5 自 App.vue 拆出）：
 * 启动加载中（B8）→ 未选择文件夹 → 扫描中 → 扫描失败（B15）→ 空库，
 * 与拆分前同一 v-if/v-else-if 链序；链全部未命中（库中有模型）时渲染
 * 默认插槽（筛选 chips / 批量栏 / 网格与列表，由 App 提供），
 * 保证分支互斥语义与 DOM 顺序完全一致。
 */
</script>

<template>
  <!-- 启动加载中（B8）：异步恢复上次模型库的空窗期，已配置过文件夹的
       用户不闪现「开始使用」引导页 -->
  <div v-if="state.booting" class="empty-state">
    <div class="spinner"></div>
    <h2>正在启动…</h2>
  </div>

  <!-- 未选择文件夹 -->
  <div v-else-if="!state.folder && !state.scanning" class="empty-state">
    <div class="empty-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="52" height="52" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /></svg>
    </div>
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
    <div class="empty-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="52" height="52" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 21.5 20h-19z" /><path d="M12 10v4.5" /><circle cx="12" cy="17.4" r="0.4" fill="currentColor" stroke="none" /></svg>
    </div>
    <h2>扫描失败</h2>
    <p class="muted scan-error-detail">{{ state.scanError }}</p>
    <button class="btn btn-primary btn-large" @click="scanModels">重新扫描</button>
  </div>

  <!-- 库中无任何模型（未应用筛选时；保留结果栏逻辑见插槽内容，避免筛选状态死锁） -->
  <div v-else-if="state.models.length === 0" class="empty-state">
    <div class="empty-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="52" height="52" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.3 15.3 20.5 20.5" /></svg>
    </div>
    <h2>没有匹配的模型</h2>
    <p class="muted">
      当前文件夹中未发现支持的模型文件（.safetensors / .ckpt / .pt / .pth / .bin），可尝试点击侧边栏「重新扫描」。
    </p>
  </div>

  <!-- 库中有模型：渲染浏览区（插槽内容） -->
  <slot v-else />
</template>

<style scoped>
.scan-error-detail {
  max-width: 70%;
  word-break: break-all;
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

/* 加载环：极光双色（蓝 → 紫） */
.spinner {
  width: 34px;
  height: 34px;
  border: 3px solid color-mix(in srgb, var(--border) 70%, transparent);
  border-top-color: var(--accent);
  border-right-color: var(--accent-2);
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.btn-large {
  padding: 12px 22px;
  font-size: var(--font-md);
}
</style>
