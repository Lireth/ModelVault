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
  // 主进程：外部化所有依赖，仅打包业务代码（fflate 除外——打进 bundle 后
  // electron-builder 可整个排除 node_modules，避免 asar 携带无用的依赖树）
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['fflate'] })],
    // E1：将发布签名者证书指纹注入主进程 bundle。CI 设置该环境变量后，
    // 更新下载/安装链路会强制 Authenticode 验签；本地/未签名构建为空串，
    // 退化为仅 SHA256 校验。
    define: {
      __MODELVAULT_SIGNER_THUMBPRINT__: JSON.stringify(
        process.env.MODELVAULT_SIGNER_THUMBPRINT || ''
      )
    }
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
    },
    // OP-01：框架运行时单独成 chunk，与业务代码分离，利于浏览器缓存与
    // 首屏并行解析；设置页/统计页经 defineAsyncComponent 自动形成按需 chunk。
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            vue: ['vue']
          }
        }
      }
    }
  }
})
