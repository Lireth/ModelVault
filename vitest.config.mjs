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
    setupFiles: ['./tests/setup.js'],
    // D8：setup.js 已改为每测试文件独立 fakeUserData（mkdtemp + 自动清理），
    // 跨文件磁盘竞态消除，文件级并行恢复默认开启
    // O4：不配置 retry（原 retry:1 会把偶发时序缺陷掩盖成「通过」）。
    // 时序类用例（appShortcuts 等）已通过 beforeEach 状态复位与 booting
    // 轮询消除抖动；再出现偶发失败应作为缺陷定位修复，而非靠重试放行。
    retry: 0,
    coverage: {
      // 覆盖率门禁（防退化下限，非质量目标）：2026-11-04 测试精简（移除基础
      // 设施与外围功能测试 26 个，保留扫描入库/元数据/筛选搜索/封面/Civitai/
      // 备份/多选/虚拟滚动等核心域）后实测基线为 Stmts 82.01 / Branch 75.64 /
      // Funcs 79.15 / Lines 84.42，门禁取基线下浮 ~10pt（72/65/69/74），
      // 仅拦截「整块测试被误删或大面积失效」的灾难性退化，不为凑数字补测。
      // 按全局总量判定（perFile=false），不设 per-file 地板（原 15 组数据
      // 关键服务/UI 地板随精简一并移除，降低维护成本）；纯 re-export 门面
      // 仍排除（见 exclude），避免以 0% 逻辑稀释全局均值。
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        // 纯 re-export 门面（C2/A-04 拆分保持导入路径的聚合入口，无逻辑）：
        // 计入门面只会以 0% 稀释基线，逻辑在子模块中计量
        'src/main/services/store.js',
        'src/main/services/backup.js',
        'src/renderer/src/store/appStore.js',
        'src/renderer/src/store/multiselect.js',
      ],
      thresholds: {
        statements: 72,
        branches: 65,
        functions: 69,
        lines: 74,
        perFile: false,
      },
    },
  },
})
