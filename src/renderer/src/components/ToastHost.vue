<script setup>
import { dismissToast, state } from '../store/appStore'
</script>

<template>
  <Teleport to="body">
    <!-- role+aria-live：读屏器可感知通知（U6） -->
    <div class="toast-host" role="status" aria-live="polite">
      <TransitionGroup name="toast">
        <div
          v-for="t in state.toasts"
          :key="t.id"
          class="toast"
          :class="`toast-${t.type}`"
        >
          <span class="toast-icon" aria-hidden="true">
            <svg v-if="t.type === 'success'" viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.8" /></svg>
            <svg v-else-if="t.type === 'error'" viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
            <svg v-else-if="t.type === 'warn'" viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 4v5.5" /><path d="M8 12.6v.2" /></svg>
            <svg v-else viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M8 7v4.5" /><path d="M8 4.1v.2" /></svg>
          </span>
          <span>{{ t.text }}</span>
          <button class="toast-close" title="关闭" aria-label="关闭通知" @click="dismissToast(t.id)">
            <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-host {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  z-index: var(--z-toast);
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 玻璃 Toast：磨砂浮层 */
  background: var(--glass-bg-strong);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  padding: 12px 16px;
  font-size: var(--font-sm);
  box-shadow: var(--shadow-sm);
  max-width: 70vw;
  /* host 容器为 pointer-events:none 防挡点击，toast 自身恢复以支持关闭按钮（U6） */
  pointer-events: auto;
}

.toast-close {
  border: none;
  background: transparent;
  color: var(--text-muted);
  line-height: 1;
  padding: 2px 4px;
  margin-left: 4px;
  cursor: pointer;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
}

.toast-close:hover {
  color: var(--text);
}

.toast-icon {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
  color: var(--on-bright);
}

.toast-success .toast-icon { background: var(--success); }
.toast-error .toast-icon { background: var(--danger); color: #fff; }
.toast-warn .toast-icon { background: var(--warning-soft); }
.toast-info .toast-icon { background: var(--accent); color: #fff; }

.toast-enter-active,
.toast-leave-active {
  transition: all var(--dur-base) var(--ease-out);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(12px);
}
</style>
