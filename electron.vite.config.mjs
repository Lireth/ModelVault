import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

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
    plugins: [vue()],
    server: {
      port: 5173,
      strictPort: true
    }
  }
})
