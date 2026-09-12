import { createApp } from 'vue'
import App from './App.vue'
import './assets/styles/main.css'

const app = createApp(App)

/**
 * 全局错误兜底：捕获渲染进程异常并上报主进程日志，
 * 形成与主进程一致的完整错误链路，便于排查用户现场问题。
 * 上报本身失败时仅降级到控制台，避免错误处理引发死循环。
 */
function reportError(message, stack) {
  try {
    window.api.app.reportError(message, stack)?.catch(() => {})
  } catch {
    console.error('错误上报失败:', message)
  }
}

app.config.errorHandler = (err) => {
  console.error(err)
  reportError(String(err?.message || err), err?.stack)
}

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  console.error('未处理的 Promise 拒绝:', reason)
  reportError(
    reason instanceof Error ? String(reason.message) : String(reason ?? '未知的 Promise 拒绝'),
    reason instanceof Error ? reason.stack : ''
  )
})

app.mount('#app')
