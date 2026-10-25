// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  applyAccent,
  applyTheme,
  defaultSettings,
  initApp,
  resolveTheme,
  state,
} from '../src/renderer/src/store/appStore'

/**
 * 渲染层主题与强调色测试：
 * - resolveTheme：dark/light 直通，未知回退 dark，system 依 matchMedia 解析
 * - applyTheme：system 解析为有效主题后切换 class 与原生标题栏 IPC
 *   （主进程只认 dark/light），并按有效主题重应用强调色深/浅变体
 * - applyAccent：预设变体/自定义 hex/未知回退默认，inline 覆盖 CSS 令牌
 * - 跟随系统：matchMedia change 事件驱动重应用（非 system 模式不响应）
 */

/** 可控 matchMedia 桩：matches 可变，change 事件可手动触发 */
function stubMatchMedia(initialMatches) {
  const listeners = []
  const query = {
    matches: initialMatches,
    addEventListener: vi.fn((event, cb) => {
      if (event === 'change') listeners.push(cb)
    }),
    removeEventListener: vi.fn(),
    fireChange(next) {
      query.matches = next
      for (const cb of listeners) cb({ matches: next })
    },
  }
  window.matchMedia = vi.fn(() => query)
  return query
}

/** 清理 documentElement 上的主题残留（class 与 inline 令牌） */
function resetDom() {
  document.documentElement.classList.remove('light')
  document.documentElement.style.removeProperty('--accent')
  document.documentElement.style.removeProperty('--accent-2')
}

beforeEach(() => {
  stubMatchMedia(false) // 默认系统为深色
  window.api = {
    models: { loadStore: vi.fn() },
    settings: { update: vi.fn() },
    window: { setTheme: vi.fn(() => Promise.resolve()) },
  }
  Object.assign(state.settings, defaultSettings())
  resetDom()
})

afterEach(resetDom)

describe('resolveTheme', () => {
  it('dark/light 直通，未知值回退 dark', () => {
    expect(resolveTheme('dark')).toBe('dark')
    expect(resolveTheme('light')).toBe('light')
    expect(resolveTheme('neon')).toBe('dark')
    expect(resolveTheme(undefined)).toBe('dark')
  })

  it('system 依 matchMedia 解析', () => {
    const query = stubMatchMedia(false)
    expect(resolveTheme('system')).toBe('dark')
    query.matches = true
    expect(resolveTheme('system')).toBe('light')
  })
})

describe('applyTheme', () => {
  it('system 解析为有效主题后切换 class 并通知主进程（不发送 system）', () => {
    stubMatchMedia(true) // 系统为浅色
    applyTheme('system')
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(window.api.window.setTheme).toHaveBeenCalledWith('light')
  })

  it('系统为深色时 system 解析为 dark', () => {
    stubMatchMedia(false)
    applyTheme('system')
    expect(document.documentElement.classList.contains('light')).toBe(false)
    expect(window.api.window.setTheme).toHaveBeenCalledWith('dark')
  })

  it('切换主题时按有效主题重应用强调色变体', () => {
    state.settings.accentColor = 'violet'
    applyTheme('dark')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe(
      '#a78bfa',
    )
    applyTheme('light')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe(
      '#7c3aed',
    )
    expect(document.documentElement.style.getPropertyValue('--accent-2')).toBe(
      '#2f7fe0',
    )
  })
})

describe('applyAccent', () => {
  it('预设按有效主题取变体', () => {
    applyAccent('green', 'dark')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe(
      '#3ddc97',
    )
    expect(document.documentElement.style.getPropertyValue('--accent-2')).toBe(
      '#4dd0e1',
    )
    applyAccent('green', 'light')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe(
      '#1a8f5e',
    )
  })

  it('自定义 hex：accent2 同色（渐变退化为纯色）', () => {
    applyAccent('#ff8800', 'dark')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe(
      '#ff8800',
    )
    expect(document.documentElement.style.getPropertyValue('--accent-2')).toBe(
      '#ff8800',
    )
  })

  it('未知值回退默认预设（blue）', () => {
    applyAccent('no-such-key', 'dark')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe(
      '#5aa3fa',
    )
    expect(document.documentElement.style.getPropertyValue('--accent-2')).toBe(
      '#b18cff',
    )
  })

  it('默认预设与内置配色严格一致（老用户零视觉变化）', () => {
    applyAccent('blue', 'dark')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe(
      '#5aa3fa',
    )
    applyAccent('blue', 'light')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe(
      '#2f7fe0',
    )
  })
})

describe('主题跟随系统（matchMedia change 驱动）', () => {
  it('system 模式下系统亮暗变化即时重应用；非 system 模式不响应', async () => {
    const query = stubMatchMedia(false)
    window.api.models.loadStore.mockResolvedValue({
      settings: { ...defaultSettings(), theme: 'system' },
    })
    await initApp()
    // 初始：系统深色
    expect(document.documentElement.classList.contains('light')).toBe(false)
    // 系统切浅色 → 立即跟随
    query.fireChange(true)
    expect(document.documentElement.classList.contains('light')).toBe(true)
    expect(window.api.window.setTheme).toHaveBeenLastCalledWith('light')

    // 改为固定深色后，系统变化不再影响
    state.settings.theme = 'dark'
    query.fireChange(false)
    expect(window.api.window.setTheme).toHaveBeenLastCalledWith('light')
  })
})
