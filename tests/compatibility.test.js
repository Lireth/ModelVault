// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import CompatibilityPanel from '../src/renderer/src/components/detail/CompatibilityPanel.vue'
import {
  compatibilityInfo,
  filterCompatibleModels,
  replaceModels,
  state,
} from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * 基底兼容性视图（F6）：
 * - 家族索引：LoRA ↔ Checkpoint 同基底匹配、名称排序、隐藏 NSFW 收敛；
 * - 保守判定：空基底 unknown、其他基底 unclassified、非 LoRA/Checkpoint unsupported；
 * - 一键筛选：关闭详情后切换类型 + 基底筛选并清空收窄条件；
 * - 面板：兼容列表、状态文案与筛选按钮。
 */

setupComponentTest()

/** 最小模型对象（兼容性只消费 id/name/alias/type/baseModel/nsfw） */
function model(id, overrides = {}) {
  return {
    id,
    name: id,
    alias: '',
    type: 'lora',
    baseModel: '',
    nsfw: false,
    disabled: false,
    ...overrides,
  }
}

/** 预置 1 个 Pony LoRA + 2 个 Pony Checkpoint + 其他边界样本 */
function seedModels() {
  replaceModels([
    model('lora-pony', {
      type: 'lora',
      baseModel: 'Pony Diffusion V6 XL',
      alias: 'Pony 角色',
    }),
    model('cp-pony-1', {
      name: 'ponyA',
      type: 'checkpoint',
      baseModel: 'Pony Diffusion V6 XL',
    }),
    model('cp-pony-2', {
      name: 'ponyB',
      type: 'checkpoint',
      baseModel: 'PonyRealism',
    }),
    model('cp-sdxl', {
      name: 'sdxl',
      type: 'checkpoint',
      baseModel: 'SDXL 1.0',
    }),
    model('lora-unknown', { type: 'lora', baseModel: '' }),
    model('lora-other', { type: 'lora', baseModel: 'HunyuanDiT' }),
    model('vae-pony', { type: 'vae', baseModel: 'Pony' }),
  ])
}

describe('compatibilityInfo（F6）', () => {
  beforeEach(seedModels)

  it('LoRA → 同基底 Checkpoint 列表按名称排序', () => {
    state.selectedId = 'lora-pony'
    const info = compatibilityInfo.value
    expect(info.supported).toBe(true)
    expect(info.status).toBe('ok')
    expect(info.family).toBe('pony')
    expect(info.familyLabel).toBe('Pony')
    expect(info.counterpartType).toBe('checkpoint')
    expect(info.total).toBe(2)
    expect(info.counterparts.map((m) => m.id)).toEqual([
      'cp-pony-1',
      'cp-pony-2',
    ])
  })

  it('Checkpoint → 同基底 LoRA 列表', () => {
    state.selectedId = 'cp-pony-1'
    const info = compatibilityInfo.value
    expect(info.status).toBe('ok')
    expect(info.counterpartType).toBe('lora')
    expect(info.counterparts.map((m) => m.id)).toEqual(['lora-pony'])
  })

  it('空基底 unknown；其他基底 unclassified；非 LoRA/Checkpoint unsupported', () => {
    state.selectedId = 'lora-unknown'
    expect(compatibilityInfo.value.status).toBe('unknown')
    expect(compatibilityInfo.value.supported).toBe(true)

    state.selectedId = 'lora-other'
    expect(compatibilityInfo.value.status).toBe('unclassified')
    expect(compatibilityInfo.value.familyLabel).toBe('其他基底')
    expect(compatibilityInfo.value.counterparts).toEqual([])

    state.selectedId = 'vae-pony'
    expect(compatibilityInfo.value.status).toBe('unsupported')
    expect(compatibilityInfo.value.supported).toBe(false)
  })

  it('隐藏 NSFW 后兼容列表同步收敛', () => {
    replaceModels([
      model('lora-pony', { type: 'lora', baseModel: 'Pony' }),
      model('cp-pony-1', { type: 'checkpoint', baseModel: 'Pony' }),
      model('cp-pony-2', { type: 'checkpoint', baseModel: 'Pony', nsfw: true }),
    ])
    state.settings.hideNsfwModels = true
    state.selectedId = 'lora-pony'
    expect(compatibilityInfo.value.total).toBe(1)
    expect(compatibilityInfo.value.counterparts.map((m) => m.id)).toEqual([
      'cp-pony-1',
    ])
  })

  it('无同基底对象时 status=no-match', () => {
    replaceModels([
      model('lora-pony', { type: 'lora', baseModel: 'Pony' }),
      model('cp-sdxl', { type: 'checkpoint', baseModel: 'SDXL 1.0' }),
    ])
    state.selectedId = 'lora-pony'
    expect(compatibilityInfo.value.status).toBe('no-match')
    expect(compatibilityInfo.value.total).toBe(0)
  })
})

