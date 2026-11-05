// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ModelCompare from '../src/renderer/src/components/ModelCompare.vue'
import {
  COMPARE_MAX_MODELS,
  closeCompare,
  compareState,
  openCompare,
} from '../src/renderer/src/store/compare'
import { state } from '../src/renderer/src/store/appStore'
import { setupComponentTest, settle } from './helpers/componentTest'

/**
 * 模型对比测试（FN-03，O-1 覆盖盲区回补）：
 * compare.js 此前 26.7% / ModelCompare.vue 36% 覆盖。用例覆盖：
 * - openCompare 守卫：少于 2 个拒绝、超过上限拒绝、去重与截断、closeCompare 复位
 * - 组件渲染：字段行数、差异高亮（diff 行/非 diff 行/diff:false 的路径行）
 * - 详情跳转（关闭对比 + 打开详情 + warmupHash 预热）、Esc 关闭
 */

setupComponentTest()

/** 构造参与对比的模型对象（字段覆盖 FIELD_DEFS 的取值路径） */
function seedModels() {
  state.models = [
    {
      id: 'a',
      name: 'Alpha',
      ext: '.safetensors',
      type: 'lora',
      subCategory: 'style',
      baseModel: 'SDXL 1.0',
      size: 100,
      mtimeMs: 1000,
      favorite: true,
      nsfw: false,
      rating: 4,
      alias: '',
      note: 'note-a',
      triggerWords: 'alpha',
      tags: ['red'],
      coverUrl: '',
      params: undefined,
    },
    {
      id: 'b',
      name: 'Beta',
      ext: '.safetensors',
      type: 'lora',
      subCategory: 'style',
      baseModel: 'SDXL 1.0',
      size: 200,
      mtimeMs: 2000,
      favorite: false,
      nsfw: false,
      rating: 0,
      alias: '',
      note: '',
      triggerWords: 'beta',
      tags: ['red'],
      coverUrl: '',
      params: undefined,
    },
  ]
}

function mountCompare() {
  return mount(ModelCompare, {
    global: {
      // Teleport 桩：内容保留在 wrapper 树内（生产仍 Teleport 到 body）
      stubs: { teleport: true },
    },
  })
}

/** 取指定字段名的差异行（tbody tr，首个 th 为字段名） */
function findRow(wrapper, label) {
  return wrapper
    .findAll('tbody tr')
    .find((r) => r.find('th').text() === label)
}

describe('compare.js 状态守卫', () => {
  it('少于 2 个模型拒绝打开并提示', () => {
    expect(openCompare([])).toBe(false)
    expect(openCompare(['a'])).toBe(false)
    expect(compareState.open).toBe(false)
    expect(state.toasts.some((t) => t.text.includes('至少选择 2 个'))).toBe(
      true,
    )
  })

  it('超过上限拒绝打开并提示上限值', () => {
    const ids = Array.from({ length: COMPARE_MAX_MODELS + 1 }, (_, i) => `m${i}`)
    expect(openCompare(ids)).toBe(false)
    expect(
      state.toasts.some((t) => t.text.includes(`最多同时对比 ${COMPARE_MAX_MODELS}`)),
    ).toBe(true)
  })

  it('限内 id 去重（重复项不重复占用席位）', () => {
    // 超限校验发生在去重之前：原始列表 >6 直接拒绝（上一用例），
    // 限内重复项则去重后打开
    expect(openCompare(['a', 'a', 'b', 'c', 'd', 'e'])).toBe(true)
    expect(compareState.ids).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(compareState.open).toBe(true)
  })

  it('closeCompare 复位打开态与快照', () => {
    openCompare(['a', 'b'])
    closeCompare()
    expect(compareState.open).toBe(false)
    expect(compareState.ids).toEqual([])
  })
})

describe('ModelCompare 组件渲染', () => {
  it('并排展示模型数与全部字段行', () => {
    seedModels()
    openCompare(['a', 'b'])
    const wrapper = mountCompare()

    expect(wrapper.find('.compare-count').text()).toBe('2 个模型')
    // FIELD_DEFS 全量 13 行（含 diff:false 的文件路径行）
    expect(wrapper.findAll('tbody tr')).toHaveLength(13)
  })

  it('值不一致的行高亮（diff class），一致行不高亮', () => {
    seedModels()
    openCompare(['a', 'b'])
    const wrapper = mountCompare()

    // 评分不同（4★ vs 未评分）→ 高亮
    const ratingRow = findRow(wrapper, '评分')
    expect(ratingRow.find('td.diff').exists()).toBe(true)
    // 分类一致 → 不高亮
    const typeRow = findRow(wrapper, '分类')
    expect(typeRow.find('td.diff').exists()).toBe(false)
    // 文件路径永远不参与差异高亮（diff:false），即使值不同
    const pathRow = findRow(wrapper, '文件路径')
    expect(pathRow.find('td.diff').exists()).toBe(false)
  })

  it('字段值经 format 函数渲染（评分星号 / 标签拼接）', () => {
    seedModels()
    openCompare(['a', 'b'])
    const wrapper = mountCompare()

    const ratingRow = findRow(wrapper, '评分')
    expect(ratingRow.findAll('td')[0].text()).toBe('4 ★')
    expect(ratingRow.findAll('td')[1].text()).toBe('未评分')
    const tagsRow = findRow(wrapper, '标签')
    expect(tagsRow.findAll('td')[0].text()).toBe('red')
  })
})

describe('ModelCompare 交互', () => {
  it('点击「详情」：关闭对比并打开对应模型详情', async () => {
    seedModels()
    openCompare(['a', 'b'])
    const wrapper = mountCompare()

    await wrapper.findAll('.mini-detail')[0].trigger('click')
    await settle()

    expect(compareState.open).toBe(false)
    expect(state.selectedId).toBe('a')
    // openDetail 顺带后台预热 SHA256
    expect(window.api.models.warmupHash).toHaveBeenCalledWith('a')
  })

  it('Esc 关闭对比视图', async () => {
    seedModels()
    openCompare(['a', 'b'])
    mountCompare()

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
    await settle()

    expect(compareState.open).toBe(false)
  })

  it('id 快照失效（模型不在列表中）时降级为空对比不崩溃', () => {
    openCompare(['ghost-1', 'ghost-2'])
    const wrapper = mountCompare()
    expect(wrapper.find('.compare-count').text()).toBe('0 个模型')
    // 字段行仍然渲染，单元格取空值展示
    expect(wrapper.findAll('tbody tr')).toHaveLength(13)
  })
})
