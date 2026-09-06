<script setup>
import { state } from '../store/appStore'
</script>

<template>
  <Teleport to="body">
    <div class="toast-host">
      <TransitionGroup name="toast">
        <div
          v-for="t in state.toasts"
          :key="t.id"
          class="toast"
          :class="`toast-${t.type}`"
        >
          <span class="toast-icon">
            {{ t.type === 'success' ? '✓' : t.type === 'error' ? '✕' : t.type === 'warn' ? '!' : 'ℹ' }}
          </span>
          <span>{{ t.text }}</span>
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
  z-index: 200;
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 16px;
  font-size: 13px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  max-width: 70vw;
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
  color: #10141a;
}

.toast-success .toast-icon { background: #3ddc97; }
.toast-error .toast-icon { background: var(--danger); color: #fff; }
.toast-warn .toast-icon { background: #ffb86b; }
.toast-info .toast-icon { background: var(--accent); color: #fff; }

.toast-enter-active,
.toast-leave-active {
  transition: all 0.25s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(12px);
}
</style>
