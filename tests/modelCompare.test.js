// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import ModelCompare from '../src/renderer/src/components/ModelCompare.vue'
import {
  closeCompare,
  compareState,
  openCompare,
  replaceModels,
  state,
} from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * 模型对比（FN-03）：
 * - 2~6 个模型限制与提示
 * - 字段行/列渲染、差异行高亮
 * - 关闭语义
 * - 焦点管理（O10/OPT-03）：焦点进出与 Tab 陷阱
 */

setupComponentTest()

function model(id, overrides = {}) {
  return {
    id,
    name: id,
    ext: '.safetensors',
    type: 'lora',
    subCategory: 'role',
    baseModel: 'Pony V6',
    size: 1024,
    mtimeMs: 1000,
    rating: 4,
    favorite: true,
    nsfw: false,
    tags: [],
    triggerWords: '',
    note: '',
    params: null,
    coverUrl: '',
    ...overrides,
  }
}

function mountCompare() {
  return mount(ModelCompare, { global: { stubs: { Teleport: true } } })
}

beforeEach(() => {
  replaceModels([
    model('a', { baseModel: 'Pony V6', rating: 4 }),
    model('b', { baseModel: 'SDXL 1.0', rating: 2, tags: ['风格'] }),
  ])
})

describe('openCompare 限制', () => {
  it('少于 2 个不打开并提示', () => {
    expect(openCompare(['a'])).toBe(false)
    expect(compareState.open).toBe(false)
    expect(state.toasts.some((t) => t.text.includes('至少选择 2 个'))).toBe(
      true,
    )
  })

  it('超过 6 个不打开并提示', () => {
    expect(openCompare(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe(false)
    expect(state.toasts.some((t) => t.text.includes('最多同时对比 6 个'))).toBe(
      true,
    )
  })

  it('2 个合法时打开并保存 id 快照', () => {
    expect(openCompare(['a', 'b'])).toBe(true)
    expect(compareState.open).toBe(true)
    expect(compareState.ids).toEqual(['a', 'b'])
  })
})

describe('ModelCompare 渲染', () => {
  it('按模型列展示字段，并对差异行高亮', async () => {
    openCompare(['a', 'b'])
    const wrapper = mountCompare()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.compare-panel').exists()).toBe(true)
    expect(wrapper.findAll('.model-head')).toHaveLength(2)
    // 13 个字段行
    expect(wrapper.findAll('.compare-table tbody tr')).toHaveLength(13)

    const baseRow = wrapper
      .findAll('.compare-table tbody tr')
      .find((tr) => tr.text().includes('基底模型'))
    expect(baseRow.exists()).toBe(true)
    // 基底不同：两个值单元格都标记 diff
    expect(baseRow.findAll('td.diff')).toHaveLength(2)

    const favRow = wrapper
      .findAll('.compare-table tbody tr')
      .find((tr) => tr.text().includes('收藏'))
    expect(favRow.findAll('td.diff')).toHaveLength(0)
    expect(wrapper.text()).toContain('Pony V6')
    expect(wrapper.text()).toContain('SDXL 1.0')
    wrapper.unmount()
  })

  it('关闭按钮退出对比视图', async () => {
    openCompare(['a', 'b'])
    const wrapper = mountCompare()
    await wrapper.vm.$nextTick()
    await wrapper.find('.wc-btn').trigger('click')
    await wrapper.vm.$nextTick()
    expect(compareState.open).toBe(false)
    expect(wrapper.find('.compare-panel').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('ModelCompare 焦点管理（O10/OPT-03）', () => {
  it('打开对比焦点移入面板，关闭后归还触发元素', async () => {
    const wrapper = mountCompare()
    // jsdom 限制：未连入 document 的元素 focus() 不生效，须真实挂载
    document.body.appendChild(wrapper.element)
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    openCompare(['a', 'b'])
    await nextTick()
    await nextTick() // watch 触发 + 内部 nextTick 焦点移交
    expect(document.activeElement).toBe(
      wrapper.find('.compare-panel').element,
    )

    closeCompare()
    await nextTick()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
    wrapper.element.remove()
    wrapper.unmount()
  })

  it('Tab 在面板内首末循环，不穿透遮罩（焦点陷阱）', async () => {
    openCompare(['a', 'b'])
    const wrapper = mountCompare()
    await wrapper.vm.$nextTick()
    document.body.appendChild(wrapper.element)
    // jsdom 无布局：为可聚焦元素标记 offsetParent（composable 须过滤隐藏元素）
    const buttons = wrapper.findAll('button')
    for (const b of buttons)
      Object.defineProperty(b.element, 'offsetParent', {
        value: document.body,
      })
    const panel = wrapper.find('.compare-panel')
    const first = buttons[0].element
    const last = buttons[buttons.length - 1].element

    // 末元素 Tab → 循环回首元素
    last.focus()
    await panel.trigger('keydown', { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    // 首元素 Shift+Tab → 循环回末元素
    first.focus()
    await panel.trigger('keydown', { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    wrapper.element.remove()
    wrapper.unmount()
  })
})
