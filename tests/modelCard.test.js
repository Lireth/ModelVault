// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ModelCard from '../src/renderer/src/components/ModelCard.vue'
import { state } from '../src/renderer/src/store/appStore'
import { setupComponentTest, settle } from './helpers/componentTest'

/**
 * ModelCard 组件测试（OPT-16 基建；OPT-3 回归）：
 * 键盘交互正确性——卡片 Enter/Space 激活（打开详情/多选切换），
 * 收藏按钮 Enter/Space 仅切换收藏（keydown 不得冒泡到 article 触发
 * 打开详情的双动作缺陷）。
 */

setupComponentTest()

/** 构造最小模型对象（字段与扫描装饰结果对齐） */
function makeModel(id, overrides = {}) {
  return {
    id,
    name: id,
    type: 'checkpoint',
    size: 1000,
    mtimeMs: 1000,
    favorite: false,
    nsfw: false,
    rating: 0,
    alias: '',
    note: '',
    subCategory: '',
    triggerWords: '',
    ...overrides
  }
}

function mountCard(model) {
  state.models = [model]
  return mount(ModelCard, { props: { model } })
}

describe('ModelCard 卡片激活', () => {
  it('Enter 打开详情', async () => {
    const wrapper = mountCard(makeModel('m1'))
    await wrapper.find('.model-card').trigger('keydown', { key: 'Enter' })
    expect(state.selectedId).toBe('m1')
  })

  it('Space 打开详情', async () => {
    const wrapper = mountCard(makeModel('m1'))
    await wrapper.find('.model-card').trigger('keydown', { key: ' ' })
    expect(state.selectedId).toBe('m1')
  })

  it('点击打开详情', async () => {
    const wrapper = mountCard(makeModel('m1'))
    await wrapper.find('.model-card').trigger('click')
    expect(state.selectedId).toBe('m1')
  })

  it('多选模式下 Enter 切换选中而非打开详情', async () => {
    state.multiSelect.active = true
    const wrapper = mountCard(makeModel('m1'))
    await wrapper.find('.model-card').trigger('keydown', { key: 'Enter' })
    expect(state.multiSelect.ids).toEqual(['m1'])
    expect(state.selectedId).toBeNull()
  })
})

describe('ModelCard 拖拽归位（B-06）', () => {
  it('卡片可拖拽，dragstart 写入自定义 MIME 的当前模型 id', async () => {
    const wrapper = mountCard(makeModel('m1'))
    expect(wrapper.find('.model-card').attributes('draggable')).toBe('true')
    const setData = vi.fn()
    await wrapper.find('.model-card').trigger('dragstart', {
      dataTransfer: { setData, effectAllowed: '' }
    })
    expect(setData).toHaveBeenCalledWith(
      'application/x-modelvault-ids',
      JSON.stringify(['m1'])
    )
  })

  it('多选模式下拖动已选中卡片携带整个选区', async () => {
    state.multiSelect.active = true
    state.multiSelect.ids = ['m1', 'm2']
    const wrapper = mountCard(makeModel('m1'))
    const setData = vi.fn()
    await wrapper.find('.model-card').trigger('dragstart', {
      dataTransfer: { setData, effectAllowed: '' }
    })
    expect(setData).toHaveBeenCalledWith(
      'application/x-modelvault-ids',
      JSON.stringify(['m1', 'm2'])
    )
  })
})

describe('ModelCard 收藏按钮键盘行为（OPT-3 回归）', () => {
  /**
   * 说明：jsdom 不会把 Enter/Space 按键合成为按钮原生 click（真实浏览器会）。
   * 以下用例按浏览器真实时序模拟「keydown → click」两段，断言叠加后只有
   * 收藏生效、详情未打开——正是 OPT-3 双触发缺陷的回归点。
   */

  it('Enter：仅切换收藏，不冒泡打开详情', async () => {
    window.api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: true, nsfw: false, rating: 0 }
    })
    const wrapper = mountCard(makeModel('m1'))
    const btn = wrapper.find('.fav-btn')
    // 第一段：keydown 不得冒泡到 article 触发打开详情
    await btn.trigger('keydown', { key: 'Enter' })
    expect(state.selectedId).toBeNull()
    // 第二段：浏览器随后触发原生 click，收藏生效
    await btn.trigger('click')
    await settle()
    expect(window.api.models.setMetaFlags).toHaveBeenCalledWith({ id: 'm1', favorite: true })
    expect(state.selectedId).toBeNull()
  })

  it('Space：仅切换收藏，不冒泡打开详情', async () => {
    window.api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: true, nsfw: false, rating: 0 }
    })
    const wrapper = mountCard(makeModel('m1'))
    const btn = wrapper.find('.fav-btn')
    await btn.trigger('keydown', { key: ' ' })
    expect(state.selectedId).toBeNull()
    await btn.trigger('click')
    await settle()
    expect(window.api.models.setMetaFlags).toHaveBeenCalledWith({ id: 'm1', favorite: true })
    expect(state.selectedId).toBeNull()
  })

  it('点击：切换收藏且不打开详情', async () => {
    window.api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: true, nsfw: false, rating: 0 }
    })
    const wrapper = mountCard(makeModel('m1'))
    await wrapper.find('.fav-btn').trigger('click')
    await settle()
    expect(window.api.models.setMetaFlags).toHaveBeenCalled()
    expect(state.selectedId).toBeNull()
  })

  it('已收藏时 Enter 切换为取消收藏', async () => {
    window.api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: false, nsfw: false, rating: 0 }
    })
    const wrapper = mountCard(makeModel('m1', { favorite: true }))
    const btn = wrapper.find('.fav-btn')
    await btn.trigger('keydown', { key: 'Enter' })
    await btn.trigger('click')
    await settle()
    expect(window.api.models.setMetaFlags).toHaveBeenCalledWith({ id: 'm1', favorite: false })
    expect(state.selectedId).toBeNull()
  })
})
