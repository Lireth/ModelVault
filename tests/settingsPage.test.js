// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import SettingsPage from '../src/renderer/src/components/SettingsPage.vue'
import { acceptConfirm, state } from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * SettingsPage 组件测试：
 * - A-15 应用内检查更新：有新版本时展示 releaseNotes（更新说明文本），
 *   远程内容以文本插值渲染（防 XSS），无说明时不渲染说明区；
 * - B-04 日志与诊断入口：「打开日志目录」按钮经 app.openLogs 调用主进程。
 */

setupComponentTest()

/** 挂载设置页（fillForm 与 getInfo 在 onMounted 触发） */
async function mountSettings() {
  state.settingsOpen = true
  window.api.app.getInfo = vi.fn().mockResolvedValue({
    name: 'modelvault',
    version: '0.1.0',
    electron: '44.0.0',
    node: '22.0.0',
    platform: 'win32'
  })
  const wrapper = mount(SettingsPage)
  await flushPromises()
  return wrapper
}

/** 点击「检查更新」并等待结果落定 */
async function runUpdateCheck(wrapper, result) {
  window.api.app.checkUpdate = vi.fn().mockResolvedValue(result)
  const buttons = wrapper.findAll('button')
  const btn = buttons.find((b) => b.text().includes('检查更新'))
  expect(btn).toBeTruthy()
  await btn.trigger('click')
  await flushPromises()
}

describe('SettingsPage 应用内检查更新（A-15）', () => {
  it('有新版本时展示版本号、下载链接与更新说明（releaseNotes 文本渲染）', async () => {
    const wrapper = await mountSettings()
    await runUpdateCheck(wrapper, {
      current: '0.1.0',
      latest: '0.2.0',
      hasUpdate: true,
      releaseUrl: 'https://github.com/Lireth/ModelVault/releases/tag/v0.2.0',
      releaseNotes: '## v0.2.0\n- 新增更新说明展示\n- 修复若干问题'
    })

    const box = wrapper.find('.update-row')
    expect(box.text()).toContain('发现新版本 v0.2.0')
    // 更新说明在独立节点展示（保留换行的纯文本）
    const notes = wrapper.find('.update-notes')
    expect(notes.exists()).toBe(true)
    expect(notes.text()).toContain('新增更新说明展示')
    expect(notes.text()).toContain('修复若干问题')
    // 下载链接保留
    const link = box.find('a')
    expect(link.attributes('href')).toContain('github.com')
  })

  it('更新说明为空时不渲染说明节点', async () => {
    const wrapper = await mountSettings()
    await runUpdateCheck(wrapper, {
      current: '0.1.0',
      latest: '0.2.0',
      hasUpdate: true,
      releaseUrl: 'https://github.com/Lireth/ModelVault/releases/tag/v0.2.0',
      releaseNotes: ''
    })

    expect(wrapper.find('.update-notes').exists()).toBe(false)
    expect(wrapper.find('.update-row').text()).toContain('发现新版本 v0.2.0')
  })

  it('更新说明以文本插值渲染，不执行其中的 HTML（XSS 防护）', async () => {
    const wrapper = await mountSettings()
    await runUpdateCheck(wrapper, {
      current: '0.1.0',
      latest: '0.2.0',
      hasUpdate: true,
      releaseUrl: 'https://github.com/Lireth/ModelVault/releases/tag/v0.2.0',
      releaseNotes: '<img src=x onerror=alert(1)>原样显示'
    })

    // 不含真实 img 元素：远程文本按文本节点渲染
    expect(wrapper.find('.update-notes').find('img').exists()).toBe(false)
    expect(wrapper.find('.update-notes').text()).toContain('<img src=x')
  })
})

describe('SettingsPage 日志与诊断入口（B-04）', () => {
  it('「打开日志目录」按钮调用 app.openLogs IPC', async () => {
    window.api.app.openLogs = vi.fn().mockResolvedValue({ ok: true })
    const wrapper = await mountSettings()
    const btn = wrapper.findAll('button').find((b) => b.text().includes('打开日志目录'))
    expect(btn).toBeTruthy()
    await btn.trigger('click')
    expect(window.api.app.openLogs).toHaveBeenCalledTimes(1)
  })

  it('打开失败时提示错误（不静默）', async () => {
    window.api.app.openLogs = vi.fn().mockResolvedValue({ error: '目录不存在' })
    const wrapper = await mountSettings()
    const btn = wrapper.findAll('button').find((b) => b.text().includes('打开日志目录'))
    await btn.trigger('click')
    await flushPromises()
    expect(state.toasts.some((t) => t.type === 'error' && t.text.includes('目录不存在'))).toBe(true)
  })

  it('复制诊断信息时剪贴板内容包含版本与平台信息', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const wrapper = await mountSettings()
    const btn = wrapper.findAll('button').find((b) => b.text().includes('复制诊断信息'))
    expect(btn).toBeTruthy()
    await btn.trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledTimes(1)
    const text = writeText.mock.calls[0][0]
    expect(text).toContain('0.1.0')
    expect(text).toContain('44.0.0')
    expect(text).toContain('win32')
  })
})

