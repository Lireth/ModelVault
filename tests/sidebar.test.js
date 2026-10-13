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

describe('Sidebar 智能视图（组合筛选收藏）', () => {
  /** settings.update 回显合并结果（与主进程返回完整设置一致） */
  function echoSettingsUpdate() {
    window.api.settings.update.mockImplementation((patch) =>
      Promise.resolve({ settings: { ...state.settings, ...patch } })
    )
  }

  function seedView(overrides = {}) {
    const view = {
      id: 'v1',
      name: 'LoRA收藏',
      search: '',
      typeFilter: 'lora',
      subFilter: '',
      showFavoritesOnly: true,
      sortBy: 'name',
      sortAsc: true,
      ...overrides
    }
    state.settings.savedViews = [view]
    return view
  }

  it('当前筛选命中视图时高亮 active，未命中则不高亮', async () => {
    state.folder = 'D:\\libA'
    seedView()
    state.typeFilter = 'lora'
    state.showFavoritesOnly = true
    let wrapper = mount(Sidebar)
    expect(wrapper.find('.view-item.active').exists()).toBe(true)
    wrapper.unmount()

    state.showFavoritesOnly = false
    wrapper = mount(Sidebar)
    expect(wrapper.find('.view-item.active').exists()).toBe(false)
    wrapper.unmount()
  })

  it('点击视图应用筛选组合并持久化排序', async () => {
    state.folder = 'D:\\libA'
    seedView({ sortBy: 'size', sortAsc: false })
    echoSettingsUpdate()
    const wrapper = mount(Sidebar)
    await wrapper.find('.view-item').trigger('click')
    await flushPromises()
    expect(state.typeFilter).toBe('lora')
    expect(state.showFavoritesOnly).toBe(true)
    expect(state.sortBy).toBe('size')
    expect(window.api.settings.update).toHaveBeenCalledWith({ sortBy: 'size', sortAsc: false })
    wrapper.unmount()
  })

  it('删除视图：键盘 Enter 触发且不冒泡应用视图', async () => {
    state.folder = 'D:\\libA'
    seedView()
    echoSettingsUpdate()
    const wrapper = mount(Sidebar)
    const remove = wrapper.find('.view-remove')
    expect(remove.attributes('role')).toBe('button')
    expect(remove.attributes('tabindex')).toBe('0')
    await remove.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(window.api.settings.update).toHaveBeenCalledWith({ savedViews: [] })
    // 未冒泡触发应用：筛选保持默认
    expect(state.typeFilter).toBe('all')
    wrapper.unmount()
  })

  it('保存流程：展开内联表单输入名称后持久化新视图', async () => {
    state.folder = 'D:\\libA'
    state.typeFilter = 'lora'
    echoSettingsUpdate()
    const wrapper = mount(Sidebar)
    await wrapper.find('.view-save-btn').trigger('click')
    const input = wrapper.find('.view-save-form input')
    expect(input.exists()).toBe(true)
    await input.setValue('我的视图')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    const call = window.api.settings.update.mock.calls[0][0]
    expect(call.savedViews).toHaveLength(1)
    expect(call.savedViews[0]).toMatchObject({ name: '我的视图', typeFilter: 'lora' })
    // 保存成功后表单收起
    expect(wrapper.find('.view-save-form').exists()).toBe(false)
    wrapper.unmount()
  })

  it('Esc 取消保存：收起表单且不持久化', async () => {
    state.folder = 'D:\\libA'
    const wrapper = mount(Sidebar)
    await wrapper.find('.view-save-btn').trigger('click')
    await wrapper.find('.view-save-form input').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('.view-save-form').exists()).toBe(false)
    expect(window.api.settings.update).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('未选择文件夹时保存按钮禁用', () => {
    state.folder = ''
    const wrapper = mount(Sidebar)
    expect(wrapper.find('.view-save-btn').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
})

