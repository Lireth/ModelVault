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
    // 分类占比块内的堆叠段数与分类数一致（格式分布块另有独立堆叠条）
    const typeBlock = wrapper.findAll('.stats-block').find((b) => b.text().includes('分类占比'))
    expect(typeBlock.findAll('.stack-seg').length).toBe(2)
  })

  it('总容量为零时不渲染堆叠条（避免除零与空段）', () => {
    replaceModels([makeModel('a', { type: 'lora', size: 0 })])
    const wrapper = mountStats()
    expect(wrapper.find('.stack-bar').exists()).toBe(false)
  })
})

describe('StatsSection 总览健康与热度指标', () => {
  it('统计疑似损坏、NSFW 与近 30 天更新数量，损坏 > 0 时数字转警示色', () => {
    const recentMs = Date.now() - 24 * 3600 * 1000
    const oldMs = Date.now() - 90 * 24 * 3600 * 1000
    replaceModels([
      makeModel('a', { suspect: true, mtimeMs: recentMs }),
      makeModel('b', { nsfw: true, mtimeMs: recentMs }),
      makeModel('c', { mtimeMs: oldMs })
    ])
    const wrapper = mountStats()
    const overview = wrapper.find('.stats-overview')
    expect(overview.text()).toContain('疑似损坏')
    expect(overview.text()).toContain('近 30 天更新')
    const warnItem = overview.find('.stat-warn')
    expect(warnItem.exists()).toBe(true)
    expect(warnItem.text()).toContain('1')
    wrapper.unmount()
  })
})

describe('StatsSection 格式分布', () => {
  it('按扩展名聚合数量与容量，占比按总模型数计算', () => {
    replaceModels([
      makeModel('a.safetensors', { size: 3000 }),
      makeModel('b.safetensors', { size: 1000 }),
      makeModel('c.ckpt', { size: 2000 })
    ])
    const wrapper = mountStats()
    const block = wrapper.findAll('.stats-block').find((b) => b.text().includes('格式分布'))
    expect(block).toBeTruthy()
    const rows = block.findAll('.type-stats li')
    expect(rows.length).toBe(2)
    // 容量降序：safetensors（4000）在前
    expect(rows[0].text()).toContain('.safetensors')
    expect(rows[0].text()).toContain('2 个')
    expect(rows[0].text()).toContain('67%')
    expect(rows[1].text()).toContain('.ckpt')
    // 堆叠段 2 段
    expect(block.findAll('.stack-seg').length).toBe(2)
    wrapper.unmount()
  })

  it('按扫描 ext 字段聚合，.disabled 文件仍计入真实格式', () => {
    replaceModels([
      makeModel('a.safetensors.disabled', { ext: '.safetensors', disabled: true, size: 3000 }),
      makeModel('b.safetensors', { ext: '.safetensors', size: 1000 }),
      makeModel('c.ckpt', { ext: '.ckpt', size: 2000 })
    ])
    const wrapper = mountStats()
    const block = wrapper.findAll('.stats-block').find((b) => b.text().includes('格式分布'))
    const rows = block.findAll('.type-stats li')
    // 两个 .safetensors（含禁用文件）与一个 .ckpt，不应出现 disabled 格式
    expect(rows.length).toBe(2)
    expect(rows[0].text()).toContain('.safetensors')
    expect(rows[0].text()).toContain('2 个')
    expect(block.text()).not.toContain('disabled')
    wrapper.unmount()
  })
})

describe('StatsSection 评分分布', () => {
  it('按星级聚合并含未评分行', () => {
    replaceModels([
      makeModel('a', { rating: 5 }),
      makeModel('b', { rating: 5 }),
      makeModel('c', { rating: 3 }),
      makeModel('d', { rating: 0 })
    ])
    const wrapper = mountStats()
    const block = wrapper.findAll('.stats-block').find((b) => b.text().includes('评分分布'))
    expect(block).toBeTruthy()
    const rows = block.findAll('.cov-row')
    expect(rows.length).toBe(6) // 5★ → 1★ + 未评分
    expect(rows[0].text()).toContain('2 个 · 50%') // 5★
    expect(block.text()).toContain('未评分')
    wrapper.unmount()
  })

  it('空库时不渲染评分分布行', () => {
    replaceModels([])
    const wrapper = mountStats()
    const block = wrapper.findAll('.stats-block').find((b) => b.text().includes('评分分布'))
    expect(block.find('.cov-row').exists()).toBe(false)
    wrapper.unmount()
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
