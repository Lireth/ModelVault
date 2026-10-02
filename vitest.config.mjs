import { defineConfig } from 'vitest/config'

// 单元测试配置：仅覆盖主进程纯逻辑（扫描分类/元数据存储），
// Electron API 经 tests/setup.js 统一 mock，无需启动 Electron 运行时
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    setupFiles: ['./tests/setup.js'],
    // 测试文件共享 fakeUserData 磁盘目录（settings.json/legacy store.json），
    // 并行运行会跨文件竞态读写；单文件本身亚秒级，串行总成本可忽略
    fileParallelism: false
  }
})
