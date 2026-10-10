import { createApp } from 'vue'
import App from './App.vue'
import { createErrorReporter } from './error-report'
import './assets/styles/main.css'

const app = createApp(App)

/**
 * 全局错误兜底（OPT-10）：四类来源统一经 app:reportError 上报主进程日志，
 * 形成与主进程一致的完整错误链路——
 * - Vue errorHandler（组件错误，附上下文 info）/ warnHandler（运行时警告）；
 * - 窗口 error 事件（捕获阶段：覆盖 mount 前同步错误与 img/script 资源加载失败，
 *   这两类不在 app.config.errorHandler 范围内）；
 * - 未处理的 Promise 拒绝。
 * 同类错误由 error-report 内部节流降噪；上报失败仅降级控制台，
 * 避免错误处理引发死循环。
 */
const reporter = createErrorReporter({
  report: (message, stack) => window.api.app.reportError(message, stack)?.catch(() => {})
})

app.config.errorHandler = reporter.vueError
app.config.warnHandler = reporter.vueWarn

// 捕获阶段监听：资源加载错误不冒泡，仅捕获路径可达 window
window.addEventListener('error', reporter.windowError, true)

window.addEventListener('unhandledrejection', (event) => {
  reporter.rejection(event.reason)
})

app.mount('#app')
