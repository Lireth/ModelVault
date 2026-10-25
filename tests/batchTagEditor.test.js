// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import BatchTagEditor from '../src/renderer/src/components/BatchTagEditor.vue'
import { replaceModels, state } from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * 批量标签编辑层（FEAT-01）组件测试：
 * - 输入回车/逗号分隔生成 chips
 * - 三种模式切换与替换警告
 * - 提交发出 apply 载荷；Esc 发出 close
 */

setupComponentTest()

beforeEach(() => {
  replaceModels([
    {
      id: 'D:\\models\\a.safetensors',
      name: 'a',
      type: 'lora',
      tags: ['已有'],
      size: 1,
      mtimeMs: 1,
      favorite: false,
      nsfw: false,
      rating: 0,
      alias: '',
      note: '',
      subCategory: '',
      triggerWords: '',
      coverUrl: '',
      covers: [],
    },
  ])
  state.multiSelect.ids = ['D:\\models\\a.safetensors']
})

/** 弹层 Teleport 到 body：直接查 DOM */
const $ = (selector) => document.body.querySelector(selector)

/** 给输入框赋值并触发 input（v-model） */
async function typeInput(value) {
  const input = $('.bte-input')
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  return input
}

describe('BatchTagEditor', () => {
  it('回车与逗号分隔输入生成标签 chips，提交发出 apply 载荷', async () => {
    const wrapper = mount(BatchTagEditor)
    await nextTick()

    let input = await typeInput('新标签')
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
    await nextTick()
    expect(document.body.textContent).toContain('新标签')

    input = await typeInput('风格, 角色')
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
    await nextTick()
    expect(document.body.querySelectorAll('.bte-chip')).toHaveLength(3)

    $('.bte-apply').click()
    await nextTick()
    expect(wrapper.emitted('apply')).toEqual([
      [{ mode: 'add', tags: ['新标签', '风格', '角色'] }],
    ])
    wrapper.unmount()
  })

  it('切换到替换模式显示警告，提交载荷携带 replace', async () => {
    const wrapper = mount(BatchTagEditor)
    await nextTick()

    const replaceRadio = document.body.querySelector(
      'input[type="radio"][value="replace"]',
    )
    replaceRadio.checked = true
    replaceRadio.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    expect(document.body.querySelector('.bte-warning')).not.toBeNull()
    expect($('.bte-apply').textContent).toContain('替换标签')

    const input = await typeInput('统一标签')
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    )
    await nextTick()
    $('.bte-apply').click()
    await nextTick()
    expect(wrapper.emitted('apply')[0][0]).toEqual({
      mode: 'replace',
      tags: ['统一标签'],
    })
    wrapper.unmount()
  })

  it('Esc 关闭弹层并发出 close', async () => {
    const wrapper = mount(BatchTagEditor)
    await nextTick()
    $('.bte-dialog').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await nextTick()
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })
})
