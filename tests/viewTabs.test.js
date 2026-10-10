// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ViewTabs from '../src/renderer/src/components/ViewTabs.vue'
import { MAX_VIEWS, addView, resetViews, state } from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * 多视图标签栏组件测试（B-02）：
 * 标签渲染/切换/关闭、新建、上限禁用。
 */

setupComponentTest()

function mountTabs() {
  state.folder = 'D:\\models'
  return mount(ViewTabs)
}

describe('ViewTabs 标签栏', () => {
  it('未选择文件夹时不渲染', () => {
    resetViews()
    const wrapper = mount(ViewTabs)
    expect(wrapper.find('.view-tabs').exists()).toBe(false)
  })

  it('初始单个标签且无关闭按钮；标题为默认视图名', () => {
    resetViews()
    const wrapper = mountTabs()
    const tabs = wrapper.findAll('.view-tab')
    expect(tabs).toHaveLength(1)
    expect(tabs[0].text()).toContain('视图 1')
    expect(wrapper.find('.view-tab-close').exists()).toBe(false)
  })

  it('新建标签后出现两个标签，激活新标签', async () => {
    resetViews()
    const wrapper = mountTabs()
    await wrapper.find('.view-tab-add').trigger('click')
    await flushPromises()
    expect(state.views).toHaveLength(2)
    const tabs = wrapper.findAll('.view-tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[1].classes()).toContain('active')
    // 多标签后关闭按钮出现
    expect(wrapper.findAll('.view-tab-close')).toHaveLength(2)
  })

  it('点击非活动标签切换激活态', async () => {
    resetViews()
    const wrapper = mountTabs()
    const firstId = state.activeViewId
    addView()
    await flushPromises()
    await wrapper.findAll('.view-tab')[0].trigger('click')
    await flushPromises()
    expect(state.activeViewId).toBe(firstId)
    expect(wrapper.findAll('.view-tab')[0].classes()).toContain('active')
  })

  it('关闭按钮移除标签', async () => {
    resetViews()
    const wrapper = mountTabs()
    addView()
    await flushPromises()
    await wrapper.findAll('.view-tab-close')[1].trigger('click')
    await flushPromises()
    expect(state.views).toHaveLength(1)
  })

  it('标签标题反映活动条件（搜索词）', async () => {
    resetViews()
    state.folder = 'D:\\models'
    state.search = 'girl'
    await flushPromises()
    const wrapper = mount(ViewTabs)
    expect(wrapper.find('.view-tab-label').text()).toBe('搜索：girl')
  })

  it('达到上限后新建按钮禁用', async () => {
    resetViews()
    const wrapper = mountTabs()
    for (let i = 0; i < MAX_VIEWS - 1; i++) addView()
    await flushPromises()
    expect(wrapper.find('.view-tab-add').attributes('disabled')).toBeDefined()
  })
})
