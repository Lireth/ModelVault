// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { flushPromises, mount } from '@vue/test-utils'
import TopBar from '../src/renderer/src/components/TopBar.vue'
import { state } from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * TopBar 窄屏操作菜单测试（OPT-16 基建；OPT-1 回归）：
 * 侧边栏操作区在 <960px 隐藏，标题栏 ☰ 菜单是替代入口——
 * 覆盖菜单开合、操作项派发、禁用态规则、外部点击/ESC 关闭、
 * 以及 JS matchMedia 断点与 Sidebar/TopBar CSS 断点的一致性（P0-8）。
 */

setupComponentTest()

function makeModel(id) {
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
    params: {
      steps: 20,
      cfgMin: 7,
      cfgMax: 7,
      sampler: 'euler',
      scheduler: 'normal',
      precision: 'FP16',
      resMin: 512,
      resMax: 1024,
    },
  }
}

function mountTopBar() {
  state.folder = 'D:\\models'
  state.models = [makeModel('m1')]
  return mount(TopBar)
}

describe('TopBar 窄屏操作菜单（OPT-1 回归）', () => {
  it('默认关闭；点击 ☰ 展开全部操作项', async () => {
    const wrapper = mountTopBar()
    expect(wrapper.find('.narrow-actions-menu').exists()).toBe(false)
    await wrapper.find('.narrow-actions-btn').trigger('click')
    expect(wrapper.find('.narrow-actions-menu').exists()).toBe(true)
    const items = wrapper.findAll('.menu-item')
    expect(items).toHaveLength(2)
    expect(items.map((i) => i.text())).toEqual(['重新扫描', '选择文件夹'])
  })

  it('「选择文件夹」恒可达：空库（未配置过文件夹）时仍可调用', async () => {
    state.folder = ''
    state.models = []
    const wrapper = mountTopBar()
    await wrapper.find('.narrow-actions-btn').trigger('click')
    const items = wrapper.findAll('.menu-item')
    expect(items[1].attributes('disabled')).toBeUndefined()
    await items[1].trigger('click')
    expect(window.api.models.chooseFolder).toHaveBeenCalled()
  })

  it('禁用态与侧边栏按钮同规则：无模型/无文件夹时置灰', async () => {
    const wrapper = mountTopBar()
    // 在展开菜单前置空库状态（mountTopBar 会写入默认库与模型）
    state.folder = ''
    state.models = []
    await wrapper.find('.narrow-actions-btn').trigger('click')
    const items = wrapper.findAll('.menu-item')
    expect(items[0].attributes('disabled')).toBeDefined() // 重新扫描（无文件夹）
    expect(items[1].attributes('disabled')).toBeUndefined() // 选择文件夹恒可用
  })

  it('点击菜单外部区域关闭', async () => {
    const wrapper = mountTopBar()
    await wrapper.find('.narrow-actions-btn').trigger('click')
    expect(wrapper.find('.narrow-actions-menu').exists()).toBe(true)
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(wrapper.find('.narrow-actions-menu').exists()).toBe(false)
  })

  it('ESC 关闭菜单', async () => {
    const wrapper = mountTopBar()
    await wrapper.find('.narrow-actions-btn').trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper.find('.narrow-actions-menu').exists()).toBe(false)
  })

  it('再次点击 ☰ 收起菜单', async () => {
    const wrapper = mountTopBar()
    const btn = wrapper.find('.narrow-actions-btn')
    await btn.trigger('click')
    await btn.trigger('click')
    expect(wrapper.find('.narrow-actions-menu').exists()).toBe(false)
  })

  it('窄屏断点三方一致：JS matchMedia 与 TopBar/Sidebar 的 CSS 媒体查询同为 960px（P0-8）', () => {
    mountTopBar()
    // 组件 setup 监听的断点值（jsdom 的 matchMedia 桩记录调用参数）
    const calls = window.matchMedia.mock.calls.map((c) => String(c[0]))
    const bpCall = calls.find((c) => c.includes('max-width'))
    expect(bpCall).toBeDefined()
    // 与窗口 minWidth=960 对齐（100% DPI 下拖到最窄即可触达）
    expect(bpCall).toBe('(max-width: 960px)')
    const bp = bpCall.match(/(\d+)px/)[1]
    // JS 断点必须与两处 CSS 断点一致：漂移会出现「按钮已隐藏而菜单
    // 无法经断点回调收起」（原 JS 900px / CSS 960px 即此缺陷）
    const topBarSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/renderer/src/components/TopBar.vue'),
      'utf-8',
    )
    const sidebarSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/renderer/src/components/Sidebar.vue'),
      'utf-8',
    )
    expect(topBarSrc).toContain(`@media (max-width: ${bp}px)`)
    expect(sidebarSrc).toContain(`@media (max-width: ${bp}px)`)
  })
})
