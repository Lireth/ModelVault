<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import {
  closeTransfer,
  confirmTransfer,
  targetDisplayName,
  transferState,
  transferTargets
} from '../store/appStore'

/**
 * 跨库传输选择层（F-3）：从已保存库列表（去掉当前库）中选择目标库并确认
 * 复制/移动模式。覆盖区不含标题栏（保持窗口控制可达）；键盘支持：
 * ESC=取消 / Enter=确认（列表选择时 Enter 由列表项处理）/ Tab 焦点循环。
 */

const selectedTarget = ref('')
const confirmBtn = ref(null)
const cancelBtn = ref(null)

const idsCount = computed(() => transferState.ids.length)
const canConfirm = computed(() => Boolean(selectedTarget.value) && !transferState.busy)

watch(
  () => transferState.visible,
  async (visible) => {
    if (visible) {
      // 每次打开重置选择（上次的选择不残留）
      selectedTarget.value = ''
      await nextTick()
      cancelBtn.value?.focus()
    }
  }
)

function onKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    closeTransfer()
  } else if (e.key === 'Enter' && e.target?.tagName !== 'BUTTON') {
    e.preventDefault()
    e.stopPropagation()
    if (canConfirm.value) confirmTransfer(selectedTarget.value)
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="transferState.visible"
      class="transfer-overlay"
      @click.self="closeTransfer"
      @keydown="onKeydown"
    >
      <div class="transfer-dialog" role="dialog" aria-modal="true" aria-label="跨库传输">
        <p class="transfer-title">
          {{ transferState.mode === 'move' ? '移动' : '复制' }} {{ idsCount }} 个模型到其他库
        </p>
        <p class="transfer-desc">
          保持库内相对路径与标注（评分/收藏/标签/封面）一并迁移；目标库已有同名文件时跳过不覆盖。
          <template v-if="transferState.mode === 'move'">移动完成后源文件将被删除。</template>
        </p>

        <ul class="transfer-list" role="listbox" aria-label="选择目标模型库">
          <li v-for="folder in transferTargets" :key="folder">
            <button
              class="transfer-item"
              role="option"
              :aria-selected="selectedTarget === folder"
              :class="{ selected: selectedTarget === folder }"
              :title="folder"
              @click="selectedTarget = folder"
              @keydown.enter.prevent="confirmTransfer(folder)"
            >
              {{ targetDisplayName(folder) }}
            </button>
          </li>
        </ul>

        <div class="transfer-mode" role="radiogroup" aria-label="传输模式">
          <label class="transfer-mode-item">
            <input v-model="transferState.mode" type="radio" value="copy" />
            <span>复制（保留当前库）</span>
          </label>
          <label class="transfer-mode-item">
            <input v-model="transferState.mode" type="radio" value="move" />
            <span>移动（当前库删除）</span>
          </label>
        </div>

        <div class="transfer-actions">
          <button ref="cancelBtn" class="btn" :disabled="transferState.busy" @click="closeTransfer">
            取消
          </button>
          <button
            ref="confirmBtn"
            class="btn btn-primary"
            :disabled="!canConfirm"
            @click="confirmTransfer(selectedTarget)"
          >
            {{ transferState.busy ? '传输中…' : transferState.mode === 'move' ? '移动' : '复制' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.transfer-overlay {
  position: fixed;
  /* 标题栏以下（保持窗口控制按钮可达，与 ConfirmOverlay 一致） */
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

.transfer-dialog {
  background: var(--glass-bg-strong);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  padding: 20px 24px;
  width: min(420px, calc(100vw - 48px));
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: var(--shadow-lg);
}

.transfer-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.transfer-desc {
  margin: 0;
  font-size: var(--font-xs);
  line-height: 1.6;
  color: var(--text-muted);
}

.transfer-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 40px;
}

.transfer-item {
  width: 100%;
  text-align: left;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--glass-border);
  background: color-mix(in srgb, var(--bg-card) 60%, transparent);
  font-size: var(--font-xs);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.transfer-item:hover {
  border-color: var(--accent);
}

.transfer-item.selected {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 18%, var(--bg-card));
  font-weight: 600;
}

.transfer-mode {
  display: flex;
  gap: 16px;
}

.transfer-mode-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-xs);
  cursor: pointer;
  user-select: none;
}

.transfer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
