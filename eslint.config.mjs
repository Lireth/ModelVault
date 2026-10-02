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
    files: ['src/main/**/*.js', 'src/preload/**/*.js', 'tests/**/*.js', '*.mjs'],
    languageOptions: {
      globals: { ...globals.node }
    }
  },
  {
    rules: {
      // App.vue / Sidebar.vue 为既定命名（根组件与单词汇组件），不做多词强制
      'vue/multi-word-component-names': 'off',
      // 下划线开头参数/变量视为有意忽略
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  }
]
