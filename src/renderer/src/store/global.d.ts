/**
 * 渲染层全局类型声明（O10 类型检查覆盖扩展）：
 * preload 经 contextBridge 暴露的 window.api 结构由 src/preload/index.js 定义。
 * 此处以 any 承接（IPC 入参由主进程 schema 与 preload 白名单双重校验），
 * 让 store 层在 checkJs 下可被类型检查覆盖，而不必在每次调用点做断言。
 */
interface Window {
  api: any
}

declare module '*.vue' {
  const component: any
  export default component
}

declare module '*.css'