describe('filterCompatibleModels（F6）', () => {
  beforeEach(seedModels)

  it('关闭详情并切换类型 + 基底筛选，清空收窄条件', async () => {
    state.selectedId = 'lora-pony'
    state.typeFilter = 'all'
    state.baseFilter = ''
    state.search = '关键词'
    state.tagFilters = ['角色']
    state.showFavoritesOnly = true
    state.detailDirty = false

    const ok = await filterCompatibleModels()

    expect(ok).toBe(true)
    expect(state.selectedId).toBeNull()
    expect(state.typeFilter).toBe('checkpoint')
    expect(state.baseFilter).toBe('pony')
    expect(state.search).toBe('')
    expect(state.tagFilters).toEqual([])
    expect(state.showFavoritesOnly).toBe(false)
    expect(state.toasts.some((t) => t.text.includes('已筛选'))).toBe(true)
  })

  it('无可兼容对象时不改动筛选', async () => {
    replaceModels([model('lora-pony', { type: 'lora', baseModel: 'Pony' })])
    state.selectedId = 'lora-pony'
    state.typeFilter = 'lora'
    state.baseFilter = ''

    expect(await filterCompatibleModels()).toBe(false)
    expect(state.selectedId).toBe('lora-pony')
    expect(state.typeFilter).toBe('lora')
    expect(state.baseFilter).toBe('')
  })
})

describe('CompatibilityPanel（F6）', () => {
  beforeEach(seedModels)

  it('展示家族、兼容列表与筛选入口', async () => {
    state.selectedId = 'lora-pony'
    const wrapper = mount(CompatibilityPanel)
    await flushPromises()

    expect(wrapper.find('.compat-panel').exists()).toBe(true)
    expect(wrapper.find('.compat-chip').text()).toBe('Pony')
    expect(wrapper.find('.compat-base').text()).toContain('Pony Diffusion')
    expect(wrapper.findAll('.compat-item')).toHaveLength(2)
    expect(wrapper.find('.compat-list').text()).toContain('ponyA')

    await wrapper.find('.compat-filter').trigger('click')
    await flushPromises()
    expect(state.typeFilter).toBe('checkpoint')
    expect(state.baseFilter).toBe('pony')
    wrapper.unmount()
  })

  it('未知基底显示保守提示，不渲染兼容列表', async () => {
    state.selectedId = 'lora-unknown'
    const wrapper = mount(CompatibilityPanel)
    await flushPromises()

    expect(wrapper.find('.compat-panel').exists()).toBe(true)
    expect(wrapper.find('.compat-note').text()).toContain('未解析到基底模型')
    expect(wrapper.find('.compat-list').exists()).toBe(false)
    wrapper.unmount()
  })

  it('点击兼容项打开对应模型详情', async () => {
    state.selectedId = 'lora-pony'
    const wrapper = mount(CompatibilityPanel)
    await flushPromises()

    await wrapper.findAll('.compat-item')[0].trigger('click')
    await flushPromises()
    expect(state.selectedId).toBe('cp-pony-1')
    wrapper.unmount()
  })
})
