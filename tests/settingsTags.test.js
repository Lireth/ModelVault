// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import SettingsTags from '../src/renderer/src/components/settings/SettingsTags.vue'
import { acceptConfirm, rejectConfirm, replaceModels, state } from '../src/renderer/src/store/appStore'
import { setupComponentTest, settle } from './helpers/componentTest'

/**
 * 标签管理面板组件交互测试（F4）：
 * - 行渲染：标签名 + 使用计数、空态提示
 * - 行内编辑：进入/取消/保存；目标已存在时经确认层告知合并语义
 * - 移除：确认层明示影响范围后调用 API
 * - busy 语义与本地列表即时刷新
 */

setupComponentTest()

/** 种子三个模型（标签池：角色×2、风格×1） */
function seed() {
  replaceModels([
    { id: 'a', name: 'a.safetensors', tags: ['角色', '废弃'] },
    { id: 'b', name: 'b.safetensors', tags: ['废弃'] },
    { id: 'c', name: 'c.safetensors', tags: ['风格'] }
  ])
}

function mountPanel() {
  return mount(SettingsTags)
}

function findButton(wrapper, text) {
  return wrapper.findAll('button').find((b) => b.text().includes(text))
}

describe('SettingsTags 标签管理面板', () => {
  it('渲染标签行（名称 + 使用计数）；无标签时显示空态', async () => {
    const empty = mountPanel()
    expect(empty.text()).toContain('当前模型库还没有自由标签')
    empty.unmount()

    seed()
    const wrapper = mountPanel()
    expect(wrapper.text()).toContain('角色')
    expect(wrapper.text()).toContain('2 个模型使用')
    expect(wrapper.text()).toContain('风格')
    expect(wrapper.text()).toContain('1 个模型使用')
  })

  it('行内编辑：保存调用 renameTag 并本地刷新（无需重扫）', async () => {
    seed()
    window.api.models.renameTag = vi.fn(() => Promise.resolve({ changed: 2 }))
    const wrapper = mountPanel()
    const row = wrapper.findAll('.setting-row').find((r) => r.text().includes('角色'))
    await row.findAll('button').find((b) => b.text().includes('重命名')).trigger('click')
    const input = wrapper.find('.tag-edit-input')
    expect(input.exists()).toBe(true)
    await input.setValue('主要角色')
    await findButton(wrapper, '保存').trigger('click')
    await settle()

    expect(window.api.models.renameTag).toHaveBeenCalledWith('角色', '主要角色')
    expect(wrapper.text()).toContain('主要角色')
    // 编辑框已退出，行回到浏览态
    expect(wrapper.find('.tag-edit-input').exists()).toBe(false)
    wrapper.unmount()
  })

  it('目标名已存在：确认层告知合并语义，接受后合并', async () => {
    seed()
    window.api.models.renameTag = vi.fn(() => Promise.resolve({ changed: 2 }))
    const wrapper = mountPanel()
    // 重命名「风格」（1 个模型）→「角色」（已存在）
    const styleRow = wrapper.findAll('.setting-row').find((r) => r.text().includes('风格'))
    await styleRow.findAll('button').find((b) => b.text().includes('重命名')).trigger('click')
    await wrapper.find('.tag-edit-input').setValue('角色')
    await findButton(wrapper, '保存').trigger('click')
    await settle()

    // 确认层弹出且文案包含合并语义
    expect(state.confirm.visible).toBe(true)
    expect(state.confirm.text).toContain('合并')
    acceptConfirm()
    await settle()

    expect(window.api.models.renameTag).toHaveBeenCalledWith('风格', '角色')
    // 合并生效：「风格」从标签池消失（角色 = 原有 1 + 风格 1 = 2 个模型）
    expect(wrapper.text()).not.toContain('风格')
    expect(wrapper.findAll('.setting-row')).toHaveLength(2)
    wrapper.unmount()
  })

  it('确认层取消时不调用 API，编辑态保留', async () => {
    seed()
    window.api.models.renameTag = vi.fn(() => Promise.resolve({ changed: 2 }))
    const wrapper = mountPanel()
    const styleRow = wrapper.findAll('.setting-row').find((r) => r.text().includes('风格'))
    await styleRow.findAll('button').find((b) => b.text().includes('重命名')).trigger('click')
    await wrapper.find('.tag-edit-input').setValue('角色')
    await findButton(wrapper, '保存').trigger('click')
    await settle()

    expect(state.confirm.visible).toBe(true)
    rejectConfirm()
    await settle()

    expect(window.api.models.renameTag).not.toHaveBeenCalled()
    // 编辑态保留，用户可改值重试
    expect(wrapper.find('.tag-edit-input').exists()).toBe(true)
    wrapper.unmount()
  })

  it('移除：确认层后调用 removeTag，本地列表同步', async () => {
    seed()
    window.api.models.removeTag = vi.fn(() => Promise.resolve({ changed: 2 }))
    const wrapper = mountPanel()
    const row = wrapper.findAll('.setting-row').find((r) => r.text().includes('废弃'))
    await row.findAll('button').find((b) => b.text().includes('移除')).trigger('click')
    await settle()
    expect(state.confirm.text).toContain('2 个模型')
    acceptConfirm()
    await settle()

    expect(window.api.models.removeTag).toHaveBeenCalledWith('废弃')
    // 废弃标签随本地列表消失，面板行即时刷新
    expect(wrapper.text()).not.toContain('废弃')
    wrapper.unmount()
  })

  it('取消编辑恢复浏览态且不调用 API', async () => {
    seed()
    window.api.models.renameTag = vi.fn(() => Promise.resolve({ changed: 0 }))
    const wrapper = mountPanel()
    await findButton(wrapper, '重命名 / 合并').trigger('click')
    expect(wrapper.find('.tag-edit-input').exists()).toBe(true)
    await findButton(wrapper, '取消').trigger('click')
    await settle()
    expect(wrapper.find('.tag-edit-input').exists()).toBe(false)
    expect(window.api.models.renameTag).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
