// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import DedupePanel from '../src/renderer/src/components/DedupePanel.vue'
import { acceptConfirm, rejectConfirm, state } from '../src/renderer/src/store/appStore'
import { setupComponentTest, settle } from './helpers/componentTest'

/**
 * DedupePanel 组件测试（OPT-16 基建；FEAT-2 / OPT-4 回归）：
 * - 建议保留徽标：每组仅一个、理由与评选权重一致；
 * - 智能清理：单组「保留最优」与「全部智能清理」的确认 → 删除 → 同步链路；
 * - 取消态（OPT-4）：检测取消后显示取消态而非「未发现重复模型」。
 */

setupComponentTest()

/** 构造最小模型对象（字段与扫描装饰结果对齐） */
function makeModel(id, overrides = {}) {
  return {
    id,
    name: id,
    type: 'checkpoint',
    size: 1000,
    mtimeMs: 1000,
    favorite: false,
    nsfw: false,
    rating: 0,
    alias: '',
    note: '',
    subCategory: '',
    triggerWords: '',
    ...overrides
  }
}

function makeGroup(gid, items) {
  return { gid, size: items[0]?.size || 1000, items }
}

function mountPanel() {
  state.dedupe.open = true
  return mount(DedupePanel)
}

describe('DedupePanel 建议保留标注（FEAT-2）', () => {
  it('为每组评分最高的副本渲染唯一「建议保留」徽标与理由', () => {
    const items = [
      makeModel('a', { name: 'a', rating: 5 }),
      makeModel('b', { name: 'b', favorite: true })
    ]
    state.dedupe.groups = [makeGroup('h1', items)]
    const wrapper = mountPanel()
    const badges = wrapper.findAll('.keeper-badge')
    expect(badges).toHaveLength(1)
    expect(badges[0].text()).toBe('建议保留')
    // 收藏权重高于评分：b 为建议保留
    expect(badges[0].attributes('title')).toBe('建议保留：已收藏')
  })

  it('无用户标注时仍给出确定性的建议保留项（可疑命名降级）', () => {
    const items = [
      makeModel('x', { name: 'model (1)' }),
      makeModel('y', { name: 'model' })
    ]
    state.dedupe.groups = [makeGroup('h1', items)]
    const wrapper = mountPanel()
    const badges = wrapper.findAll('.keeper-badge')
    expect(badges).toHaveLength(1)
    expect(badges[0].attributes('title')).toBe('建议保留：命名/路径更规范')
  })
})

describe('DedupePanel 智能清理（FEAT-2）', () => {
  it('「保留最优」经确认后仅将非保留副本移入回收站', async () => {
    const items = [
      makeModel('keep', { rating: 5 }),
      makeModel('t1'),
      makeModel('t2')
    ]
    state.models = [...items]
    state.dedupe.groups = [makeGroup('h1', items)]
    window.api.models.deleteModel.mockResolvedValue({ ok: true })
    const wrapper = mountPanel()
    await wrapper.find('.dedupe-keep-best').trigger('click')
    acceptConfirm()
    await settle()
    expect(window.api.models.deleteModel).toHaveBeenCalledTimes(2)
    expect(window.api.models.deleteModel).toHaveBeenCalledWith('t1')
    expect(window.api.models.deleteModel).toHaveBeenCalledWith('t2')
    // 保留项未删；列表仅剩保留项；组内不足 2 个整组消失
    expect(state.models.map((m) => m.id)).toEqual(['keep'])
    expect(state.dedupe.groups).toHaveLength(0)
  })

  it('「全部智能清理」一次性处理所有组', async () => {
    const g1 = [makeModel('k1', { rating: 5 }), makeModel('t1')]
    const g2 = [makeModel('k2', { favorite: true }), makeModel('t2')]
    state.models = [...g1, ...g2]
    state.dedupe.groups = [makeGroup('h1', g1), makeGroup('h2', g2)]
    window.api.models.deleteModel.mockResolvedValue({ ok: true })
    const wrapper = mountPanel()
    await wrapper.find('.dedupe-smart-bar .btn-primary').trigger('click')
    acceptConfirm()
    await settle()
    expect(window.api.models.deleteModel).toHaveBeenCalledTimes(2)
    expect(state.models.map((m) => m.id)).toEqual(['k1', 'k2'])
    expect(state.dedupe.groups).toHaveLength(0)
  })

  it('确认取消时不删除任何文件', async () => {
    const items = [makeModel('k', { rating: 5 }), makeModel('t1')]
    state.models = [...items]
    state.dedupe.groups = [makeGroup('h1', items)]
    const wrapper = mountPanel()
    await wrapper.find('.dedupe-keep-best').trigger('click')
    rejectConfirm()
    await settle()
    expect(window.api.models.deleteModel).not.toHaveBeenCalled()
    expect(state.models).toHaveLength(2)
    expect(state.dedupe.groups).toHaveLength(1)
  })

  it('删除中间组后，剩余组按 gid 稳定渲染不错位（OPT-4）', async () => {
    const g1 = [makeModel('k1', { rating: 5 }), makeModel('t1')]
    const g2 = [makeModel('k2', { favorite: true }), makeModel('t2')]
    state.models = [...g1, ...g2]
    state.dedupe.groups = [makeGroup('h1', g1), makeGroup('h2', g2)]
    window.api.models.deleteModel.mockResolvedValue({ ok: true })
    const wrapper = mountPanel()
    // 单组清理 h1：t1 删除后 h1 消失，h2 完整保留
    await wrapper.findAll('.dedupe-keep-best')[0].trigger('click')
    acceptConfirm()
    await settle()
    const groups = wrapper.findAll('.dedupe-group')
    expect(groups).toHaveLength(1)
    expect(groups[0].find('.dedupe-group-title').text()).toBe('重复组 1')
    expect(groups[0].findAll('.dedupe-item')).toHaveLength(2)
  })
})

describe('DedupePanel 取消态（OPT-4）', () => {
  it('检测取消后显示取消态与重新检测入口，而非「未发现重复模型」', () => {
    state.dedupe.canceled = true
    const wrapper = mountPanel()
    expect(wrapper.text()).toContain('检测已取消')
    expect(wrapper.text()).not.toContain('未发现重复模型')
    const buttons = wrapper.findAll('button').map((b) => b.text())
    expect(buttons).toContain('重新检测')
  })

  it('正常空结果显示「未发现重复模型」且无取消态文案', () => {
    state.dedupe.canceled = false
    state.dedupe.groups = []
    const wrapper = mountPanel()
    expect(wrapper.text()).toContain('未发现重复模型')
    expect(wrapper.text()).not.toContain('检测已取消')
  })
})
