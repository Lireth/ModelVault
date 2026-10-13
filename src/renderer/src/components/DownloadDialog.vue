<script setup>
import { ref } from 'vue'
import {
  cancelDownload,
  closeDownloadDialog,
  confirmDownload,
  formatSize,
  resolveDownloadLink,
  state
} from '../store/appStore'

/**
 * Civitai 下载弹层（F14）：粘贴模型页链接 → 版本预览（名称/大小/NSFW/
 * 触发词/官方哈希）→ 确认后流式下载到当前库根，进度实时显示。
 * 完成后 watcher 自动发现新文件入库；元数据（触发词/NSFW/哈希）已由
 * 主进程在下载成功时预写。
 */

const urlInput = ref('')

/** 解析链接为版本预览（store 函数处理状态与错误提示） */
async function onResolve() {
  const url = urlInput.value.trim()
  if (!url) return
  state.downloadDialog.url = url
  await resolveDownloadLink(url)
}

/** 确认下载（store 函数负责进度与完成提示） */
async function onDownload() {
  await confirmDownload()
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="state.downloadDialog.visible"
      class="download-overlay"
      @click.self="closeDownloadDialog"
    >
      <div class="download-dialog" role="dialog" aria-modal="true" aria-label="下载 Civitai 模型">
        <header class="download-head">
          <h3>从 Civitai 下载模型</h3>
          <button class="wc-btn" title="关闭" @click="closeDownloadDialog">✕</button>
        </header>

        <template v-if="!state.downloading">
          <!-- 第一步：粘贴链接 -->
          <div class="download-step">
            <label class="download-label" for="civitai-url">模型页链接</label>
            <div class="url-row">
              <input
                id="civitai-url"
                v-model="urlInput"
                type="text"
                placeholder="https://civitai.com/models/123456?modelVersionId=789"
                spellcheck="false"
                @keydown.enter.prevent="onResolve"
              />
              <button class="btn" :disabled="state.downloadDialog.resolving || !urlInput.trim()" @click="onResolve">
                {{ state.downloadDialog.resolving ? '解析中…' : '解析' }}
              </button>
            </div>
            <p class="download-hint">
              支持 civitai.com/models/… 页面链接（链接中需包含版本号）。NSFW 模型下载须在设置页配置 API Token。
            </p>
          </div>

          <!-- 第二步：版本预览 -->
          <div v-if="state.downloadDialog.version" class="version-preview">
            <dl class="version-list">
              <template v-if="state.downloadDialog.version.name">
                <dt>版本</dt>
                <dd>{{ state.downloadDialog.version.name }}</dd>
              </template>
              <dt>文件</dt>
              <dd class="mono">{{ state.downloadDialog.version.filename }}</dd>
              <dt>大小</dt>
              <dd>{{ formatSize(state.downloadDialog.version.sizeBytes) }}</dd>
              <dt>基底</dt>
              <dd>{{ state.downloadDialog.version.baseModel || '未知' }}</dd>
              <template v-if="state.downloadDialog.version.trainedWords?.length">
                <dt>触发词</dt>
                <dd class="mono">{{ state.downloadDialog.version.trainedWords.join(', ') }}</dd>
              </template>
            </dl>
            <div class="preview-actions">
              <button class="btn btn-primary" @click="onDownload">下载到当前模型库</button>
            </div>
          </div>
          <p v-else-if="state.downloadDialog.error" class="download-error">{{ state.downloadDialog.error }}</p>
        </template>

        <!-- 第三步：下载进度 -->
        <template v-else>
          <div class="download-progress">
            <div class="progress-bar">
              <div
                class="progress-fill"
                :style="{ width: state.downloadProgress.total > 0
                  ? `${Math.min(100, Math.round((state.downloadProgress.received / state.downloadProgress.total) * 100))}%`
                  : '0%' }"
              ></div>
            </div>
            <p class="progress-text">
              {{ formatSize(state.downloadProgress.received) }}
              {{ state.downloadProgress.total > 0 ? ` / ${formatSize(state.downloadProgress.total)}` : '（未知大小）' }}
            </p>
            <button class="btn" @click="cancelDownload">取消下载</button>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.download-overlay {
  position: fixed;
  top: var(--titlebar-height);
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-confirm);
}

.download-dialog {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px 22px;
  width: min(520px, 92vw);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}

.download-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.download-head h3 {
  font-size: 14px;
  color: var(--accent);
}

.download-step {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.download-label {
  font-size: 12px;
  color: var(--text-muted);
}

.url-row {
  display: flex;
  gap: 8px;
}

.url-row input {
  flex: 1;
  min-width: 0;
}

.download-hint {
  font-size: 11px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.6;
}

.version-preview {
  margin-top: 14px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}

.version-list {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 14px;
  font-size: 12px;
  margin: 0 0 12px;
}

.version-list dt {
  color: var(--text-muted);
}

.version-list dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.mono {
  font-family: var(--font-mono);
}

.download-error {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--danger);
}

.preview-actions {
  display: flex;
  justify-content: flex-end;
}

.download-progress {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: stretch;
}

.progress-bar {
  height: 8px;
  border-radius: 4px;
  background: var(--bg-hover);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: 4px;
  background: var(--accent);
  transition: width 0.25s ease;
}

.progress-text {
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
  margin: 0;
  font-variant-numeric: tabular-nums;
}
</style>
