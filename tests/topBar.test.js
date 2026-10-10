// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import TopBar from '../src/renderer/src/components/TopBar.vue'
import { state } from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * TopBar 窄屏操作菜单测试（OPT-16 基建；OPT-1 回归）：
 * 侧边栏操作区在 <900px 隐藏，标题栏 ☰ 菜单是替代入口——
 * 覆盖菜单开合、六个操作项派发、禁用态规则、外部点击/ESC 关闭。
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
    triggerWords: ''
  }
}

function mountTopBar() {
  state.folder = 'D:\\models'
  state.models = [makeModel('m1')]
  return mount(TopBar)
}

describe('TopBar 窄屏操作菜单（OPT-1 回归）', () => {
  it('默认关闭；点击 ☰ 展开全部 6 个操作项', async () => {
    const wrapper = mountTopBar()
    expect(wrapper.find('.narrow-actions-menu').exists()).toBe(false)
    await wrapper.find('.narrow-actions-btn').trigger('click')
    expect(wrapper.find('.narrow-actions-menu').exists()).toBe(true)
    const items = wrapper.findAll('.menu-item')
    expect(items).toHaveLength(6)
    expect(items.map((i) => i.text())).toEqual([
      '重新扫描',
      '选择文件夹',
      '导出 CSV',
      '导出 JSON',
      '重复检测',
      '占用分析'
    ])
  })

  it('「占用分析」打开磁盘占用面板并关闭菜单（FEAT-1 入口）', async () => {
    const wrapper = mountTopBar()
    await wrapper.find('.narrow-actions-btn').trigger('click')
    await wrapper.findAll('.menu-item')[5].trigger('click')
    expect(state.diskUsage.open).toBe(true)
    expect(wrapper.find('.narrow-actions-menu').exists()).toBe(false)
  })

  it('「重复检测」打开检测面板（E5 入口）', async () => {
    const wrapper = mountTopBar()
    await wrapper.find('.narrow-actions-btn').trigger('click')
    await wrapper.findAll('.menu-item')[4].trigger('click')
    expect(state.dedupe.open).toBe(true)
    expect(wrapper.find('.narrow-actions-menu').exists()).toBe(false)
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

  it('「导出 CSV」携带当前列表行调用导出 IPC（E2）', async () => {
    const wrapper = mountTopBar()
    await wrapper.find('.narrow-actions-btn').trigger('click')
    await wrapper.findAll('.menu-item')[2].trigger('click')
    await flushPromises()
    expect(window.api.models.exportList).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'csv' })
    )
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
    expect(items[2].attributes('disabled')).toBeDefined() // 导出 CSV（无模型）
    expect(items[3].attributes('disabled')).toBeDefined() // 导出 JSON（无模型）
    expect(items[4].attributes('disabled')).toBeDefined() // 重复检测（无模型）
    expect(items[5].attributes('disabled')).toBeDefined() // 占用分析（无模型）
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
})
