/**
 * 主题颜色常量（主进程共用）：
 * 窗口创建时的底色/标题栏叠加层颜色与主题切换时的同步更新
 * 必须使用同一份数据，避免双份维护导致改色遗漏。
 */
export const THEME_COLORS = {
  dark: { backgroundColor: '#101418', overlayColor: '#101418', symbolColor: '#e6eaee' },
  light: { backgroundColor: '#f5f7fa', overlayColor: '#f5f7fa', symbolColor: '#24292f' }
}

/**
 * 按主题名取颜色（未知主题回退深色）。
 * 必须用 Object.hasOwn 限定自有属性（B2）：直接下标索引会命中原型链，
 * 'constructor'/'toString'/'__proto__' 等键会拿到函数或原型对象，
 * 其颜色字段全为 undefined，令原生标题栏/背景 API 行为不可预期。
 * 本函数是主进程取主题色的唯一收口（窗口创建与 window:setTheme 均经此）。
 */
export function themeColors(theme) {
  return Object.hasOwn(THEME_COLORS, theme) ? THEME_COLORS[theme] : THEME_COLORS.dark
}
