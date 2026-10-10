import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// 单元测试配置：
// - 主进程/preload/store 等纯逻辑默认运行于 node 环境；
// - 渲染层组件测试（tests/*.test.js 顶部 // @vitest-environment jsdom）依赖
//   vue 插件编译 SFC 与 jsdom 提供的 DOM；
// Electron API 经 tests/setup.js 统一 mock，无需启动 Electron 运行时
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    setupFiles: ['./tests/setup.js']
    // D8：setup.js 已改为每测试文件独立 fakeUserData（mkdtemp + 自动清理），
    // 跨文件磁盘竞态消除，文件级并行恢复默认开启
  }
})
