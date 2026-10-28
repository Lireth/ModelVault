// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { useVirtualScroll } from '../src/renderer/src/composables/useVirtualScroll'

/**
 * useVirtualScroll indexById 复用优化（PERF-3）：
 * - 派生数组引用变化但 id 序列一致（就地更新/重扫合并）→ 复用既有 Map，
 *   不重建（跳过 O(n) 哈希+分配）；
 * - id 序列真正变化（增删/重排/改 id）→ 重建且下标正确；
 * - 多实例间缓存互不串扰（缓存为实例级闭包变量）。
 */

/** ResizeObserver 桩（jsdom 缺失；composable onMounted 观察容器） */
beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

/** 最小宿主组件：透传 models 给 composable 并暴露 indexById */
const Host = defineComponent({
  props: { models: { type: Array, required: true } },
  setup(props) {
    const vs = useVirtualScroll({
      rowHeight: 40,
      rowCount: () => props.models.length,
      models: () => props.models,
      indexAtRow: (row) => row,
      rowOfIndex: (idx) => idx,
    })
    return { indexById: vs.indexById }
  },
  render() {
    return h(
      'div',
      this.models.map((m) => h('div', { key: m.id })),
    )
  },
})

function makeModel(id) {
  return { id, name: id, type: 'checkpoint', size: 1000 }
}

function mountHost(models) {
  return mount(Host, { props: { models } })
}

describe('useVirtualScroll indexById 复用（PERF-3）', () => {
  it('id 序列一致的新数组引用复用既有 Map', async () => {
    const wrapper = mountHost([makeModel('a'), makeModel('b')])
    const first = wrapper.vm.indexById
    expect(first.get('a')).toBe(0)
    expect(first.get('b')).toBe(1)

    // 引用不同、内容（id 序列）相同：就地更新场景——映射复用
    await wrapper.setProps({ models: [makeModel('a'), makeModel('b')] })
    expect(wrapper.vm.indexById).toBe(first)
  })

  it('id 序列变化时重建且下标正确', async () => {
    const wrapper = mountHost([makeModel('a'), makeModel('b')])
    const first = wrapper.vm.indexById

    // 重排：id 序列变化 → 重建
    await wrapper.setProps({ models: [makeModel('b'), makeModel('a')] })
    const second = wrapper.vm.indexById
    expect(second).not.toBe(first)
    expect(second.get('a')).toBe(1)
    expect(second.get('b')).toBe(0)

    // 增删：长度变化 → 重建
    await wrapper.setProps({
      models: [makeModel('b'), makeModel('a'), makeModel('c')],
    })
    const third = wrapper.vm.indexById
    expect(third).not.toBe(second)
    expect(third.size).toBe(3)
    expect(third.get('c')).toBe(2)
  })

  it('等长但中段 id 变化时重建（浅比较不误判复用）', async () => {
    const wrapper = mountHost([makeModel('a'), makeModel('b'), makeModel('c')])
    const first = wrapper.vm.indexById
    await wrapper.setProps({
      models: [makeModel('a'), makeModel('x'), makeModel('c')],
    })
    const second = wrapper.vm.indexById
    expect(second).not.toBe(first)
    expect(second.get('x')).toBe(1)
    expect(second.has('b')).toBe(false)
  })

  it('多实例缓存互不串扰', () => {
    const a = mountHost([makeModel('a')])
    const b = mountHost([makeModel('b')])
    expect(a.vm.indexById.has('a')).toBe(true)
    expect(b.vm.indexById.has('a')).toBe(false)
    expect(b.vm.indexById.get('b')).toBe(0)
    a.unmount()
    b.unmount()
  })
})
