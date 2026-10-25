// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { mount } from '@vue/test-utils'
import VirtualModelList from '../src/renderer/src/components/VirtualModelList.vue'
import { acceptConfirm, state } from '../src/renderer/src/store/appStore'
import { setupComponentTest, settle } from './helpers/componentTest'

/**
 * VirtualModelList 紧凑列表视图测试：
 * - 虚拟滚动窗口数学（固定行高 36px、缓冲行、滚动驱动起始索引与钳制）
 * - 键盘导航（↑↓←→/Home/End）与行激活（Enter 打开详情/多选切换）
 * - 焦点行快捷动作（F 收藏 / Delete 删除含焦点顺延，与网格共用 modelRowActions）
 * - 列随设置项显隐（showSize/showMtime/showParams 与卡片同一开关）
 * - 行内容（分类+二级标签、评分星、备注名优先）
 *
 * jsdom 无布局：clientHeight/scrollTop 经 defineProperty 注入，
 * ResizeObserver 以捕获回调的桩替代（手动触发 measure）。
 */

setupComponentTest()

beforeAll(() => {
  if (!globalThis.CSS || typeof globalThis.CSS.escape !== 'function') {
    globalThis.CSS = { escape: (s) => String(s) }
  }
})

beforeEach(() => {
  // ResizeObserver 桩（jsdom 缺失；列表挂载即测量，无需手动触发）
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

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
    params: null,
    coverUrl: '',
    covers: [],
    ...overrides,
  }
}

function makeModels(n) {
  return Array.from({ length: n }, (_, i) => makeModel(`m${i}`))
}

/** 等待 rAF 合帧（滚动位置写入经 rAF 节流） */
function nextFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve())
    } else {
      setTimeout(resolve, 0)
    }
  })
}

/** 挂载到带滚动条的容器（findScrollParent 依赖 overflow-y） */
function mountInScroller(models) {
  const container = document.createElement('div')
  container.style.overflowY = 'auto'
  container.style.height = '600px'
  document.body.appendChild(container)
  Object.defineProperty(container, 'clientHeight', {
    value: 600,
    configurable: true,
  })
  Object.defineProperty(container, 'scrollTop', {
    value: 0,
    writable: true,
    configurable: true,
  })
  const wrapper = mount(VirtualModelList, {
    props: { models },
    attachTo: container,
  })
  return { wrapper, container }
}

/** 聚焦指定模型行 */
function focusRow(wrapper, id) {
  wrapper.element
    .querySelector(`[data-model-id="${globalThis.CSS.escape(id)}"]`)
    ?.focus()
}

/** 滚动到指定位置并等待 rAF 落定 */
async function scrollTo(container, top) {
  container.scrollTop = top
  container.dispatchEvent(new Event('scroll'))
  await nextFrame()
}

describe('VirtualModelList 虚拟滚动窗口', () => {
  it('总高度 = 模型数 × 固定行高，仅渲染可视窗口 + 缓冲行', async () => {
    const models = makeModels(60)
    const { wrapper } = mountInScroller(models)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.virtual-list').element.style.height).toBe(
      `${60 * 36}px`,
    )
    // 窗口行数：ceil(600/36)=17 + 1 + 8*2 = 34
    const rows = wrapper.findAll('.list-row')
    expect(rows).toHaveLength(34)
    expect(rows[0].attributes('data-model-id')).toBe('m0')
    expect(rows[33].attributes('data-model-id')).toBe('m33')
    wrapper.unmount()
  })

  it('滚动驱动起始行（含缓冲），深滚后仅渲染附近行并钳制', async () => {
    const models = makeModels(60)
    const { wrapper, container } = mountInScroller(models)
    await wrapper.vm.$nextTick()
    await scrollTo(container, 36 * 20)
    await wrapper.vm.$nextTick()
    const rows = wrapper.findAll('.list-row')
    // start = 20 - 8（缓冲）= 12
    expect(rows[0].attributes('data-model-id')).toBe('m12')
    // 滚到底部：起始行钳制不越界
    await scrollTo(container, 36 * 100)
    await wrapper.vm.$nextTick()
    const tail = wrapper.findAll('.list-row')
    expect(tail[tail.length - 1].attributes('data-model-id')).toBe('m59')
    wrapper.unmount()
  })

  it('空列表：高度为 0 且不渲染任何行', async () => {
    const { wrapper } = mountInScroller([])
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.virtual-list').element.style.height).toBe('0px')
    expect(wrapper.findAll('.list-row')).toHaveLength(0)
    wrapper.unmount()
  })
})

