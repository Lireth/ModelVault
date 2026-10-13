<script setup>
import { nextTick, ref, watch } from 'vue'
import { acceptConfirm, rejectConfirm, state } from '../store/appStore'

/**
 * 自定义确认层（U4，O9 自 App.vue 拆出）：替代阻塞且脱离主题的
 * window.confirm。覆盖区不包含标题栏（保持窗口控制可达）。
 * 键盘支持（A8）：ESC=取消 / Enter=确认 / Tab 两按钮间焦点陷阱；
 * 打开时焦点移入「取消」按钮（安全默认）——此前焦点留在触发按钮上，
 * Enter 会再次触发原操作而非确认。
 */

const confirmCancelBtn = ref(null)
const confirmOkBtn = ref(null)

/** 确认层键盘交互：焦点在按钮上时 Enter 由按钮原生处理。
 *  stopPropagation（F1）：确认层打开期间键盘事件由本层独占消费，
 *  否则事件继续冒泡到 window，触发详情页/设置页的 ESC 处理器，
 *  脏表单时 closeDetail/onCancel 会把确认层再次弹出，ESC 无法取消 */
function onConfirmKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    rejectConfirm()
  } else if (e.key === 'Tab') {
    e.preventDefault()
    e.stopPropagation()
    ;(e.shiftKey ? confirmOkBtn.value : confirmCancelBtn.value)?.focus()
  } else if (e.key === 'Enter' && e.target?.tagName !== 'BUTTON') {
    e.preventDefault()
    e.stopPropagation()
    acceptConfirm()
  }
}

watch(
  () => state.confirm.visible,
  async (visible) => {
    if (visible) {
      await nextTick()
      confirmCancelBtn.value?.focus()
    }
  }
)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="state.confirm.visible"
      class="confirm-overlay"
      @click.self="rejectConfirm"
      @keydown="onConfirmKeydown"
    >
      <div class="confirm-dialog" role="dialog" aria-modal="true" aria-label="操作确认">
        <p class="confirm-text">{{ state.confirm.text }}</p>
        <div class="confirm-actions">
          <button ref="confirmCancelBtn" class="btn" @click="rejectConfirm">取消</button>
          <button ref="confirmOkBtn" class="btn btn-primary confirm-ok" @click="acceptConfirm">确定</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.confirm-overlay {
  position: fixed;
  /* 标题栏以下（保持窗口控制按钮可达，U4）：40px 需与 --titlebar-height 一致 */
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

.confirm-dialog {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px 24px;
  min-width: 320px;
  max-width: 480px;
  box-shadow: var(--shadow-md);
}

.confirm-text {
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}
</style>
