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
