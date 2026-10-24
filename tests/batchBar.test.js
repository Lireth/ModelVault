// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import BatchBar from '../src/renderer/src/components/BatchBar.vue'
import { replaceModels, state } from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * BatchBar 批量操作栏测试（UI 焕新：分组布局 +「更多」下拉 + 进度条）：
 * - 渲染条件（多选模式激活）与分组结构（选择组 / 常用组 / 更多下拉 / 危险区）
 * - 反选按钮的禁用态与点击效果（复用 store 反选语义）
 * - busy 期间的进度条与全栏禁用
 * - 更多下拉的开合（点击开 / 外部点击关 / Esc 关）与菜单项执行后收起
 */

setupComponentTest()

/** 注入 4 个 lora 模型（同类型使标签菜单项可用） */
function seedModels() {
  replaceModels(
    ['a', 'b', 'c', 'd'].map((name, i) => ({
      id: `D:\\models\\${name}.safetensors`,
      name,
      type: 'lora',
      size: 10 + i,
      mtimeMs: i + 1,
      favorite: false,
      nsfw: false,
      rating: 0,
      alias: '',
      note: '',
      subCategory: '',
      triggerWords: '',
      coverUrl: '',
      covers: []
    }))
  )
}

/** 挂载已激活多选的操作栏 */
async function mountBar() {
  seedModels()
  state.folder = 'D:\\models'
  state.multiSelect.active = true
  const wrapper = mount(BatchBar)
  await wrapper.vm.$nextTick()
  return wrapper
}

describe('BatchBar 渲染与分组', () => {
  beforeEach(() => {
    seedModels()
  })

  it('未进入多选模式时不渲染', () => {
    state.folder = 'D:\\models'
    state.multiSelect.active = false
    const wrapper = mount(BatchBar)
    expect(wrapper.find('.batch-bar').exists()).toBe(false)
  })

  it('多选模式渲染：选择组 / 危险区 / 已选计数', async () => {
    const wrapper = await mountBar()
    expect(wrapper.find('.batch-select-all').exists()).toBe(true)
    expect(wrapper.find('.batch-invert').exists()).toBe(true)
    expect(wrapper.find('.batch-count').text()).toContain('已选 0')
    // 危险区：移入回收站为唯一危险按钮，与常规操作分隔
    const danger = wrapper.find('.btn-danger')
    expect(danger.exists()).toBe(true)
    expect(danger.text()).toBe('移入回收站')
    expect(wrapper.text()).toContain('退出多选')
    wrapper.unmount()
  })

  it('busy 期间显示进度条与处理中文案，操作按钮全部禁用', async () => {
    const wrapper = await mountBar()
    state.multiSelect.ids = ['a', 'b']
    state.multiSelect.busy = true
    state.multiSelect.progress = '识别中 1/2'
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.batch-progress').exists()).toBe(true)
    expect(wrapper.find('.batch-busy').text()).toBe('识别中 1/2')
    expect(wrapper.find('.btn-danger').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
})

describe('BatchBar 反选按钮', () => {
  it('筛选结果为空时禁用', async () => {
    const wrapper = await mountBar()
    replaceModels([])
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.batch-invert').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('点击反选：筛选内选中态取反', async () => {
    const wrapper = await mountBar()
    state.multiSelect.ids = ['D:\\models\\a.safetensors', 'D:\\models\\c.safetensors']
    await wrapper.vm.$nextTick()
    await wrapper.find('.batch-invert').trigger('click')
    expect(state.multiSelect.ids).toEqual(['D:\\models\\b.safetensors', 'D:\\models\\d.safetensors'])
    wrapper.unmount()
  })
})

describe('BatchBar「更多」下拉', () => {
  it('默认收起，点击锚点展开菜单并含低频操作项', async () => {
    const wrapper = await mountBar()
    state.multiSelect.ids = ['a']
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.bb-menu').exists()).toBe(false)

    await wrapper.find('.bb-more .btn').trigger('click')
    expect(wrapper.find('.bb-menu').exists()).toBe(true)
    const items = wrapper.findAll('.bb-menu-item').map((w) => w.text())
    expect(items).toContain('填触发词')
    expect(items).toContain('识别 Civitai')
    expect(items).toContain('获取示例图')
    expect(items).toContain('批量编辑标签…')
    expect(items).toContain('禁用')
    wrapper.unmount()
  })

  it('点击「批量编辑标签…」收起菜单并打开标签编辑弹层', async () => {
    const wrapper = await mountBar()
    state.multiSelect.ids = ['D:\\models\\a.safetensors']
    await wrapper.vm.$nextTick()
    await wrapper.find('.bb-more .btn').trigger('click')
    const item = wrapper.findAll('.bb-menu-item').find((w) => w.text() === '批量编辑标签…')
    await item.trigger('click')
    expect(wrapper.find('.bb-menu').exists()).toBe(false)
    expect(document.body.querySelector('.bte-dialog')).not.toBeNull()
    wrapper.unmount()
  })

  it('点击菜单外部关闭', async () => {
    const wrapper = await mountBar()
    await wrapper.find('.bb-more .btn').trigger('click')
    expect(wrapper.find('.bb-menu').exists()).toBe(true)

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.bb-menu').exists()).toBe(false)
    wrapper.unmount()
  })

  it('Esc 关闭菜单（捕获阶段截断，不冒泡触发全局快捷键）', async () => {
    const wrapper = await mountBar()
    await wrapper.find('.bb-more .btn').trigger('click')
    expect(wrapper.find('.bb-menu').exists()).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.bb-menu').exists()).toBe(false)
    wrapper.unmount()
  })

  it('点击菜单项执行对应批量动作并收起菜单', async () => {
    const wrapper = await mountBar()
    state.multiSelect.ids = ['a']
    await wrapper.vm.$nextTick()
    await wrapper.find('.bb-more .btn').trigger('click')
    // 「填触发词」：无候选模型时走「均已有触发词或无候选」提示分支，仅验证调度与收起
    await wrapper.findAll('.bb-menu-item').find((w) => w.text() === '填触发词').trigger('click')
    expect(wrapper.find('.bb-menu').exists()).toBe(false)
    expect(state.toasts.some((t) => t.text.includes('均已有触发词或无自动解析候选'))).toBe(true)
    wrapper.unmount()
  })
})
