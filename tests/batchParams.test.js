// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import BatchParamsEditor from '../src/renderer/src/components/BatchParamsEditor.vue'
import {
  batchEditParams,
  normalizeBatchParamsPatch,
  replaceModels,
  state,
} from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * 批量推荐参数（F5）：
 * - 纯函数：留空忽略、范围/区间校验、仅返回填写字段；
 * - 执行链路：补丁合并、无变化跳过、逐项失败明细、本地状态回填；
 * - 弹层：填写字段生成 apply 载荷、非法值留在弹层并提示、Esc 关闭。
 */

setupComponentTest()

/** 构造带推荐参数的模型 */
function model(id, params) {
  return {
    id,
    name: id,
    type: 'lora',
    size: 1000,
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
    params,
  }
}

/** 弹层 Teleport 到 body：直接查 DOM */
const $ = (selector) => document.body.querySelector(selector)

/** 给输入框赋值并触发 input（v-model） */
async function setInput(selector, value) {
  const input = $(selector)
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

describe('normalizeBatchParamsPatch（F5）', () => {
  it('留空字段忽略，仅返回填写字段并 trim 文本', () => {
    expect(
      normalizeBatchParamsPatch({
        steps: '28',
        cfgMin: '',
        cfgMax: '',
        sampler: ' euler ',
        scheduler: '',
        precision: '',
        resMin: '',
        resMax: '',
      }),
    ).toEqual({ patch: { steps: 28, sampler: 'euler' } })
  })

  it('范围/数字/区间顺序非法时返回可读错误', () => {
    expect(normalizeBatchParamsPatch({ steps: 0 }).error).toContain('采样步数')
    expect(normalizeBatchParamsPatch({ steps: 'abc' }).error).toContain(
      '有效数字',
    )
    expect(normalizeBatchParamsPatch({ cfgMin: 9, cfgMax: 4 }).error).toBe(
      'CFG 最小值不能大于最大值',
    )
    expect(
      normalizeBatchParamsPatch({ resMin: 2048, resMax: 1024 }).error,
    ).toBe('最小分辨率不能大于最大分辨率')
    expect(normalizeBatchParamsPatch({}).error).toBe('请至少填写一个推荐参数')
  })
})

describe('batchEditParams（F5）', () => {
  it('仅提交填写字段，并与各模型已有参数合并', async () => {
    const a = model('a', { steps: 20, sampler: 'euler', precision: 'FP16' })
    const b = model('b', { steps: 30, cfgMin: 4, cfgMax: 8 })
    replaceModels([a, b])
    state.multiSelect.ids = ['a', 'b']
    window.api.models.setModelParamsBulk.mockImplementation((items) =>
      Promise.resolve({
        updated: items.map(({ id, params }) => {
          const existing = state.models.find((m) => m.id === id)?.params || {}
          return { id, params: { ...existing, ...params } }
        }),
        failed: [],
      }),
    )

    const ok = await batchEditParams({ steps: '28', sampler: 'dpm++ 2m' })

    expect(ok).toBe(true)
    expect(window.api.models.setModelParamsBulk).toHaveBeenCalledWith([
      { id: 'a', params: { steps: 28, sampler: 'dpm++ 2m' } },
      { id: 'b', params: { steps: 28, sampler: 'dpm++ 2m' } },
    ])
    expect(state.models[0].params).toMatchObject({
      steps: 28,
      sampler: 'dpm++ 2m',
      precision: 'FP16',
    })
    expect(state.models[1].params).toMatchObject({
      steps: 28,
      sampler: 'dpm++ 2m',
      cfgMin: 4,
      cfgMax: 8,
    })
  })

  it('已具有相同参数值的模型跳过 IPC', async () => {
    replaceModels([model('a', { steps: 28 }), model('b', { steps: 30 })])
    state.multiSelect.ids = ['a', 'b']
    window.api.models.setModelParamsBulk.mockResolvedValue({
      updated: [{ id: 'b', params: { steps: 28 } }],
      failed: [],
    })

    const ok = await batchEditParams({ steps: '28' })

    expect(ok).toBe(true)
    expect(window.api.models.setModelParamsBulk).toHaveBeenCalledWith([
      { id: 'b', params: { steps: 28 } },
    ])
    expect(state.models[0].params.steps).toBe(28)
    expect(state.models[1].params.steps).toBe(28)
  })

  it('逐项失败进入失败明细，成功项仍回填本地状态', async () => {
    replaceModels([model('a', {}), model('b', {})])
    state.multiSelect.ids = ['a', 'b']
    window.api.models.setModelParamsBulk.mockResolvedValue({
      updated: [{ id: 'a', params: { steps: 28 } }],
      failed: [{ id: 'b', error: '模型不在当前根目录内' }],
    })

    const ok = await batchEditParams({ steps: '28' })

    expect(ok).toBe(true)
    expect(state.models[0].params.steps).toBe(28)
    expect(state.multiSelect.failures?.items).toEqual([
      { id: 'b', name: 'b', error: '模型不在当前根目录内' },
    ])
  })

  it('非法补丁在发起 IPC 前被拒绝', async () => {
    replaceModels([model('a', {})])
    state.multiSelect.ids = ['a']

    expect(await batchEditParams({ steps: 0 })).toBe(false)
    expect(window.api.models.setModelParamsBulk).not.toHaveBeenCalled()
    expect(state.toasts.some((t) => t.text.includes('采样步数'))).toBe(true)
  })
})

describe('BatchParamsEditor（F5）', () => {
  beforeEach(() => {
    replaceModels([model('a', {}), model('b', {})])
    state.multiSelect.ids = ['a', 'b']
  })

  it('填写字段提交为补丁；留空字段不进入载荷', async () => {
    const wrapper = mount(BatchParamsEditor)
    await nextTick()

    await setInput('input[placeholder="留空不修改，如 28"]', '28')
    await setInput('input[list="bpe-sampler-list"]', ' euler ')

    $('.bpe-actions .btn-primary').click()
    await nextTick()

    expect(wrapper.emitted('apply')).toEqual([
      [{ steps: 28, sampler: 'euler' }],
    ])
    wrapper.unmount()
  })

  it('非法值留在弹层并提示，不发出 apply', async () => {
    const wrapper = mount(BatchParamsEditor)
    await nextTick()

    await setInput('input[placeholder="留空不修改，如 28"]', '999')
    $('.bpe-actions .btn-primary').click()
    await nextTick()

    expect(wrapper.emitted('apply')).toBeUndefined()
    expect(state.toasts.some((t) => t.text.includes('采样步数'))).toBe(true)
    expect(document.body.querySelector('.bpe-dialog')).not.toBeNull()
    wrapper.unmount()
  })

  it('Esc 关闭弹层', async () => {
    const wrapper = mount(BatchParamsEditor)
    await nextTick()

    $('.bpe-dialog').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await nextTick()

    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })
})
