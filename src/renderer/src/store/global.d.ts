/**
 * 渲染层全局类型声明（O10 类型检查覆盖扩展）：
 * - *.vue / *.css 模块占位（.vue 模板不在 checkJs 范围，由组件测试覆盖）
 * - window.api 的类型由同目录 api.d.ts 声明（OPT-08：结构性派生自
 *   preload 实现的单一来源，方法增删即同步反映到调用点类型检查）
 */
declare module '*.vue' {
  const component: any
  export default component
}

declare module '*.css'