describe('SettingsPage 主题跟随系统与自定义强调色', () => {
  /** 清理 documentElement 主题残留 */
  function resetDom() {
    document.documentElement.classList.remove('light')
    document.documentElement.style.removeProperty('--accent')
    document.documentElement.style.removeProperty('--accent-2')
  }

  it('主题分段含「跟随系统」，点击后预览经解析应用（组件测试桩系统为深色）', async () => {
    const wrapper = await mountSettings()
    const systemBtn = wrapper.findAll('.seg-btn').find((b) => b.text() === '跟随系统')
    expect(systemBtn).toBeTruthy()
    await systemBtn.trigger('click')
    await flushPromises()
    expect(systemBtn.classes()).toContain('active')
    // componentTest 的 matchMedia 桩 matches=false → system 解析为 dark
    expect(window.api.window.setTheme).toHaveBeenLastCalledWith('dark')
    expect(document.documentElement.classList.contains('light')).toBe(false)
    wrapper.unmount()
    resetDom()
  })

  it('点击预设色板实时预览并纳入保存载荷', async () => {
    window.api.settings.update.mockImplementation((patch) =>
      Promise.resolve({ settings: { ...state.settings, ...patch } })
    )
    const wrapper = await mountSettings()
    const violet = wrapper.findAll('.accent-swatch').find((b) => b.attributes('title') === '星云紫')
    expect(violet).toBeTruthy()
    await violet.trigger('click')
    await flushPromises()
    // 实时预览：inline 令牌覆盖（深色变体）
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#a78bfa')
    expect(violet.classes()).toContain('active')
    // 保存：accentColor 进入载荷
    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存')
    await saveBtn.trigger('click')
    await flushPromises()
    expect(window.api.settings.update).toHaveBeenCalledWith(
      expect.objectContaining({ accentColor: 'violet' })
    )
    wrapper.unmount()
    resetDom()
  })

  it('放弃修改关闭时还原已保存的强调色', async () => {
    const wrapper = await mountSettings()
    const violet = wrapper.findAll('.accent-swatch').find((b) => b.attributes('title') === '星云紫')
    await violet.trigger('click')
    await flushPromises()
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#a78bfa')
    // 有未保存修改 → 关闭需确认，确认后还原为默认 blue
    const cancelBtn = wrapper.findAll('button').find((b) => b.text() === '关闭设置页面')
    await cancelBtn.trigger('click')
    await flushPromises()
    expect(state.confirm.visible).toBe(true)
    acceptConfirm()
    await flushPromises()
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#5aa3fa')
    expect(state.settingsOpen).toBe(false)
    wrapper.unmount()
    resetDom()
  })
})

describe('库统计区（F7）', () => {
  /** 构造带统计字段的模型（字段与装饰结果对齐） */
  function statModel(id, overrides = {}) {
    return {
      id,
      name: id,
      type: 'lora',
      size: 1024,
      mtimeMs: 1000,
      note: '',
      alias: '',
      params: null,
      hasManualCover: false,
      favorite: false,
      nsfw: false,
      rating: 0,
      suspect: false,
      ...overrides
    }
  }

  it('展示总模型数、分类行、标注覆盖率与最占空间 TOP-N', async () => {
    state.models = [
      statModel('big', { name: '大模型', type: 'checkpoint', size: 3 * 1024 * 1024 * 1024, note: '有备注' }),
      statModel('small', { name: '小模型', size: 512 })
    ]
    const wrapper = await mountSettings()

    const section = wrapper.find('.stats-section')
    expect(section.exists()).toBe(true)
    // 总数为 2
    const overview = wrapper.findAll('.stat-item')
    expect(overview[0].text()).toContain('2')
    // 分类行含 Checkpoint（带数量）
    const typeRows = wrapper.findAll('.type-stats li')
    expect(typeRows.length).toBeGreaterThanOrEqual(2)
    expect(typeRows.some((r) => r.text().includes('Checkpoint') && r.text().includes('1'))).toBe(true)
    // 覆盖率行：有备注 50%
    const covRows = wrapper.findAll('.cov-row')
    expect(covRows.some((r) => r.text().includes('有备注') && r.text().includes('50%'))).toBe(true)
    // TOP 列表按容量降序：大模型在前
    const tops = wrapper.findAll('.top-list li')
    expect(tops).toHaveLength(2)
    expect(tops[0].text()).toContain('大模型')
    wrapper.unmount()
  })

  it('空库时显示「尚未扫描模型」占位而非报错', async () => {
    const wrapper = await mountSettings()
    expect(wrapper.find('.stats-section').exists()).toBe(true)
    expect(wrapper.findAll('.stats-empty').length).toBeGreaterThanOrEqual(2)
    expect(wrapper.find('.top-list').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('SettingsPage NSFW 示例图模糊开关', () => {
  it('开关默认开启；关闭后保存载荷携带 nsfwBlur: false', async () => {
    window.api.settings.update.mockImplementation((patch) =>
      Promise.resolve({ settings: { ...state.settings, ...patch } })
    )
    const wrapper = await mountSettings()
    const row = wrapper
      .findAll('.switch-row')
      .find((r) => r.text().includes('NSFW 示例图模糊'))
    expect(row).toBeTruthy()
    const sw = row.find('input.switch')
    expect(sw.element.checked).toBe(true) // 默认开启（与既有模糊行为一致）
    await sw.setValue(false)
    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存')
    await saveBtn.trigger('click')
    await flushPromises()
    expect(window.api.settings.update).toHaveBeenCalledWith(
      expect.objectContaining({ nsfwBlur: false })
    )
    wrapper.unmount()
  })

  it('已保存设置关闭模糊时表单回填 false（重启后开关状态保持）', async () => {
    state.settings.nsfwBlur = false
    const wrapper = await mountSettings()
    const row = wrapper
      .findAll('.switch-row')
      .find((r) => r.text().includes('NSFW 示例图模糊'))
    expect(row.find('input.switch').element.checked).toBe(false)
    wrapper.unmount()
  })
})
