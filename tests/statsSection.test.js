// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import StatsSection from '../src/renderer/src/components/StatsSection.vue'
import { replaceModels } from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * StatsSection 统计区组件测试（F-3 图表化增强）：
 * - 分类容量堆叠条按分类分色渲染；
 * - 基底模型分布（F-2 数据源）：家族归一化聚合、未解析不计入、空态隐藏；
 * - 重复占用（FEAT-1）：组数/冗余副本/可释放占比展示，无重复时隐藏。
 */

setupComponentTest()

/** 构造最小模型对象（仅统计所需字段） */
function makeModel(id, overrides = {}) {
  return {
    id,
    name: id,
    alias: '',
    type: 'lora',
    size: 1000,
    favorite: false,
    rating: 0,
    hasManualCover: false,
    note: '',
    baseModel: '',
    autoInfo: null,
    ...overrides
  }
}

function mountStats() {
  return mount(StatsSection)
}

describe('StatsSection 分类容量堆叠条（F-3）', () => {
  it('按分类渲染堆叠段，数量与分类数一致', () => {
    replaceModels([
      makeModel('a', { type: 'lora', size: 1000 }),
      makeModel('b', { type: 'checkpoint', size: 3000 })
    ])
    const wrapper = mountStats()
    const segs = wrapper.findAll('.stack-seg')
    expect(segs.length).toBe(2)
  })

  it('总容量为零时不渲染堆叠条（避免除零与空段）', () => {
    replaceModels([makeModel('a', { type: 'lora', size: 0 })])
    const wrapper = mountStats()
    expect(wrapper.find('.stack-bar').exists()).toBe(false)
  })
})

describe('StatsSection 基底模型分布（F-3 × F-2）', () => {
  it('按家族聚合数量与占比，未解析基底不计入', () => {
    replaceModels([
      makeModel('a', { size: 1000, baseModel: 'SDXL 1.0' }),
      makeModel('b', { size: 1000, baseModel: 'Pony Diffusion V6 XL' }),
      makeModel('c', { size: 1000, baseModel: 'pony' }),
      makeModel('d', { size: 1000, baseModel: '' })
    ])
    const wrapper = mountStats()
    const block = wrapper.findAll('.stats-block').find((b) => b.text().includes('基底模型分布'))
    expect(block).toBeTruthy()
    const rows = block.findAll('.cov-row')
    // 仅 SDXL 与 Pony 两个家族（Pony 两条合并；未解析的 d 不计入）
    expect(rows.length).toBe(2)
    expect(block.text()).toContain('已识别 3 个模型')
    const ponyRow = rows.find((r) => r.text().includes('Pony'))
    expect(ponyRow.text()).toContain('2 个 · 67%')
  })

  it('全部模型无基底信息时隐藏该区块', () => {
    replaceModels([makeModel('a', { baseModel: '' })])
    const wrapper = mountStats()
    const block = wrapper.findAll('.stats-block').find((b) => b.text().includes('基底模型分布'))
    expect(block).toBeUndefined()
  })
})

describe('StatsSection 重复占用（F-3 × FEAT-1）', () => {
  it('展示组数、冗余副本数与可释放占比；无重复时隐藏', () => {
    // 同哈希两份：1 组 1 个冗余副本，可释放 = 单份体积
    replaceModels([
      makeModel('a', { size: 2000, hash: 'aa' }),
      makeModel('b', { size: 2000, hash: 'aa' }),
      makeModel('c', { size: 2000, hash: 'bb' })
    ])
    let wrapper = mountStats()
    let block = wrapper.findAll('.stats-block').find((b) => b.text().includes('重复占用'))
    expect(block).toBeTruthy()
    expect(block.text()).toContain('1 组重复内容、1 个冗余副本')
    // 可释放 2000 / 总 6000 ≈ 33%
    expect(block.text()).toContain('33%')

    // 消除重复后区块隐藏
    replaceModels([makeModel('a', { size: 2000, hash: 'aa' })])
    wrapper = mountStats()
    block = wrapper.findAll('.stats-block').find((b) => b.text().includes('重复占用'))
    expect(block).toBeUndefined()
  })
})
