/**
 * 渲染进程错误上报链路（OPT-10）：
 * 统一收敛四类来源，经 app:reportError 通道写入主进程日志——
 * - vueError：Vue errorHandler（组件渲染/生命周期/侦听器错误，含上下文 info）；
 * - windowError：窗口 error 事件（app.errorHandler 覆盖不到的 mount 前同步
 *   错误、事件处理器未捕获错误，以及 img/script 等资源加载失败）；
 * - rejection：未处理的 Promise 拒绝；
 * - vueWarn：Vue warnHandler（重复 key、prop 类型错误等运行时警告）。
 *
 * 设计要点：
 * - 同类错误节流（堆栈/消息首行归类，1s 间隔）：错误风暴时同一问题至多
 *   一条进主进程日志，避免打爆按天分文件的日志；
 * - 上报失败仅降级控制台，不向业务调用方抛出，避免错误处理引发死循环；
 * - 与 window/document 解耦（不直接引用），可在 node 环境单测。
 */

/** 同类错误上报的最小间隔（ms） */
const REPORT_THROTTLE_MS = 1000

/** 节流表容量上限：错误签名种类异常增多时按插入顺序淘汰最旧条目 */
const THROTTLE_MAP_MAX = 100

/**
 * 创建错误上报器。
 * @param {{report: (message: string, stack: string) => unknown}} api 上报通道封装
 *   （main.js 传入 window.api.app.reportError；测试传入收集器）
 * @returns {{
 *   vueError: (err: unknown, instance: unknown, info: string) => void,
 *   windowError: (event: {target?: unknown, message?: string, error?: unknown, filename?: string, lineno?: number, colno?: number}) => void,
 *   rejection: (reason: unknown) => void,
 *   vueWarn: (msg: string, instance: unknown, trace: string) => void
 * }} 四类来源的处理函数
 */
export function createErrorReporter(api) {
  /** 错误签名 → 上次上报时间戳 */
  const lastReportAt = new Map()

  /** 归类签名：堆栈首行（无堆栈取消息）前 80 字符——同一处反复触发归为同类 */
  function signature(category, message, stack) {
    const head = String(stack || message || '').split('\n')[0] || ''
    return `${category}|${head.slice(0, 80)}`
  }

  /** 节流上报：同类错误间隔内仅首条出账；上报异常降级控制台 */
  function report(category, message, stack) {
    const key = signature(category, message, stack)
    const now = Date.now()
    if (now - (lastReportAt.get(key) || 0) < REPORT_THROTTLE_MS) return
    lastReportAt.set(key, now)
    if (lastReportAt.size > THROTTLE_MAP_MAX) {
      lastReportAt.delete(lastReportAt.keys().next().value)
    }
    try {
      api.report(`[${category}] ${message}`, stack || '')
    } catch {
      console.error('错误上报失败:', message)
    }
  }

  return {
    /** Vue errorHandler：附加上下文 info（组件名/生命周期阶段）提升定位价值 */
    vueError(err, _instance, info) {
      console.error(err)
      const base = String(err?.message || err)
      report('vue', info ? `${base}（上下文: ${info}）` : base, err?.stack)
    },

    /**
     * 窗口 error 事件（须以捕获阶段监听：资源加载错误不冒泡）。
     * target 带 tagName 的是资源加载失败（img/script/link），
     * 否则为未捕获的脚本/运行时错误。
     */
    windowError(event) {
      const node = event?.target
      if (node && node.tagName) {
        const src = node.src || node.href || ''
        report('resource', `资源加载失败 <${String(node.tagName).toLowerCase()}> ${src || '(未知地址)'}`, '')
        return
      }
      const err = event?.error
      const stack =
        err?.stack ||
        (event?.filename ? `at ${event.filename}:${event.lineno}:${event.colno}` : '')
      report('window', event?.message || String(err?.message || '未知的窗口错误'), stack)
    },

    /** 未处理的 Promise 拒绝：兼容 Error 与非 Error 原因 */
    rejection(reason) {
      console.error('未处理的 Promise 拒绝:', reason)
      const isError = reason instanceof Error
      report(
        'promise',
        isError ? String(reason.message) : String(reason ?? '未知的 Promise 拒绝'),
        isError ? reason.stack : ''
      )
    },

    /** Vue warnHandler：运行时警告（生产构建下 Vue 默认剥离，仅开发期可见） */
    vueWarn(msg, _instance, trace) {
      console.warn('[Vue warn]', msg, trace || '')
      report('vue-warn', String(msg), trace || '')
    }
  }
}
