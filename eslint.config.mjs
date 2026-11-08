import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import configPrettier from 'eslint-config-prettier'
import globals from 'globals'

/**
 * ESLint flat config（D1 代码质量门禁）：
 * - 主进程/preload/tests 为 Node 环境，渲染进程为浏览器环境；
 * - Vue 采用 essential 预设（仅错误防止类规则），风格类约束交给 Prettier；
 * - eslint-config-prettier 关闭与 Prettier 冲突的风格规则。
 */
export default [
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      'image/**',
      'build/**',
      // 覆盖率报告生成物（istanbul HTML 报告的 prettify/sorter 等脚本）：
      // 生成物不参与 lint，避免 npm run lint 扫描与 --fix 改写
      'coverage/**',
    ],
  },
  js.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  configPrettier,
  {
    files: ['src/renderer/**/*.{js,vue}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: [
      'src/main/**/*.js',
      'src/preload/**/*.js',
      'scripts/**/*.mjs',
      '*.mjs',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // 组件测试（OPT-16）运行于 jsdom 环境（文件头 @vitest-environment jsdom），
    // 需要 window/document/事件构造器等浏览器全局；Node 全局仍然可用
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    rules: {
      // App.vue / Sidebar.vue 为既定命名（根组件与单词汇组件），不做多词强制
      'vue/multi-word-component-names': 'off',
      // OPT-01 板块拆分模式：父组件持有响应式表单副本（useSettingsForm /
      // MetaForm），板块子组件经 prop 共享同一对象并写入其字段（v-model）。
      // shallowOnly 保持禁止整体替换/直接变异 prop 本身，仅放行共享对象的
      // 深层字段写入——这是本项目设置页/详情表单拆分的既定数据流约定
      'vue/no-mutating-props': ['error', { shallowOnly: true }],
      // 下划线开头参数/变量视为有意忽略
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // 分层依赖方向（主进程）：services 为业务/基础设施层，ipc 为 Electron
    // 适配层；下层不得反向依赖上层——需要窗口/对话框能力时由 ipc 侧注入或
    // 经事件回调上抛，避免 services 重新耦合到通道注册与窗口生命周期。
    files: ['src/main/services/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/ipc/**', '../ipc', '../ipc/*', '../../ipc/*'],
              message:
                '分层约束：services 不得反向依赖 ipc 适配层，请由 ipc 侧注入依赖或改用回调。',
            },
          ],
        },
      ],
    },
  },
  {
    // 共享契约层（src/shared）被主进程/preload/渲染层共同引用，必须保持
    // 无运行时依赖：仅允许纯 JS 常量、类型与纯函数，不得引入 Electron 或
    // 任一端实现。
    files: ['src/shared/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'electron',
                '../main/**',
                '../preload/**',
                '../renderer/**',
              ],
              message: '分层约束：shared 为纯契约层，不得依赖任一端实现。',
            },
          ],
        },
      ],
    },
  },
]
