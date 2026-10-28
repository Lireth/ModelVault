// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { computed, defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { useDialogFocus } from '../src/renderer/src/composables/useDialogFocus'
import StatsPage from '../src/renderer/src/components/StatsPage.vue'
import { setupComponentTest } from './helpers/componentTest'

/**
 * useDialogFocus 统一焦点管理（O10/OPT-03）：
 * - isOpen 驱动的焦点进出（打开入容器、关闭归还触发元素）；
 * - Tab 焦点陷阱（模态容器内首末循环）与 trap=false（页面级视图）；
 * - 打开态卸载时归还焦点；
 * - StatsPage 页面级接入（挂载焦点入容器、卸载归还、region 语义）。
 */

setupComponentTest()

/** 最小对话框宿主：容器 + 两个可聚焦按钮 */
const Host = defineComponent({
  props: { open: { type: Boolean, default: false } },
  setup(props) {
    const { containerRef, onContainerKeydown } = useDialogFocus({
      isOpen: computed(() => props.open),
    })
    return () =>
      h(
        'div',
        {
          ref: containerRef,
          tabindex: '-1',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '测试对话框',
          onKeydown: onContainerKeydown,
        },
        [h('button', { id: 'b1' }, '一'), h('button', { id: 'b2' }, '二')],
      )
  },
})

/** 附加真实挂载并标记按钮可见（jsdom 无布局，offsetParent 恒为 null） */
function attachHost(props = {}) {
  const wrapper = mount(Host, { props })
  document.body.appendChild(wrapper.element)
  for (const b of wrapper.findAll('button'))
    Object.defineProperty(b.element, 'offsetParent', {
      value: document.body,
    })
  return wrapper
}

describe('useDialogFocus isOpen 焦点进出', () => {
  it('打开焦点移入容器，关闭归还触发元素', async () => {
    const wrapper = attachHost()
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    await wrapper.setProps({ open: true })
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(wrapper.find('[role="dialog"]').element)

    await wrapper.setProps({ open: false })
    await nextTick()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
    wrapper.element.remove()
    wrapper.unmount()
  })

  it('打开态下组件卸载同样归还焦点（父级 v-if 收起/页面切换）', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()

    // 先挂载后打开：watch 依赖 open 的 false→true 转变触发焦点进入
    const wrapper = attachHost()
    await wrapper.setProps({ open: true })
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(wrapper.find('[role="dialog"]').element)

    wrapper.unmount()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })
})

describe('useDialogFocus Tab 焦点陷阱', () => {
  it('Tab 在容器内首末循环（页面级视图经 trap=false 关闭拦截）', async () => {
    const wrapper = attachHost({ open: true })
    await nextTick()
    const container = wrapper.find('[role="dialog"]').element
    const b1 = wrapper.find('#b1').element
    const b2 = wrapper.find('#b2').element

    // 末元素 Tab → 循环回首元素
    b2.focus()
    await container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
    expect(document.activeElement).toBe(b1)
    // 首元素 Shift+Tab → 循环回末元素
    b1.focus()
    await container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }),
    )
    expect(document.activeElement).toBe(b2)

    wrapper.element.remove()
    wrapper.unmount()
  })
})

describe('StatsPage 页面级焦点接入（O10/OPT-03）', () => {
  it('挂载焦点移入页面容器并带 region 语义，卸载归还触发元素', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()

    const wrapper = mount(StatsPage, {
      global: { stubs: { CrossLibraryOverview: true, StatsSection: true } },
    })
    document.body.appendChild(wrapper.element)
    await nextTick()
    await nextTick()

    const page = wrapper.find('.stats-page')
    expect(page.attributes('role')).toBe('region')
    expect(page.attributes('aria-label')).toBe('库统计')
    expect(document.activeElement).toBe(page.element)

    wrapper.unmount()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })
})
