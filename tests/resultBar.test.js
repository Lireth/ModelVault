// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import ResultBar from '../src/renderer/src/components/ResultBar.vue'
import {
  filteredModels,
  replaceModels,
  state,
} from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * 结果栏多标签筛选（FEAT-01）组件测试：
 * - 标签筛选为复选列表，可叠加多个标签
 * - 多标签按 AND 语义即时筛选
 * - 清除按钮复位
 */

setupComponentTest()

function model(name, tags) {
  return {
    id: `D:\\models\\${name}.safetensors`,
    name,
    type: 'lora',
    tags,
    size: 1,
    mtimeMs: 1,
    favorite: false,
    nsfw: false,
    rating: 0,
    alias: '',
    note: '',
    subCategory: '',
    triggerWords: '',
    coverUrl: '',
    covers: [],
  }
}

beforeEach(() => {
  state.showSuspectOnly = false
  replaceModels([
    model('a', ['赛博朋克', '服装']),
    model('b', ['赛博朋克']),
    model('c', ['服装']),
  ])
})

/** 勾选指定标签的复选框 */
async function toggleTag(wrapper, tag) {
  const option = wrapper
    .findAll('.tag-option')
    .find((w) => w.text().includes(tag))
  const checkbox = option.find('input')
  checkbox.element.checked = !checkbox.element.checked
  await checkbox.trigger('change')
}

describe('ResultBar 多标签筛选', () => {
  it('多标签叠加为 AND 语义，并按选择顺序展示计数', async () => {
    const wrapper = mount(ResultBar)
    expect(wrapper.find('.tag-trigger').exists()).toBe(true)

    await toggleTag(wrapper, '赛博朋克')
    expect(state.tagFilters).toEqual(['赛博朋克'])
    expect(filteredModels.value.map((m) => m.name)).toEqual(['a', 'b'])
    expect(wrapper.find('.tag-filter-count').text()).toBe('1')

    await toggleTag(wrapper, '服装')
    expect(state.tagFilters).toEqual(['赛博朋克', '服装'])
    expect(filteredModels.value.map((m) => m.name)).toEqual(['a'])
    expect(wrapper.find('.tag-filter-count').text()).toBe('2')
    wrapper.unmount()
  })

  it('取消勾选移除单个标签，清除按钮复位全部', async () => {
    const wrapper = mount(ResultBar)
    await toggleTag(wrapper, '赛博朋克')
    await toggleTag(wrapper, '服装')
    await toggleTag(wrapper, '赛博朋克')
    expect(state.tagFilters).toEqual(['服装'])

    const clear = wrapper.find('.tag-clear')
    expect(clear.exists()).toBe(true)
    await clear.trigger('click')
    expect(state.tagFilters).toEqual([])
    expect(wrapper.find('.tag-clear').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('ResultBar 全量标签检索（O1）', () => {
  const manyTags = Array.from(
    { length: 60 },
    (_, i) => `标签${String(i).padStart(2, '0')}`,
  )

  it('默认快选展示前 50 个，输入关键词可检索稀有标签', async () => {
    replaceModels([model('many', manyTags)])
    const wrapper = mount(ResultBar)
    expect(wrapper.findAll('.tag-option')).toHaveLength(50)
    expect(wrapper.find('.tag-options-hint').text()).toContain('共 60 个标签')

    const search = wrapper.find('.tag-search-input')
    await search.setValue('标签59')
    expect(wrapper.findAll('.tag-option')).toHaveLength(1)
    expect(wrapper.find('.tag-option').text()).toContain('标签59')

    await search.setValue('不存在')
    expect(wrapper.find('.tag-empty').exists()).toBe(true)
    wrapper.unmount()
  })

  it('已选标签即使不在默认快选区间也置顶可见', () => {
    state.tagFilters = ['标签59']
    replaceModels([model('many', manyTags)])
    const wrapper = mount(ResultBar)
    expect(wrapper.find('.tag-option').text()).toContain('标签59')
    expect(wrapper.findAll('.tag-option')).toHaveLength(50)
    wrapper.unmount()
  })
})

describe('ResultBar 疑似损坏筛选（FEAT-01）', () => {
  it('仅存在损坏模型时显示入口，点击切换筛选并更新结果', async () => {
    replaceModels([
      { ...model('ok', []), suspect: false },
      { ...model('bad', []), suspect: true },
    ])
    const wrapper = mount(ResultBar)
    const btn = wrapper
      .findAll('.fav-filter')
      .find((w) => w.text().includes('疑似损坏'))
    expect(btn).toBeTruthy()
    expect(btn.text()).toContain('1')

    await btn.trigger('click')
    expect(state.showSuspectOnly).toBe(true)
    expect(filteredModels.value.map((m) => m.name)).toEqual(['bad'])

    await btn.trigger('click')
    expect(state.showSuspectOnly).toBe(false)
    expect(filteredModels.value).toHaveLength(2)
    wrapper.unmount()
  })

  it('无损坏模型时不显示入口', () => {
    const wrapper = mount(ResultBar)
    expect(
      wrapper.findAll('.fav-filter').some((w) => w.text().includes('疑似损坏')),
    ).toBe(false)
    wrapper.unmount()
  })
})
