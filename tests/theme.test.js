import { describe, it, expect } from 'vitest'
import { THEME_COLORS, themeColors } from '../src/main/theme'

/**
 * theme.js 单元测试（B2）：
 * themeColors 是主进程取主题色的唯一收口（窗口创建 + window:setTheme
 * IPC 均经此函数）。THEME_COLORS 为普通对象字面量，直接下标索引会命中
 * 原型链——渲染进程传入 'constructor'/'toString'/'__proto__' 等键时
 * 拿到函数或原型对象，其 backgroundColor/overlayColor 全为 undefined，
 * 导致 setBackgroundColor(undefined) 等原生 API 行为不可预期。
 */

describe('themeColors', () => {
  it('合法主题返回对应颜色', () => {
    expect(themeColors('dark')).toBe(THEME_COLORS.dark)
    expect(themeColors('light')).toBe(THEME_COLORS.light)
  })

  it('未知/非法输入回退深色', () => {
    expect(themeColors('purple')).toBe(THEME_COLORS.dark)
    expect(themeColors('')).toBe(THEME_COLORS.dark)
    expect(themeColors(undefined)).toBe(THEME_COLORS.dark)
    expect(themeColors(null)).toBe(THEME_COLORS.dark)
    expect(themeColors(42)).toBe(THEME_COLORS.dark)
  })

  it('原型链属性不命中：constructor 等键一律回退深色（B2）', () => {
    for (const key of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
      const colors = themeColors(key)
      // 不得返回函数/原型对象，必须是字段完整的深色配色
      expect(colors).toBe(THEME_COLORS.dark)
      expect(colors.backgroundColor).toMatch(/^#[0-9a-f]{6}$/i)
      expect(colors.overlayColor).toBe(THEME_COLORS.dark.overlayColor)
      expect(colors.symbolColor).toBe(THEME_COLORS.dark.symbolColor)
    }
  })
})
