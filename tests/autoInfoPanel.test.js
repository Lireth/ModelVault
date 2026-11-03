// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import AutoInfoPanel from '../src/renderer/src/components/detail/AutoInfoPanel.vue'
import { replaceModels, state } from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * AutoInfoPanel 组件测试（C4 数据关键 UI 补齐）：
 * 自动解析信息此前仅 27% 覆盖率。本文件覆盖字段渲染、张量统计与组件占比、
 * 触发词候选、「填入推荐分辨率/触发词」事件载荷，以及 resMax 缺省回退。
 */

setupComponentTest()

/** 选中带 autoInfo 的模型（详情面板由 selectedModel 派生） */
function selectModel(autoInfo) {
  replaceModels([
    {
      id: 'm1',
      name: 'm1',
      type: 'lora',
      size: 1000,
      mtimeMs: 1000,
      autoInfo,
    },
  ])
  state.selectedId = 'm1'
}

/** 挂载面板并等待详情补全 watcher 落定（getDetail 桩返回空模型） */
async function mountPanel() {
  const wrapper = mount(AutoInfoPanel)
  await flushPromises()
  return wrapper
}

describe('AutoInfoPanel 渲染', () => {
  it('无 autoInfo 时不渲染面板', async () => {
    selectModel(null)
    const wrapper = await mountPanel()
    expect(wrapper.find('.autoinfo-panel').exists()).toBe(false)
    wrapper.unmount()
  })

  it('渲染训练元信息、张量统计与组件字节占比', async () => {
    selectModel({
      title: 'Test Model',
      author: 'Author',
      baseModel: 'SDXL',
      networkModule: 'LoRA',
      networkAlpha: null,
      precision: 'fp16',
      resMin: 512,
      resMax: 768,
      triggerCandidates: ['cat', 'dog'],
      tensorStats: {
        architecture: 'SDXL',
        paramCount: 1500000,
        tensorCount: 1234,
        dtypeMain: 'fp16',
        componentRatios: { textEncoder: 0.2, unet: 0.7, vae: 0.1 },
      },
    })
    const wrapper = await mountPanel()

    const text = wrapper.text()
    expect(text).toContain('文件元数据（自动解析）')
    expect(text).toContain('Test Model')
    expect(text).toContain('Author')
    expect(text).toContain('SDXL')
    expect(text).toContain('LoRA')
    // networkAlpha 为 null 时不展示 α
    expect(text).not.toContain('α=')
    expect(text).toContain('fp16')
    expect(text).toContain('512 × 768')
    expect(text).toContain('参数量')
    expect(text).toContain('1.5M')
    expect(text).toContain('个张量')
    expect(text).toContain('fp16 为主')
    // 组件占比：20 / 70 / 10
    expect(wrapper.find('.autoinfo-comp-legend').text()).toContain(
      '文本编码器 20% · UNet/DiT 70% · VAE 10%',
    )
    expect(wrapper.findAll('.autoinfo-word').map((w) => w.text())).toEqual([
      'cat',
      'dog',
    ])
    wrapper.unmount()
  })

  it('组件占比对越界比例做下限钳制（VAE 不出现负值）', async () => {
    selectModel({
      tensorStats: {
        architecture: 'SDXL',
        tensorCount: 10,
        dtypeMain: 'fp16',
        componentRatios: { textEncoder: 0.9, unet: 0.3, vae: 0 },
      },
    })
    const wrapper = await mountPanel()

    expect(wrapper.find('.autoinfo-comp-legend').text()).toContain(
      '文本编码器 90% · UNet/DiT 30% · VAE 0%',
    )
    wrapper.unmount()
  })

  it('参数量按 B/M/K 紧凑记法展示', async () => {
    selectModel({
      tensorStats: {
        paramCount: 2000000000,
        tensorCount: 10,
        dtypeMain: 'bf16',
      },
    })
    const wrapper = await mountPanel()
    expect(wrapper.text()).toContain('2.00B')
    wrapper.unmount()

    selectModel({
      tensorStats: {
        paramCount: 1500,
        tensorCount: 10,
        dtypeMain: 'bf16',
      },
    })
    const wrapper2 = await mountPanel()
    expect(wrapper2.text()).toContain('1.5K')
    wrapper2.unmount()

    selectModel({
      tensorStats: {
        paramCount: 42,
        tensorCount: 10,
        dtypeMain: 'bf16',
      },
    })
    const wrapper3 = await mountPanel()
    expect(wrapper3.text()).toContain('42')
    wrapper3.unmount()
  })

  it('组件字节占比总量为 0 时不渲染占比区（避免除零/空条）', async () => {
    selectModel({
      tensorStats: {
        tensorCount: 10,
        dtypeMain: 'fp16',
        componentRatios: { textEncoder: 0, unet: 0, vae: 0 },
      },
    })
    const wrapper = await mountPanel()
    expect(wrapper.find('.autoinfo-components').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('AutoInfoPanel 一键填入', () => {
  it('「填入推荐分辨率」以 resMin/resMax 上抛事件', async () => {
    selectModel({ resMin: 512, resMax: 768 })
    const wrapper = await mountPanel()

    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('填入推荐分辨率'))
      .trigger('click')

    expect(wrapper.emitted('apply-resolution')).toEqual([[512, 768]])
    wrapper.unmount()
  })

  it('resMax 缺省时回退 resMin（单值区间不丢分辨率）', async () => {
    selectModel({ resMin: 512 })
    const wrapper = await mountPanel()

    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('填入推荐分辨率'))
      .trigger('click')

    expect(wrapper.emitted('apply-resolution')).toEqual([[512, 512]])
    wrapper.unmount()
  })

  it('「填入触发词」以候选数组上抛事件', async () => {
    selectModel({ triggerCandidates: ['a', 'b'] })
    const wrapper = await mountPanel()

    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('填入触发词'))
      .trigger('click')

    expect(wrapper.emitted('apply-triggers')).toEqual([[['a', 'b']]])
    wrapper.unmount()
  })

  it('既无分辨率也无候选时不渲染操作按钮', async () => {
    selectModel({ title: 'only-title' })
    const wrapper = await mountPanel()

    expect(wrapper.find('.autoinfo-actions').exists()).toBe(false)
    wrapper.unmount()
  })
})
