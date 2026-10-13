// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll } from 'vitest'
import { mount } from '@vue/test-utils'
import VirtualModelGrid from '../src/renderer/src/components/VirtualModelGrid.vue'
import { state } from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * VirtualModelGrid 组件测试（OPT-21）：
 * 虚拟滚动的行级数学是全项目最复杂的前端算法，此前零防护——
 * 覆盖列数推导（容器宽度 × 卡片尺寸预设）、行距估算、可见窗口切片、
 * 滚动位置驱动的起始行与钳制、键盘网格导航（E10）。
 *
 * jsdom 无布局：clientWidth/clientHeight/scrollTop 经 defineProperty 注入，
 * ResizeObserver 以捕获回调的桩替代（手动触发 measure）。
 */

setupComponentTest()

/** 行距估算的预期值（estimateRowPitch：min*1.5 + 72 + gap，四舍五入） */
const ROW_PITCH = { compact: 307, normal: 371, large: 450 }
/** 默认视口高度下的可见行数（ceil(600/rowPitch) + 1 + 3*2） */
const VISIBLE_ROWS = 9

/** ResizeObserver 桩：捕获回调供手动触发 */
let resizeCallback = null

beforeAll(() => {
  // CSS.escape 在 querySelector 聚焦路径上使用；jsdom 缺失时退化为恒等
  if (!globalThis.CSS || typeof globalThis.CSS.escape !== 'function') {
    globalThis.CSS = { escape: (s) => String(s) }
  }
})