describe('VirtualModelList 键盘导航与行激活', () => {
  it('方向键在行间移动焦点（↓/→ 下一行，↑/← 上一行，Home/End 跳首末行）', async () => {
    const models = makeModels(20)
    const { wrapper } = mountInScroller(models)
    await wrapper.vm.$nextTick()
    focusRow(wrapper, 'm2')
    await wrapper.find('.virtual-list').trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement?.getAttribute('data-model-id')).toBe('m3')
    await wrapper.find('.virtual-list').trigger('keydown', { key: 'ArrowUp' })
    expect(document.activeElement?.getAttribute('data-model-id')).toBe('m2')
    await wrapper.find('.virtual-list').trigger('keydown', { key: 'End' })
    expect(document.activeElement?.getAttribute('data-model-id')).toBe('m19')
    await wrapper.find('.virtual-list').trigger('keydown', { key: 'Home' })
    expect(document.activeElement?.getAttribute('data-model-id')).toBe('m0')
    wrapper.unmount()
  })

  it('无焦点时按方向键聚焦第一行', async () => {
    const { wrapper } = mountInScroller(makeModels(20))
    await wrapper.vm.$nextTick()
    await wrapper.find('.virtual-list').trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement?.getAttribute('data-model-id')).toBe('m0')
    wrapper.unmount()
  })

  it('Enter 打开详情；多选模式下 Enter 切换选中', async () => {
    const models = makeModels(5)
    state.models = models
    const { wrapper } = mountInScroller(models)
    await wrapper.vm.$nextTick()
    // 行激活在行级处理（与卡片 article 的 Enter/Space 同一模式）
    await wrapper
      .find('[data-model-id="m1"]')
      .trigger('keydown', { key: 'Enter' })
    expect(state.selectedId).toBe('m1')

    state.selectedId = null
    state.multiSelect.active = true
    await wrapper
      .find('[data-model-id="m1"]')
      .trigger('keydown', { key: 'Enter' })
    expect(state.multiSelect.ids).toEqual(['m1'])
    expect(state.selectedId).toBeNull()
    wrapper.unmount()
  })

  it('点击行打开详情；多选模式点击勾选框只切换选中', async () => {
    const models = makeModels(5)
    state.models = models
    state.multiSelect.active = true
    const { wrapper } = mountInScroller(models)
    await wrapper.vm.$nextTick()
    const check = wrapper.find('.row-check')
    await check.trigger('click')
    expect(state.multiSelect.ids).toEqual(['m0'])
    expect(state.selectedId).toBeNull()
    wrapper.unmount()
  })

  it('Ctrl+点击行：非多选模式进入多选并选中，不打开详情', async () => {
    const models = makeModels(5)
    state.models = models
    const { wrapper } = mountInScroller(models)
    await wrapper.vm.$nextTick()
    await wrapper
      .find('[data-model-id="m1"]')
      .trigger('click', { ctrlKey: true })
    expect(state.multiSelect.active).toBe(true)
    expect(state.multiSelect.ids).toEqual(['m1'])
    expect(state.selectedId).toBeNull()
    wrapper.unmount()
  })

  it('多选模式 Ctrl+点击切换选中；Shift+点击按锚点范围选中', async () => {
    const models = makeModels(5)
    state.models = models
    state.multiSelect.active = true
    const { wrapper } = mountInScroller(models)
    await wrapper.vm.$nextTick()
    const row = wrapper.find('[data-model-id="m1"]')
    await row.trigger('click', { ctrlKey: true })
    expect(state.multiSelect.ids).toEqual(['m1'])
    // Ctrl+点击已设锚 m1：Shift+点击 m3 选中 m1..m3 范围（store 层语义在 multiselect.test.js 覆盖）
    await wrapper
      .find('[data-model-id="m3"]')
      .trigger('click', { shiftKey: true })
    expect(state.multiSelect.ids).toEqual(['m1', 'm2', 'm3'])
    wrapper.unmount()
  })

  it('Shift+点击行：非多选模式进入多选并选中', async () => {
    const models = makeModels(5)
    state.models = models
    const { wrapper } = mountInScroller(models)
    await wrapper.vm.$nextTick()
    await wrapper
      .find('[data-model-id="m2"]')
      .trigger('click', { shiftKey: true })
    expect(state.multiSelect.active).toBe(true)
    expect(state.multiSelect.ids).toEqual(['m2'])
    expect(state.selectedId).toBeNull()
    wrapper.unmount()
  })
})

