// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import Sidebar from '../src/renderer/src/components/Sidebar.vue'
import { state, acceptConfirm } from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * Sidebar 组件测试（OPT-16 基建；OPT-2 回归；issue #78）：
 * 模型库移除按钮原为 display:none + :hover，键盘用户不可达。修复后以
 * opacity + pointer-events 保留 Tab 序列；issue #78 进一步把 span[role=button]
 * 改为原生 button 并移出父级 button（消除非法交互嵌套，Enter/Space 激活由
 * 浏览器合成 click）——本文件固化这些可 DOM 观测的装配特征与激活行为。
 */

setupComponentTest()

/** 两个模型库：libA 为当前激活库，libB 可被移除 */
function setupTwoRoots() {
  state.folder = 'D:\\libA'
  state.settings.modelsFolders = ['D:\\libA', 'D:\\libB']
}

describe('Sidebar 模型库移除键盘可达（OPT-2 回归 / issue #78）', () => {
  it('移除按钮为原生 button 且不嵌套于按钮内（aria-label 可读屏识别）', () => {
    setupTwoRoots()
    const wrapper = mount(Sidebar)
    const remove = wrapper.find('.root-remove')
    expect(remove.exists()).toBe(true)
    // 原生 button：无需手工 role/tabindex 装配，浏览器自带 Tab 序列与
    // Enter/Space 激活（issue #78 前为嵌套在 button 内的 span[role=button]）
    expect(remove.element.tagName).toBe('BUTTON')
    expect(remove.element.closest('button')).toBe(remove.element)
    expect(remove.attributes('aria-label')).toContain('libB')
    expect(remove.attributes('title')).toContain('磁盘数据不受影响')
  })

  it('点击移除经 saveSettings 持久化（仅移出列表不删数据）', async () => {
    setupTwoRoots()
    window.api.settings.update.mockResolvedValue({
      settings: { ...state.settings, modelsFolders: ['D:\\libA'] },
    })
    const wrapper = mount(Sidebar)
    await wrapper.find('.root-remove').trigger('click')
    await flushPromises()
    expect(window.api.settings.update).toHaveBeenCalledWith({
      modelsFolders: ['D:\\libA'],
    })
  })

  it('点击移除不触发父级「切换模型库」（并列结构下事件不落于切换按钮）', async () => {
    setupTwoRoots()
    window.api.settings.update.mockResolvedValue({
      settings: { ...state.settings },
    })
    const wrapper = mount(Sidebar)
    await wrapper.find('.root-remove').trigger('click')
    await flushPromises()
    // 未切换库：folder 不变，且未发起扫描
    expect(state.folder).toBe('D:\\libA')
    expect(window.api.models.scan).not.toHaveBeenCalled()
  })
})

describe('Sidebar 失效库标记（F1-offline）', () => {
  it('失效库条目带 root-offline 标记、警示点与不可用提示（小写路径比较）', () => {
    setupTwoRoots()
    state.missingRoots = ['d:\\libb']
    const wrapper = mount(Sidebar)
    const item = wrapper.find('.root-item')
    expect(item.classes()).toContain('root-offline')
    expect(item.attributes('title')).toContain('文件夹不可用')
    expect(item.find('.root-dot').classes()).toContain('root-dot-offline')
    wrapper.unmount()
  })

  it('正常库不带失效标记；当前激活库不在 otherRoots 中不参与标记', () => {
    setupTwoRoots()
    // 激活库 libA 失效也不出现在列表（otherRoots 已剔除）；libB 正常
    state.missingRoots = ['d:\\liba']
    const wrapper = mount(Sidebar)
    const item = wrapper.find('.root-item')
    expect(item.classes()).not.toContain('root-offline')
    expect(item.find('.root-dot').classes()).not.toContain('root-dot-offline')
    wrapper.unmount()
  })
})

describe('Sidebar 智能视图（组合筛选收藏）', () => {
  /** settings.update 回显合并结果（与主进程返回完整设置一致） */
  function echoSettingsUpdate() {
    window.api.settings.update.mockImplementation((patch) =>
      Promise.resolve({ settings: { ...state.settings, ...patch } }),
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
      ...overrides,
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
    expect(window.api.settings.update).toHaveBeenCalledWith({
      sortBy: 'size',
      sortAsc: false,
    })
    wrapper.unmount()
  })

  it('删除视图：点击删除先弹确认（P0-8），接受后持久化且不冒泡应用视图', async () => {
    state.folder = 'D:\\libA'
    seedView()
    echoSettingsUpdate()
    const wrapper = mount(Sidebar)
    const remove = wrapper.find('.view-remove')
    // 原生 button（issue #78：不再嵌套于父级 button 内）
    expect(remove.element.tagName).toBe('BUTTON')
    expect(remove.element.closest('button')).toBe(remove.element)
    await remove.trigger('click')
    await flushPromises()
    // 确认层打开且未误删；接受后完成删除
    expect(state.confirm.visible).toBe(true)
    expect(window.api.settings.update).not.toHaveBeenCalled()
    acceptConfirm()
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
    expect(call.savedViews[0]).toMatchObject({
      name: '我的视图',
      typeFilter: 'lora',
    })
    // 保存成功后表单收起
    expect(wrapper.find('.view-save-form').exists()).toBe(false)
    wrapper.unmount()
  })

  it('Esc 取消保存：收起表单且不持久化', async () => {
    state.folder = 'D:\\libA'
    const wrapper = mount(Sidebar)
    await wrapper.find('.view-save-btn').trigger('click')
    await wrapper
      .find('.view-save-form input')
      .trigger('keydown', { key: 'Escape' })
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

  it('输入法组合态回车不保存视图（isComposing 守卫，表单保持展开）', async () => {
    state.folder = 'D:\\libA'
    echoSettingsUpdate()
    const wrapper = mount(Sidebar)
    await wrapper.find('.view-save-btn').trigger('click')
    const input = wrapper.find('.view-save-form input')
    await input.setValue('我的视图')
    input.element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
      }),
    )
    await flushPromises()
    expect(wrapper.find('.view-save-form').exists()).toBe(true)
    expect(window.api.settings.update).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('输入法组合态 Esc 不取消保存（isComposing 守卫，表单保持展开）', async () => {
    state.folder = 'D:\\libA'
    const wrapper = mount(Sidebar)
    await wrapper.find('.view-save-btn').trigger('click')
    wrapper.find('.view-save-form input').element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        isComposing: true,
        bubbles: true,
      }),
    )
    await flushPromises()
    expect(wrapper.find('.view-save-form').exists()).toBe(true)
    wrapper.unmount()
  })
})
