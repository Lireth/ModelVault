// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import BatchFailuresBar from '../src/renderer/src/components/BatchFailuresBar.vue'
import {
  batchFavorite,
  reselectFailedItems,
  replaceModels,
  state,
} from '../src/renderer/src/store/appStore'
import { setupComponentTest, settle } from './helpers/componentTest'

/**
 * 批量操作失败明细（B20/F3）：
 * - store：逐项失败保留（id + 名称快照 + 真实原因）、全成功不记录、
 *   重选失败项重建选区（失效 id 剔除）、重试成功后明细清空
 * - 组件：折叠/展开、明细行渲染（名称 + 原因）、分页展开、重选按钮
 */

setupComponentTest()

/** 注入 3 个模型 */
function seedModels() {
  replaceModels(
    ['a', 'b', 'c'].map((name, i) => ({
      id: `D:\\models\\${name}.safetensors`,
      name,
      type: 'lora',
      size: 10 + i,
      mtimeMs: i + 1,
      favorite: false,
      nsfw: false,
      rating: 0,
      alias: '',
      note: '',
      subCategory: '',
      triggerWords: '',
      coverUrl: '',
      covers: [],
    })),
  )
}

const idOf = (name) => `D:\\models\\${name}.safetensors`

describe('批量失败明细 store（B20/F3）', () => {
  it('部分失败：逐项保留 id/名称/真实原因，汇总 toast 不变', async () => {
    seedModels()
    state.folder = 'D:\\models'
    state.multiSelect.active = true
    state.multiSelect.ids = [idOf('a'), idOf('b'), idOf('c')]
    window.api.models.setMetaFlags.mockImplementation(({ id }) =>
      id === idOf('b')
        ? Promise.resolve({ error: '元数据写入失败: EPERM' })
        : Promise.resolve({ meta: { favorite: true, nsfw: false, rating: 0 } }),
    )

    await batchFavorite(true)

    const f = state.multiSelect.failures
    expect(f.op).toBe('批量收藏')
    expect(f.items).toHaveLength(1)
    expect(f.items[0].id).toBe(idOf('b'))
    expect(f.items[0].name).toBe('b')
    expect(f.items[0].error).toContain('EPERM')
    expect(
      state.toasts.some((t) => t.type === 'warn' && t.text.includes('失败 1 个')),
    ).toBe(true)
  })

  it('全成功：不记录失败明细（面板不出现）', async () => {
    seedModels()
    state.multiSelect.active = true
    state.multiSelect.ids = [idOf('a'), idOf('b')]
    window.api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: true, nsfw: false, rating: 0 },
    })

    await batchFavorite(true)

    expect(state.multiSelect.failures).toBeNull()
  })

  it('重选失败项：只选中仍存在的失败项，失效 id 剔除并提示', async () => {
    seedModels()
    state.multiSelect.active = true
    state.multiSelect.ids = [idOf('a'), idOf('b')]
    window.api.models.setMetaFlags.mockImplementation(() =>
      Promise.reject(new Error('模拟失败')),
    )
    await batchFavorite(true)
    expect(state.multiSelect.failures.items).toHaveLength(2)
    state.multiSelect.active = false
    state.multiSelect.ids = []

    // 失败项之一已被删除/改名（当前库中不存在）
    expect(reselectFailedItems()).toBe(true)
    expect(state.multiSelect.active).toBe(true)
    expect(new Set(state.multiSelect.ids)).toEqual(
      new Set([idOf('a'), idOf('b')]),
    )
  })

  it('全部失败项失效时拒绝重建并提示', async () => {
    seedModels()
    state.multiSelect.active = true
    state.multiSelect.ids = [idOf('a')]
    window.api.models.setMetaFlags.mockResolvedValue({ error: '失败' })
    await batchFavorite(true)
    replaceModels([]) // 失败项已不在库中
    expect(reselectFailedItems()).toBe(false)
    // 拒绝重建时选区保持原样（不清空、不篡改）
    expect(state.multiSelect.ids).toEqual([idOf('a')])
    expect(
      state.toasts.some((t) => t.text.includes('已不在当前模型库')),
    ).toBe(true)
  })

  it('重试成功后面板清空（结果整体替换，不叠加旧错误）', async () => {
    seedModels()
    state.multiSelect.active = true
    state.multiSelect.ids = [idOf('a')]
    window.api.models.setMetaFlags.mockResolvedValueOnce({ error: '首次失败' })
    await batchFavorite(true)
    expect(state.multiSelect.failures.items).toHaveLength(1)

    // 重选失败项后重试同一动作（既有执行路径），这次成功
    reselectFailedItems()
    window.api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: true, nsfw: false, rating: 0 },
    })
    await batchFavorite(true)
    expect(state.multiSelect.failures).toBeNull()
  })
})

