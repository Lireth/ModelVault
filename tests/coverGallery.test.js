// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import CoverGallery from '../src/renderer/src/components/detail/CoverGallery.vue'
import { state } from '../src/renderer/src/store/appStore'
import { setupComponentTest, settle } from './helpers/componentTest'

/**
 * CoverGallery 全屏画廊组件测试：
 * - 渲染与切换：initialIndex、方向键循环、索引展示
 * - 快捷键：Esc 关闭（捕获阶段阻断，不穿透详情页）、Delete 删除、D 设默认、
 *   +/-//0 缩放控制；确认层可见时整键让位（F1）
 * - 缩放/平移：按钮与滚轮缩放、双击切换、拖拽平移
 * - 封面集合变化：删空自动关闭、索引钳制
 */

setupComponentTest()

/** 构造封面列表 */
function makeCovers(n) {
  return Array.from({ length: n }, (_, i) => ({
    rel: `c${i}.png`,
    path: `/lib/c${i}.png`,
    url: `mvimg://local/c${i}.png`
  }))
}

function mountGallery(props = {}) {
  return mount(CoverGallery, {
    props: {
      covers: makeCovers(3),
      defaultPath: '/lib/c0.png',
      initialIndex: 0,
      busy: false,
      ...props
    },
    global: {
      // Teleport 桩：画廊内容保留在 wrapper 树内（生产仍 Teleport 到 body）
      stubs: { teleport: true }
    }
  })
}

/** 在 window 派发 keydown（组件经捕获阶段监听） */
function pressKey(key) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  window.dispatchEvent(event)
  return event
}

/**
 * 手动构造鼠标/滚轮事件（jsdom 的 MouseEvent 属性只读，VTU trigger 无法注入
 * clientX/button 等坐标键位；pointer 系事件 jsdom 无构造器，以 MouseEvent 代发）
 */
function fireMouse(el, type, init = {}) {
  const Ctor = type === 'wheel' ? WheelEvent : MouseEvent
  el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, ...init }))
}

describe('CoverGallery 渲染与切换', () => {
  it('按 initialIndex 展示当前图与索引', () => {
    const wrapper = mountGallery({ initialIndex: 1 })
    expect(wrapper.find('.gallery-img').attributes('src')).toBe('mvimg://local/c1.png')
    expect(wrapper.find('.gallery-index').text()).toBe('2 / 3')
    wrapper.unmount()
  })

  it('方向键循环切换并复位缩放', async () => {
    const wrapper = mountGallery()
    pressKey('ArrowRight')
    await settle()
    expect(wrapper.find('.gallery-img').attributes('src')).toBe('mvimg://local/c1.png')
    pressKey('ArrowLeft')
    pressKey('ArrowLeft') // 0 → 循环到末位
    await settle()
    expect(wrapper.find('.gallery-img').attributes('src')).toBe('mvimg://local/c2.png')
    expect(wrapper.find('.gallery-index').text()).toBe('3 / 3')
    wrapper.unmount()
  })

  it('两侧按钮切换（多图时渲染）', async () => {
    const wrapper = mountGallery()
    expect(wrapper.find('.gallery-nav.prev').exists()).toBe(true)
    await wrapper.find('.gallery-nav.next').trigger('click')
    expect(wrapper.find('.gallery-img').attributes('src')).toBe('mvimg://local/c1.png')
    wrapper.unmount()
  })

  it('单图时不渲染切换按钮，方向键无操作', async () => {
    const wrapper = mountGallery({ covers: makeCovers(1) })
    expect(wrapper.find('.gallery-nav').exists()).toBe(false)
    pressKey('ArrowRight')
    await settle()
    expect(wrapper.find('.gallery-index').text()).toBe('1 / 1')
    wrapper.unmount()
  })
})

