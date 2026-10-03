import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { applyProductionCsp } from './scripts/csp.mjs'

/**
 * 渲染进程 CSP 构建期改写（B4）：
 * dev 服务器保留源码 CSP（style-src 含 unsafe-inline，供 HMR 的
 * <style> 注入）；生产构建将 CSS 抽为 <link> 外链，移除内联许可。
 */
const rendererCspPlugin = {
  name: 'modelvault:renderer-csp',
  enforce: 'post',
  transformIndexHtml(html, ctx) {
    return ctx.server ? html : applyProductionCsp(html)
  }
}

export default defineConfig({
  // 主进程：外部化所有依赖，仅打包业务代码
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  // 预加载脚本
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  // 渲染进程：集成 Vue 3，支持 HMR 热重载
  renderer: {
    plugins: [vue(), rendererCspPlugin],
    server: {
      port: 5173,
      strictPort: true
    }
  }
})