describe('VirtualModelList 焦点行快捷动作', () => {
  it('F 收藏焦点行', async () => {
    window.api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: true, nsfw: false, rating: 0 },
    })
    const models = makeModels(5)
    state.models = models
    const { wrapper } = mountInScroller(models)
    await wrapper.vm.$nextTick()
    focusRow(wrapper, 'm2')
    await wrapper.find('.virtual-list').trigger('keydown', { key: 'f' })
    await settle()
    expect(window.api.models.setMetaFlags).toHaveBeenCalledWith({
      id: 'm2',
      favorite: true,
    })
    wrapper.unmount()
  })

  it('Delete 确认后删除焦点行，焦点顺延到下一行', async () => {
    window.api.models.deleteModel.mockResolvedValue({})
    const models = makeModels(5)
    state.models = models
    const { wrapper } = mountInScroller(models)
    await wrapper.vm.$nextTick()
    focusRow(wrapper, 'm1')
    await wrapper.find('.virtual-list').trigger('keydown', { key: 'Delete' })
    expect(state.confirm.visible).toBe(true)
    expect(window.api.models.deleteModel).not.toHaveBeenCalled()
    acceptConfirm()
    await settle()
    expect(window.api.models.deleteModel).toHaveBeenCalledWith('m1')
    expect(document.activeElement?.getAttribute('data-model-id')).toBe('m2')
    wrapper.unmount()
  })
})

describe('VirtualModelList 列显隐与行内容', () => {
  it('列随设置项显隐（表头与行单元格同步）', async () => {
    const models = makeModels(3)
    const { wrapper } = mountInScroller(models)
    await wrapper.vm.$nextTick()
    // 默认全显：名称/分类/大小/修改日期/评分/推荐参数
    expect(wrapper.findAll('.list-header-cell')).toHaveLength(6)
    state.settings.showSize = false
    state.settings.showParams = false
    await wrapper.vm.$nextTick()
    const headers = wrapper.findAll('.list-header-cell')
    expect(headers.map((h) => h.text())).toEqual([
      '名称',
      '分类',
      '修改日期',
      '评分',
    ])
    expect(wrapper.find('.col-size').exists()).toBe(false)
    expect(wrapper.find('.col-params').exists()).toBe(false)
    wrapper.unmount()
  })

  it('行内容：分类含二级标签、评分星、备注名优先、参数摘要', async () => {
    const models = [
      makeModel('m0', {
        alias: '我的 LoRA',
        type: 'lora',
        subCategory: 'role',
        rating: 3,
        params: {
          steps: 28,
          cfgMin: 5,
          cfgMax: 7,
          sampler: 'DPM++ 2M',
          resMin: 768,
          resMax: 1024,
        },
      }),
      makeModel('m1', { rating: 0 }),
    ]
    const { wrapper } = mountInScroller(models)
    await wrapper.vm.$nextTick()
    const rows = wrapper.findAll('.list-row')
    expect(rows[0].find('.row-name').text()).toBe('我的 LoRA')
    expect(rows[0].find('.col-type').text()).toBe('LoRA · 角色')
    expect(rows[0].find('.col-rating').text()).toBe('★★★☆☆')
    expect(rows[0].find('.col-params').text()).toBe(
      '28 步 · CFG 5~7 · DPM++ 2M · 768~1024px',
    )
    expect(rows[1].find('.col-rating').text()).toBe('—')
    expect(rows[1].find('.col-params').text()).toBe('未设置推荐参数')
    wrapper.unmount()
  })
})
