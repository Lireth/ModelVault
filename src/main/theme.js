/**
 * 主题颜色常量（主进程共用）：
 * 窗口创建时的底色/标题栏叠加层颜色与主题切换时的同步更新
 * 必须使用同一份数据，避免双份维护导致改色遗漏。
 */
export const THEME_COLORS = {
  dark: { backgroundColor: '#101418', overlayColor: '#101418', symbolColor: '#e6eaee' },
  light: { backgroundColor: '#f5f7fa', overlayColor: '#f5f7fa', symbolColor: '#24292f' }
}

/** 按主题名取颜色（未知主题回退深色） */
export function themeColors(theme) {
  return THEME_COLORS[theme] || THEME_COLORS.dark
}