describe('CoverGallery 快捷键', () => {
  it('Esc 触发 close 且事件不穿透（阻止冒泡到详情页监听）', () => {
    const bubbleSpy = vi.fn()
    window.addEventListener('keydown', bubbleSpy) // 冒泡阶段（模拟详情页监听）
    const wrapper = mountGallery()
    const event = pressKey('Escape')
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(event.defaultPrevented).toBe(true)
    expect(bubbleSpy).not.toHaveBeenCalled()
    window.removeEventListener('keydown', bubbleSpy)
    wrapper.unmount()
  })

  it('Delete 发出 delete 事件（携带当前封面）；busy 时不发', async () => {
    const wrapper = mountGallery()
    pressKey('Delete')
    expect(wrapper.emitted('delete')).toHaveLength(1)
    expect(wrapper.emitted('delete')[0][0].path).toBe('/lib/c0.png')

    await wrapper.setProps({ busy: true })
    pressKey('Delete')
    expect(wrapper.emitted('delete')).toHaveLength(1)
    wrapper.unmount()
  })

  it('D 在非默认图时发出 set-default；已是默认图不发', async () => {
    const wrapper = mountGallery()
    pressKey('d') // 当前 c0 即默认图
    expect(wrapper.emitted('set-default')).toBeUndefined()

    pressKey('ArrowRight')
    await settle()
    pressKey('d')
    expect(wrapper.emitted('set-default')).toHaveLength(1)
    expect(wrapper.emitted('set-default')[0][0].path).toBe('/lib/c1.png')
    wrapper.unmount()
  })

  it('确认层可见时快捷键整键让位（删除确认期间 Esc 不关画廊）', () => {
    state.confirm.visible = true
    const wrapper = mountGallery()
    pressKey('Escape')
    pressKey('Delete')
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(wrapper.emitted('delete')).toBeUndefined()
    wrapper.unmount()
  })
})

describe('CoverGallery 缩放与平移', () => {
  it('工具栏 +/- 缩放与 0 复位', async () => {
    const wrapper = mountGallery()
    const btns = wrapper.findAll('.gallery-toolbar .gallery-btn')
    // 工具栏按钮序：缩小 / 放大 / 复位 / 设默认 / 删除
    await btns[1].trigger('click') // 放大 ×1.25
    expect(wrapper.find('.gallery-zoom').text()).toBe('125%')
    pressKey('-') // ÷1.25 → 100%
    await settle()
    expect(wrapper.find('.gallery-zoom').text()).toBe('100%')
    pressKey('+')
    await settle()
    expect(wrapper.find('.gallery-zoom').text()).toBe('125%')
    pressKey('0')
    await settle()
    expect(wrapper.find('.gallery-zoom').text()).toBe('100%')
    wrapper.unmount()
  })

  it('滚轮以光标为锚缩放', async () => {
    const wrapper = mountGallery()
    const el = wrapper.find('.gallery-overlay').element
    fireMouse(el, 'wheel', { deltaY: -120, clientX: 100, clientY: 50 })
    await settle()
    expect(wrapper.find('.gallery-zoom').text()).toBe('115%')
    fireMouse(el, 'wheel', { deltaY: 120, clientX: 100, clientY: 50 })
    await settle()
    expect(wrapper.find('.gallery-zoom').text()).toBe('100%')
    wrapper.unmount()
  })

  it('双击在 2.5 倍与适应间切换', async () => {
    const wrapper = mountGallery()
    const el = wrapper.find('.gallery-overlay').element
    fireMouse(el, 'dblclick', { clientX: 0, clientY: 0 })
    await settle()
    expect(wrapper.find('.gallery-zoom').text()).toBe('250%')
    fireMouse(el, 'dblclick', { clientX: 0, clientY: 0 })
    await settle()
    expect(wrapper.find('.gallery-zoom').text()).toBe('100%')
    wrapper.unmount()
  })

  it('拖拽平移更新 transform，切换图片后归零', async () => {
    const wrapper = mountGallery()
    const el = wrapper.find('.gallery-overlay').element
    fireMouse(el, 'pointerdown', { button: 0, clientX: 100, clientY: 100 })
    fireMouse(el, 'pointermove', { clientX: 160, clientY: 130 })
    await settle()
    expect(wrapper.find('.gallery-img').attributes('style')).toContain('translate(60px, 30px)')
    fireMouse(el, 'pointerup')
    pressKey('ArrowRight')
    await settle()
    expect(wrapper.find('.gallery-img').attributes('style')).toContain('translate(0px, 0px)')
    wrapper.unmount()
  })
})

describe('CoverGallery 封面集合变化', () => {
  it('索引越界时钳制到末位', async () => {
    const wrapper = mountGallery({ initialIndex: 2 })
    expect(wrapper.find('.gallery-index').text()).toBe('3 / 3')
    await wrapper.setProps({ covers: makeCovers(2) })
    await settle()
    expect(wrapper.find('.gallery-index').text()).toBe('2 / 2')
    wrapper.unmount()
  })

  it('删空时自动关闭画廊', async () => {
    const wrapper = mountGallery({ covers: makeCovers(1) })
    await wrapper.setProps({ covers: [] })
    await settle()
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })
})
