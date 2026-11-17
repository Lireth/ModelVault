// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import MetaTagsEditor from '../src/renderer/src/components/detail/MetaTagsEditor.vue'
import { replaceModels, state } from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * MetaTagsEditor 组件测试（F-5 自由标签即时编辑）：
 * - 非组合态回车添加标签（成功路径：提交并清空输入）
 * - 输入法组合态回车不提交（issue #59：确认中文候选词不误触发添加，
 *   输入框组合值保留，等下一次回车再提交）
 */

setupComponentTest()

const MODEL_ID = 'D:\\models\\a.safetensors'

/** 选中一个模型（selectedModel 由此派生，与生产约定一致经 replaceModels 包响应） */
function selectModel(tags = []) {
  replaceModels([
    {
      id: MODEL_ID,
      name: 'a',
      type: 'lora',
      tags,
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
  state.selectedId = MODEL_ID
}

function mountEditor() {
  return mount(MetaTagsEditor, { props: { form: { alias: '' } } })
}

/** 在标签输入框上派发 keydown（显式携带 isComposing） */
function pressEnter(inputEl, isComposing = false) {
  inputEl.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', isComposing, bubbles: true }),
  )
}

describe('MetaTagsEditor 自由标签添加（F-5）', () => {
  it('非组合态回车添加标签并清空输入', async () => {
    selectModel(['已有'])
    window.api.models.setModelTags = vi.fn((id, tags) =>
      Promise.resolve({ meta: { tags } }),
    )
    const wrapper = mountEditor()
    const input = wrapper.find('.tag-input')
    await input.setValue('新标签')
    pressEnter(input.element)
    await flushPromises()
    expect(window.api.models.setModelTags).toHaveBeenCalledWith(MODEL_ID, [
      '已有',
      '新标签',
    ])
    // 保存成功后输入清空，chip 列表展示新标签
    expect(input.element.value).toBe('')
    expect(wrapper.text()).toContain('新标签')
    wrapper.unmount()
  })

  it('输入法组合态回车不提交（isComposing 守卫），输入值保留', async () => {
    selectModel([])
    window.api.models.setModelTags = vi.fn()
    const wrapper = mountEditor()
    const input = wrapper.find('.tag-input')
    await input.setValue('中文')
    pressEnter(input.element, true)
    await flushPromises()
    expect(window.api.models.setModelTags).not.toHaveBeenCalled()
    // 组合态回车仅确认候选词：输入不被清空，不误添加旧值
    expect(input.element.value).toBe('中文')
    expect(wrapper.text()).not.toContain('中文')
    wrapper.unmount()
  })
})