describe('BatchFailuresBar 组件（B20/F3）', () => {
  it('无失败时不渲染；有失败时折叠态显示聚合计数', async () => {
    seedModels()
    state.folder = 'D:\\models'
    const wrapper = mount(BatchFailuresBar)
    expect(wrapper.find('.batch-failures').exists()).toBe(false)

    state.multiSelect.failures = {
      op: '批量收藏',
      at: Date.now(),
      items: [{ id: idOf('a'), name: 'a', error: 'EPERM 占用' }],
    }
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.bf-summary').text()).toContain('失败 1 个')
    // 折叠态不渲染明细行
    expect(wrapper.find('.bf-item').exists()).toBe(false)
    wrapper.unmount()
  })

  it('展开后渲染名称与真实原因；重选按钮重建选区', async () => {
    seedModels()
    state.folder = 'D:\\models'
    state.multiSelect.failures = {
      op: '批量删除',
      at: Date.now(),
      items: [
        { id: idOf('a'), name: '模型A', error: '文件被占用' },
        { id: idOf('b'), name: '模型B', error: '权限不足' },
      ],
    }
    const wrapper = mount(BatchFailuresBar)

    await wrapper.find('.bf-row .bf-btn').trigger('click') // 展开
    const rows = wrapper.findAll('.bf-item')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('模型A')
    expect(rows[0].text()).toContain('文件被占用')
    expect(rows[1].text()).toContain('权限不足')

    await wrapper.find('.bf-retry').trigger('click')
    expect(state.multiSelect.active).toBe(true)
    expect(new Set(state.multiSelect.ids)).toEqual(
      new Set([idOf('a'), idOf('b')]),
    )
    wrapper.unmount()
  })

  it('大量失败按页渲染（首屏 100 条 + 显示更多）', async () => {
    seedModels()
    state.folder = 'D:\\models'
    state.multiSelect.failures = {
      op: '批量评分',
      at: Date.now(),
      items: Array.from({ length: 230 }, (_, i) => ({
        id: `D:\\models\\f${i}.safetensors`,
        name: `f${i}`,
        error: '失败',
      })),
    }
    const wrapper = mount(BatchFailuresBar)
    await wrapper.find('.bf-row .bf-btn').trigger('click')
    expect(wrapper.findAll('.bf-item')).toHaveLength(100)
    const more = wrapper.find('.bf-more')
    expect(more.text()).toContain('还剩 130 条')
    await more.trigger('click')
    expect(wrapper.findAll('.bf-item')).toHaveLength(200)
    wrapper.unmount()
  })

  it('清除按钮移除明细（面板消失）', async () => {
    seedModels()
    state.folder = 'D:\\models'
    state.multiSelect.failures = {
      op: '批量收藏',
      at: Date.now(),
      items: [{ id: idOf('a'), name: 'a', error: 'x' }],
    }
    const wrapper = mount(BatchFailuresBar)
    await wrapper.vm.$nextTick()
    await wrapper.find('.bf-close').trigger('click')
    await settle()
    expect(state.multiSelect.failures).toBeNull()
    expect(wrapper.find('.batch-failures').exists()).toBe(false)
    wrapper.unmount()
  })
})
