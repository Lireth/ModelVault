import { defineConfig } from 'vitest/config'

// 单元测试配置：仅覆盖主进程纯逻辑（扫描分类/元数据存储），
// Electron API 经 tests/setup.js 统一 mock，无需启动 Electron 运行时
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    setupFiles: ['./tests/setup.js']
  }
})
