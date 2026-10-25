/**
 * 强调色预设（自定义强调色功能）：
 * 每个预设给出深/浅两套 accent + accent2（渐变第二端点）取值——
 * main.css 的 --accent-grad / --glow-accent / --aurora-* / --card-hover-shadow
 * 均经 color-mix 由这两个令牌派生，切换预设即全局换色。
 * 首个预设 'blue' 与默认配色严格一致（默认设置 accentColor: 'blue'，
 * 对老用户零视觉变化）；自定义色（#rrggbb）不设 accent2，渐变退化为同色。
 */
export const ACCENT_PRESETS = [
  {
    key: 'blue',
    label: '极光蓝',
    dark: { accent: '#5aa3fa', accent2: '#b18cff' },
    light: { accent: '#2f7fe0', accent2: '#8a5fe8' },
  },
  {
    key: 'violet',
    label: '星云紫',
    dark: { accent: '#a78bfa', accent2: '#5aa3fa' },
    light: { accent: '#7c3aed', accent2: '#2f7fe0' },
  },
  {
    key: 'green',
    label: '极光绿',
    dark: { accent: '#3ddc97', accent2: '#4dd0e1' },
    light: { accent: '#1a8f5e', accent2: '#1899b0' },
  },
  {
    key: 'cyan',
    label: '冰川青',
    dark: { accent: '#4dd0e1', accent2: '#5aa3fa' },
    light: { accent: '#1899b0', accent2: '#2f7fe0' },
  },
  {
    key: 'orange',
    label: '暖阳橙',
    dark: { accent: '#ffb86b', accent2: '#ff7eb6' },
    light: { accent: '#d98e3f', accent2: '#d9577f' },
  },
  {
    key: 'pink',
    label: '樱花粉',
    dark: { accent: '#ff7eb6', accent2: '#b18cff' },
    light: { accent: '#d9577f', accent2: '#8a5fe8' },
  },
]

/** 自定义颜色值格式（accentColor 设置项允许预设 key 或 #rrggbb） */
export const CUSTOM_ACCENT_RE = /^#[0-9a-fA-F]{6}$/
