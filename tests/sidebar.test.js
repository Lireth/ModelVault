// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import Sidebar from '../src/renderer/src/components/Sidebar.vue'
import { state } from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * Sidebar 组件测试（OPT-16 基建；OPT-2 回归）：
 * 模型库移除按钮原为 display:none + :hover，键盘用户不可达。
 * 修复后以 opacity + pointer-events 保留 Tab 序列，span 补 role/tabindex/
 * 键盘激活——本文件固化这些可 DOM 观测的装配特征与激活行为。
 */

setupComponentTest()

/** 两个模型库：libA 为当前激活库，libB 可被移除 */
function setupTwoRoots() {
  state.folder = 'D:\\libA'
  state.settings.modelsFolders = ['D:\\libA', 'D:\\libB']
}

describe('Sidebar 模型库移除键盘可达（OPT-2 回归）', () => {
  it('移除按钮具备 role/tabindex/aria-label（可键盘聚焦与读屏识别）', () => {
    setupTwoRoots()
    const wrapper = mount(Sidebar)
    const remove = wrapper.find('.root-remove')
    expect(remove.exists()).toBe(true)
    expect(remove.attributes('role')).toBe('button')
    expect(remove.attributes('tabindex')).toBe('0')
    expect(remove.attributes('aria-label')).toContain('libB')
    expect(remove.attributes('title')).toContain('磁盘数据不受影响')
  })

  it('Enter 键触发移除（经 saveSettings 持久化，仅移出列表不删数据）', async () => {
    setupTwoRoots()
    window.api.settings.update.mockResolvedValue({
      settings: { ...state.settings, modelsFolders: ['D:\\libA'] }
    })
    const wrapper = mount(Sidebar)
    await wrapper.find('.root-remove').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(window.api.settings.update).toHaveBeenCalledWith({ modelsFolders: ['D:\\libA'] })
  })

  it('Space 键同样触发移除', async () => {
    setupTwoRoots()
    window.api.settings.update.mockResolvedValue({
      settings: { ...state.settings, modelsFolders: ['D:\\libA'] }
    })
    const wrapper = mount(Sidebar)
    await wrapper.find('.root-remove').trigger('keydown', { key: ' ' })
    await flushPromises()
    expect(window.api.settings.update).toHaveBeenCalledWith({ modelsFolders: ['D:\\libA'] })
  })

  it('点击移除不触发父级「切换模型库」（事件阻断）', async () => {
    setupTwoRoots()
    window.api.settings.update.mockResolvedValue({ settings: { ...state.settings } })
    const wrapper = mount(Sidebar)
    await wrapper.find('.root-remove').trigger('click')
    await flushPromises()
    // 未切换库：folder 不变，且未发起扫描
    expect(state.folder).toBe('D:\\libA')
    expect(window.api.models.scan).not.toHaveBeenCalled()
  })
})