beforeEach(() => {
  resizeCallback = null
  globalThis.ResizeObserver = class {
    constructor(cb) {
      resizeCallback = cb
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

/** 构造最小模型对象 */
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
    coverUrl: '',
    covers: []
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
function mountInScroller(models, cardSize = 'normal') {
  state.settings.cardSize = cardSize
  const container = document.createElement('div')
  container.style.overflowY = 'auto'
  container.style.height = '600px'
  document.body.appendChild(container)
  Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true })
  Object.defineProperty(container, 'scrollTop', { value: 0, writable: true, configurable: true })
  const wrapper = mount(VirtualModelGrid, { props: { models }, attachTo: container })
  return { wrapper, container }
}

/** 为根元素注入容器宽度并触发 ResizeObserver → measure */
async function setContainerWidth(wrapper, width) {
  Object.defineProperty(wrapper.element, 'clientWidth', { value: width, configurable: true })
  resizeCallback?.()
  await wrapper.vm.$nextTick()
}

describe('VirtualModelGrid 虚拟滚动数学', () => {
  it('默认（无容器宽度）退化为单列，按可见窗口渲染 9 行', async () => {
    const models = makeModels(20)
    const { wrapper } = mountInScroller(models)
    await wrapper.vm.$nextTick()
    // 单列：20 行，仅渲染视口窗口内的 9 行
    expect(wrapper.findAll('.grid-row')).toHaveLength(VISIBLE_ROWS)
    expect(wrapper.findAll('.model-card')).toHaveLength(VISIBLE_ROWS)
    // 首行即第 0 个模型
    expect(wrapper.find('.model-card').attributes('data-model-id')).toBe('m0')
    wrapper.unmount()
  })

  it('总高度 = 行数 × 行距 − 间距（行距随卡片尺寸预设变化）', async () => {
    const models = makeModels(20)
    for (const [size, pitch] of Object.entries(ROW_PITCH)) {
      const { wrapper } = mountInScroller(models, size)
      await wrapper.vm.$nextTick()
      const presetGap = { compact: 10, normal: 14, large: 18 }[size]
      expect(wrapper.element.style.height).toBe(`${20 * pitch - presetGap}px`)
      wrapper.unmount()
    }
  })

  it('空列表：高度为 0 且不渲染任何行', async () => {
    const { wrapper } = mountInScroller([])
    await wrapper.vm.$nextTick()
    expect(wrapper.element.style.height).toBe('0px')
    expect(wrapper.findAll('.grid-row')).toHaveLength(0)
    wrapper.unmount()
  })

  it('容器宽度驱动列数：1000px + normal 预设 → 4 列 5 行整行渲染', async () => {
    const models = makeModels(20)
    const { wrapper } = mountInScroller(models)
    await setContainerWidth(wrapper, 1000)
    // 5 行全部落入可见窗口（visibleRowCount=9 > rowCount=5）
    const rows = wrapper.findAll('.grid-row')
    expect(rows).toHaveLength(5)
    // 每行 4 张，共 20 张
    expect(wrapper.findAll('.model-card')).toHaveLength(20)
    // 首行/末行切片正确
    expect(rows[0].findAll('.model-card')[0].attributes('data-model-id')).toBe('m0')
    expect(rows[4].findAll('.model-card')[3].attributes('data-model-id')).toBe('m19')
    wrapper.unmount()
  })

  it('不整除时末行渲染剩余模型（22 个 / 4 列 → 末行 2 张）', async () => {
    const models = makeModels(22)
    const { wrapper } = mountInScroller(models)
    await setContainerWidth(wrapper, 1000)
    const rows = wrapper.findAll('.grid-row')
    expect(rows).toHaveLength(6)
    expect(rows[5].findAll('.model-card')).toHaveLength(2)
    expect(rows[5].findAll('.model-card')[1].attributes('data-model-id')).toBe('m21')
    wrapper.unmount()
  })

  it('滚动位置驱动起始行：深滚后仅渲染末尾行（钳制到 rowCount-1）', async () => {
    const models = makeModels(20)
    const { wrapper, container } = mountInScroller(models)
    await setContainerWidth(wrapper, 1000)
    // 4 列 5 行；scrollTop = 10 × 行距(371) → 原始起始行 7，钳制为 4
    container.scrollTop = 371 * 10
    container.dispatchEvent(new Event('scroll'))
    await nextFrame()
    await wrapper.vm.$nextTick()
    const rows = wrapper.findAll('.grid-row')
    expect(rows).toHaveLength(1)
    // 仅第 4 行（模型 16-19）
    expect(rows[0].findAll('.model-card')[0].attributes('data-model-id')).toBe('m16')
    expect(rows[0].findAll('.model-card')[3].attributes('data-model-id')).toBe('m19')
    wrapper.unmount()
  })

  it('顶部滚动不产生负起始行（overscan 前钳制为 0）', async () => {
    const models = makeModels(20)
    const { wrapper, container } = mountInScroller(models)
    await setContainerWidth(wrapper, 1000)
    // 半行内滚动：floor(100/371)=0 → 起始行 -3 → 钳制 0
    container.scrollTop = 100
    container.dispatchEvent(new Event('scroll'))
    await nextFrame()
    await wrapper.vm.$nextTick()
    const rows = wrapper.findAll('.grid-row')
    expect(rows).toHaveLength(5)
    expect(rows[0].findAll('.model-card')[0].attributes('data-model-id')).toBe('m0')
    wrapper.unmount()
  })
})

describe('VirtualModelGrid 键盘网格导航（E10）', () => {
  /** 聚焦指定模型卡片 */
  function focusCard(wrapper, id) {
    wrapper.element.querySelector(`[data-model-id="${globalThis.CSS.escape(id)}"]`)?.focus()
  }

  it('无焦点时按方向键聚焦第一张卡片', async () => {
    const { wrapper } = mountInScroller(makeModels(20))
    await wrapper.vm.$nextTick()
    await wrapper.find('.virtual-grid').trigger('keydown', { key: 'ArrowRight' })
    expect(document.activeElement?.getAttribute('data-model-id')).toBe('m0')
    wrapper.unmount()
  })

  it('方向键在网格内移动焦点（4 列布局）', async () => {
    const models = makeModels(20)
    const { wrapper } = mountInScroller(models)
    await setContainerWidth(wrapper, 1000)
    focusCard(wrapper, 'm0')
    await wrapper.find('.virtual-grid').trigger('keydown', { key: 'ArrowRight' })
    expect(document.activeElement?.getAttribute('data-model-id')).toBe('m1')
    focusCard(wrapper, 'm3')
    await wrapper.find('.virtual-grid').trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement?.getAttribute('data-model-id')).toBe('m7')
    await wrapper.find('.virtual-grid').trigger('keydown', { key: 'ArrowLeft' })
    expect(document.activeElement?.getAttribute('data-model-id')).toBe('m6')
    await wrapper.find('.virtual-grid').trigger('keydown', { key: 'ArrowUp' })
    expect(document.activeElement?.getAttribute('data-model-id')).toBe('m2')
    wrapper.unmount()
  })

  it('Home/End 跳到行首/行末', async () => {
    const models = makeModels(20)
    const { wrapper } = mountInScroller(models)
    await setContainerWidth(wrapper, 1000)
    focusCard(wrapper, 'm5')
    await wrapper.find('.virtual-grid').trigger('keydown', { key: 'Home' })
    expect(document.activeElement?.getAttribute('data-model-id')).toBe('m4')
    await wrapper.find('.virtual-grid').trigger('keydown', { key: 'End' })
    expect(document.activeElement?.getAttribute('data-model-id')).toBe('m7')
    wrapper.unmount()
  })

  it('边界钳制：行首按左/上不移出网格', async () => {
    const models = makeModels(20)
    const { wrapper } = mountInScroller(models)
    await setContainerWidth(wrapper, 1000)
    focusCard(wrapper, 'm0')
    await wrapper.find('.virtual-grid').trigger('keydown', { key: 'ArrowLeft' })
    expect(document.activeElement?.getAttribute('data-model-id')).toBe('m0')
    await wrapper.find('.virtual-grid').trigger('keydown', { key: 'ArrowUp' })
    expect(document.activeElement?.getAttribute('data-model-id')).toBe('m0')
    wrapper.unmount()
  })

  it('非导航键不改变焦点', async () => {
    const models = makeModels(20)
    const { wrapper } = mountInScroller(models)
    await setContainerWidth(wrapper, 1000)
    focusCard(wrapper, 'm2')
    await wrapper.find('.virtual-grid').trigger('keydown', { key: 'a' })
    expect(document.activeElement?.getAttribute('data-model-id')).toBe('m2')
    wrapper.unmount()
  })
})

describe('浏览位置锚（B7：局部重扫不把用户拉回顶部）', () => {
  /** 滚动到指定位置并等待 rAF 捕获浏览锚 */
  async function scrollTo(container, top) {
    container.scrollTop = top
    container.dispatchEvent(new Event('scroll'))
    await nextFrame()
  }

  it('锚前行有删除（局部重扫）后按可视区锚平移滚动位置，浏览不跳变', async () => {
    const models = makeModels(20)
    const { wrapper, container } = mountInScroller(models)
    await setContainerWidth(wrapper, 1000) // 4 列 × 5 行，行距 371

    // 滚动到第 2 行中部（792 = 371*2 + 50）：可视区首行锚 = m8（第 2 行首模型）
    await scrollTo(container, 371 * 2 + 50)

    // 局部重扫：锚之前的 4 个模型（m0..m3，恰好一整行）被删除/移走，
    // 锚 m8 从第 2 行（索引 8）上移到第 1 行（索引 4）
    const rescanned = models.slice(4)
    await wrapper.setProps({ models: rescanned })
    await wrapper.vm.$nextTick()

    // 滚动位置按锚的新行号平移一行，保留行内偏移 50 → 421。
    // 修复前：签名首项 id 变化即复位顶部，深位浏览被静默打断
    expect(container.scrollTop).toBe(371 + 50)
    // 锚模型回到可视区顶部行
    const rows = wrapper.findAll('.grid-row')
    const firstRendered = rows[0]?.findAll('.model-card')[0]?.attributes('data-model-id')
    expect(['m4', 'm5', 'm6', 'm7']).toContain(firstRendered)
    wrapper.unmount()
  })

  it('锚仍在新列表但行号未变时滚动位置纹丝不动（就地合并零扰动）', async () => {
    const models = makeModels(20)
    const { wrapper, container } = mountInScroller(models)
    await setContainerWidth(wrapper, 1000)
    await scrollTo(container, 371 * 2 + 50)

    // 列表尾部的增删（局部重扫常见）：锚行不受影响
    const rescanned = [...models.slice(0, 19), makeModel('m-new'), makeModel('m-new2')]
    await wrapper.setProps({ models: rescanned })
    await wrapper.vm.$nextTick()

    expect(container.scrollTop).toBe(371 * 2 + 50)
    wrapper.unmount()
  })

  it('锚已从新列表消失（筛选/搜索/删除）时复位顶部', async () => {
    const models = makeModels(20)
    const { wrapper, container } = mountInScroller(models)
    await setContainerWidth(wrapper, 1000)
    await scrollTo(container, 371 * 2 + 50) // 锚 = m8

    // 筛选条件变化：锚模型不在结果中，原位置无意义
    const filtered = models.filter((m) => m.id !== 'm8')
    await wrapper.setProps({ models: filtered })
    await wrapper.vm.$nextTick()

    expect(container.scrollTop).toBe(0)
    wrapper.unmount()
  })

  it('未滚动过（顶部浏览）时列表变化复位顶部，不产生滚动跳变', async () => {
    const models = makeModels(20)
    const { wrapper, container } = mountInScroller(models)
    await setContainerWidth(wrapper, 1000)
    expect(container.scrollTop).toBe(0)

    await wrapper.setProps({ models: [...models].reverse() })
    await wrapper.vm.$nextTick()

    expect(container.scrollTop).toBe(0)
    wrapper.unmount()
  })
})
