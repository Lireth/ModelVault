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
    // 失败重试 1 次（保险丝）：挂载真实 App 的 jsdom 时序类用例
    // （appShortcuts 等）在 CI 慢虚拟机/高并行下存在残余调度抖动，
    // 根因已在用例内修复（beforeEach 状态复位 + booting 轮询），此处
    // 仅兜底偶发；真回归重试仍会失败并阻断 CI
    retry: 1,
    coverage: {
      // A-14 覆盖率防退化门禁（O-3 棘轮渐进上调）：门禁 = 实际基线下浮 ~2pt，
      // 为环境波动留余量。棘轮历史：2026-10-20 Dependabot 升级（vue 3.5.44/
      // jsdom 30/electron 44/eslint 10）后基线回落，下调至 Stmts 78/Branch 70/
      // Funcs 76/Lines 80；O7 补强备份/Civitai IPC handler 与 civitai-store 测试
      // 并排除纯 re-export 门面（见 exclude）后基线回升至 Stmts 81.84/Branch
      // 74.32/Funcs 78.68/Lines 83.81，2026-10-21 棘轮上调；2026-10-23 因
      // windows CI（Node 22 覆盖率腿）波动，整体再下浮 1pt 至当前值。
      // 仅 npm run test:coverage 生效；按全局总量判定（perFile=false），
      // 不因个别低覆盖文件（如 mainWindow/menu 等薄胶水层）阻断 CI；
      // 数据完整性关键服务另设 per-file 地板（下方 glob 键，O7）。
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        // 纯 re-export 门面（C2/A-04 拆分保持导入路径的聚合入口，无逻辑）：
        // 计入门面只会以 0% 稀释基线，逻辑在子模块中计量
        'src/main/services/store.js',
        'src/renderer/src/store/appStore.js',
        'src/renderer/src/store/multiselect.js'
      ],
      thresholds: {
        statements: 80,
        branches: 73,
        functions: 77,
        lines: 82,
        perFile: false,
        // ---------- O7 per-file 地板（数据完整性关键服务，防薄胶水层稀释）
        // 地板 = 各文件实际基线下浮 ~4pt（2026-10-23 由 ~2pt 放宽）：windows CI
        // 的 Node 22 基准腿在 v8 覆盖率插桩与高并发下与本地存在 1~2pt 偏差，
        // 原 1~2pt 余量已多次把偶发波动误判为回归；这些模块仍保留独立地板，
        // 覆盖率回落超出此余量须显式决策而非被全局均值掩盖 ----------

        // 关联存储（store.json 元数据读写/迁移/重关联/落盘链）
        '**/src/main/services/store-meta.js': {
          statements: 88, branches: 82.5, functions: 92, lines: 94
        },
        // 应用设置双层存储（引导层 + 随库 settings.json）
        '**/src/main/services/store-settings.js': {
          statements: 89, branches: 84.5, functions: 93, lines: 90
        },
        // 目录监控（轮询快照比对 + 增量扫描触发）
        '**/src/main/services/watcher.js': {
          statements: 90, branches: 78, functions: 96, lines: 93.5
        },
        // 备份恢复（zip 打包/恢复/.bak 留存）
        '**/src/main/services/backup.js': {
          statements: 87, branches: 80, functions: 76, lines: 90
        },
        // 元数据重关联（库内移动/重命名后「宁可不绑也绝不绑错」）
        '**/src/main/services/meta-relink.js': {
          statements: 97, branches: 95, functions: 97, lines: 97
        },
        // safetensors 头部解析与健康检查
        '**/src/main/services/safetensors.js': {
          statements: 94, branches: 93.5, functions: 80, lines: 95
        },
        // 扫描分类（扩展名过滤/自动分类/禁用后缀）
        '**/src/main/services/scanner.js': {
          statements: 92, branches: 84, functions: 96, lines: 95
        },
        // 后台哈希预热（重复检测与 Civitai 识别的缓存基座）
        '**/src/main/services/hash-warmup.js': {
          statements: 89, branches: 85, functions: 96, lines: 92.5
        }
      }
    }
  }
})
