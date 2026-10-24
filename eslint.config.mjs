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
    ignores: ['out/**', 'dist/**', 'node_modules/**', 'image/**', 'build/**']
  },
  js.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  configPrettier,
  {
    files: ['src/renderer/**/*.{js,vue}'],
    languageOptions: {
      globals: { ...globals.browser }
    }
  },
  {
    files: ['src/main/**/*.js', 'src/preload/**/*.js', 'scripts/**/*.mjs', '*.mjs'],
    languageOptions: {
      globals: { ...globals.node }
    }
  },
  {
    // 组件测试（OPT-16）运行于 jsdom 环境（文件头 @vitest-environment jsdom），
    // 需要 window/document/事件构造器等浏览器全局；Node 全局仍然可用
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser }
    }
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
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  }
]
