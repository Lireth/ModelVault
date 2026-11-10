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
      // 覆盖率门禁（防退化下限，非质量目标），口径：实测基线下浮 ~10pt，
      // 仅拦截「整块测试被误删或大面积失效」的灾难性退化，不为凑数字补测。
      // 棘轮记录（基线上移时按同一口径随之上调，本注释为单一来源）：
      // - 2026-11-04 测试精简（移除基础设施与外围功能测试 26 个，保留扫描
      //   入库/元数据/筛选搜索/封面/Civitai/备份/多选/虚拟滚动等核心域）后
      //   基线 Stmts 82.01 / Branch 75.64 / Funcs 79.15 / Lines 84.42，
      //   门禁 72/65/69/74；per-file 地板（原 15 组）随精简一并移除。
      // - 2026-11-05 O-1 数据完整性关键路径补测（跨库迁移/标签管理/Civitai
      //   缓存/模型对比/跨库传输浮层/设置页标签面板，+84 用例）后基线上移至
      //   Stmts 85.29 / Branch 78.77 / Funcs 82.89 / Lines 87.81，
      //   门禁随棘轮上调至 75/68/72/77。
      // 按全局总量判定（perFile=false）；纯 re-export 门面仍排除（见
      // exclude），避免以 0% 逻辑稀释全局均值（拆分产生的无逻辑聚合门面同理）。
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        // 纯 re-export 门面（C2/A-04 拆分保持导入路径的聚合入口，无逻辑）：
        // 计入门面只会以 0% 稀释基线，逻辑在子模块中计量
        'src/main/services/store.js',
        'src/main/services/backup.js',
        'src/renderer/src/store/appStore.js',
        'src/renderer/src/store/multiselect.js',
        // 测试脚手架（挂载/IPC 装配助手）：非产品代码，计入分母无意义
        'tests/helpers/**',
      ],
      thresholds: {
        statements: 75,
        branches: 68,
        functions: 72,
        lines: 77,
        perFile: false,
      },
    },
  },
})
