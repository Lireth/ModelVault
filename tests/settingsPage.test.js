// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import SettingsPage from '../src/renderer/src/components/SettingsPage.vue'
import { state } from '../src/renderer/src/store/appStore'
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
