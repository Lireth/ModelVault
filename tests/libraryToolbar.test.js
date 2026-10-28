// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import LibraryToolbar from '../src/renderer/src/components/LibraryToolbar.vue'
import { state } from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * LibraryToolbar 搜索语法辅助（FEAT-1）：
 * - 「?」帮助面板：开关、操作符目录行数、示例点击插入搜索框并聚焦；
 * - 输入自动补全：前缀/值两级候选、Enter 应用、方向键高亮、Esc 关闭；
 * - 既有搜索防抖链路不回归。
 */

setupComponentTest()

function mountToolbar() {
  return mount(LibraryToolbar)
}

beforeEach(() => {
  state.folder = 'D:\\models'
})

describe('搜索语法帮助面板（FEAT-1）', () => {
  it('帮助按钮切换面板，面板列出全部操作符', async () => {
    const wrapper = mountToolbar()
    expect(wrapper.find('.search-help-panel').exists()).toBe(false)
    await wrapper.find('.search-help').trigger('click')
    expect(wrapper.find('.search-help-panel').exists()).toBe(true)
    expect(wrapper.findAll('.help-row')).toHaveLength(11)
    await wrapper.find('.search-help').trigger('click')
    expect(wrapper.find('.search-help-panel').exists()).toBe(false)
    wrapper.unmount()
  })

  it('点击示例插入搜索框为 token 并聚焦输入框', async () => {
    const wrapper = mountToolbar()
    document.body.appendChild(wrapper.element)
    await wrapper.find('.search-help').trigger('click')
    await wrapper.findAll('.help-example')[0].trigger('click')
    await flushPromises()
    const input = wrapper.find('input[type="text"]')
    expect(input.element.value).toBe('base:pony ')
    expect(document.activeElement).toBe(input.element)
    expect(wrapper.find('.search-help-panel').exists()).toBe(false)
    wrapper.element.remove()
    wrapper.unmount()
  })

  it('搜索词防抖写回 state.search（既有链路不回归）', async () => {
    vi.useFakeTimers()
    const wrapper = mountToolbar()
    await wrapper.find('input[type="text"]').setValue('base:pony')
    await flushPromises()
    vi.advanceTimersByTime(250)
    expect(state.search).toBe('base:pony')
    vi.useRealTimers()
    wrapper.unmount()
  })
})

describe('输入自动补全（FEAT-1）', () => {
  it('输入前缀出现候选，Enter 应用为完整 token', async () => {
    const wrapper = mountToolbar()
    const input = wrapper.find('input[type="text"]')
    await input.setValue('ba')
    expect(wrapper.find('.search-suggest').exists()).toBe(true)
    expect(wrapper.find('.search-suggest code').text()).toBe('base:')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(input.element.value).toBe('base:')
    expect(wrapper.find('.search-suggest').exists()).toBe(false)
    wrapper.unmount()
  })

  it('值位置给出值候选并按前缀过滤', async () => {
    const wrapper = mountToolbar()
    const input = wrapper.find('input[type="text"]')
    await input.setValue('type:')
    expect(wrapper.findAll('.search-suggest code').length).toBeGreaterThan(1)
    await input.setValue('type:lo')
    expect(
      wrapper.findAll('.search-suggest code').map((c) => c.text()),
    ).toEqual(['lora'])
    wrapper.unmount()
  })

  it('方向键切换高亮候选，Esc 关闭建议', async () => {
    const wrapper = mountToolbar()
    const input = wrapper.find('input[type="text"]')
    await input.setValue('type:')
    const items = () => wrapper.findAll('.search-suggest li')
    expect(items()[0].classes()).toContain('active')
    await input.trigger('keydown', { key: 'ArrowDown' })
    expect(items()[1].classes()).toContain('active')
    await input.trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('.search-suggest').exists()).toBe(false)
    wrapper.unmount()
  })

  it('自由文本不弹候选（无候选时无下拉）', async () => {
    const wrapper = mountToolbar()
    await wrapper.find('input[type="text"]').setValue('赛博朋克机娘')
    expect(wrapper.find('.search-suggest').exists()).toBe(false)
    wrapper.unmount()
  })
})
