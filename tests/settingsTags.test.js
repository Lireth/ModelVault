// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SettingsTags from '../src/renderer/src/components/settings/SettingsTags.vue'
import {
  acceptConfirm,
  rejectConfirm,
  state,
} from '../src/renderer/src/store/appStore'
import { setupComponentTest, settle } from './helpers/componentTest'

/**
 * 设置页「标签管理」组件测试（F4，O-1 覆盖盲区回补）：
 * SettingsTags.vue 此前仅 25% 覆盖（随 settingsPage 挂载被动覆盖）。
 * 用例覆盖整库标签管理闭环：
 * - 空库提示 / 行渲染与使用计数（tagCounts 排序口径）
 * - 重命名流程（成功 / 合并确认 / 确认拒绝 / Esc 取消 / 空名拦截 / 同名拦截）
 * - 移除流程（确认接受 / 确认拒绝）
 * - busy 锁（在途时按钮禁用，防连点并发 IPC）
 */

setupComponentTest()

function seed() {
  state.models = [
    { id: 'm1', tags: ['red', 'blue'] },
    { id: 'm2', tags: ['red'] },
    { id: 'm3', tags: ['green'] },
  ]
}

/** 超过 Top-50 的标签库：red 仍为高频标签，rare-59 仅在完整池中 */
function seedManyTags() {
  const rare = Array.from(
    { length: 60 },
    (_, i) => `rare-${String(i).padStart(2, '0')}`,
  )
  state.models = [
    { id: 'm1', tags: ['red', 'blue'] },
    { id: 'm2', tags: ['red'] },
    { id: 'm3', tags: ['green'] },
    ...rare.map((tag, i) => ({ id: `x${i}`, tags: [tag] })),
  ]
}

function mountPanel() {
  return mount(SettingsTags)
}

/** 找到指定标签所在行 */
function findRow(wrapper, tag) {
  return wrapper
    .findAll('.setting-row')
    .find(
      (r) =>
        r.find('.setting-title').exists() &&
        r.find('.setting-title').text() === tag,
    )
}

describe('渲染', () => {
  it('空库显示引导提示', () => {
    const wrapper = mountPanel()
    expect(wrapper.text()).toContain('还没有自由标签')
  })

  it('按使用次数降序渲染标签行与计数', () => {
    seed()
    const wrapper = mountPanel()
    const titles = wrapper.findAll('.setting-title').map((n) => n.text())
    // red 2 次；blue/green 各 1 次（同频按中文排序）
    expect(titles).toEqual(['red', 'blue', 'green'])
    expect(findRow(wrapper, 'red').text()).toContain('2 个模型使用')
  })
})

describe('全量标签检索（O1）', () => {
  it('标签超过 50 个时管理面板展示全量，并可按关键词检索稀有标签', async () => {
    seedManyTags()
    const wrapper = mountPanel()
    // 63 个标签全部进入管理面板（不再截断为 Top-50）
    expect(wrapper.findAll('.setting-title')).toHaveLength(63)

    await wrapper.find('.tag-search-input').setValue('rare-59')
    const titles = wrapper.findAll('.setting-title').map((n) => n.text())
    expect(titles).toEqual(['rare-59'])
    expect(wrapper.text()).toContain('匹配 1 个')
  })

  it('检索无结果时显示空态，而不是空库引导提示', async () => {
    seedManyTags()
    const wrapper = mountPanel()
    await wrapper.find('.tag-search-input').setValue('no-such-tag')

    expect(wrapper.findAll('.setting-title')).toHaveLength(0)
    expect(wrapper.text()).toContain('没有匹配')
    expect(wrapper.text()).not.toContain('还没有自由标签')
  })

  it('目标名是 Top-50 之外的已存在标签时仍弹合并确认', async () => {
    seedManyTags()
    const wrapper = mountPanel()

    await findRow(wrapper, 'red').find('button').trigger('click')
    await wrapper.find('.tag-edit-input').setValue('rare-59')
    await wrapper.find('button.btn-primary').trigger('click')

    expect(state.confirm.visible).toBe(true)
    expect(state.confirm.text).toContain('合并')
    await rejectConfirm()
    await settle()
    expect(window.api.models.renameTag).not.toHaveBeenCalled()
  })
})

describe('重命名 / 合并', () => {
  it('保存重命名：调 renameTag IPC，本地模型列表同步更新', async () => {
    seed()
    window.api.models.renameTag.mockResolvedValue({ changed: 2 })
    const wrapper = mountPanel()

    await findRow(wrapper, 'red').find('button').trigger('click')
    const input = wrapper.find('.tag-edit-input')
    expect(input.exists()).toBe(true)
    await input.setValue('crimson')
    await wrapper
      .find('.tag-edit-input + .setting-actions button, button.btn-primary')
      .trigger('click')
    await settle()

    expect(window.api.models.renameTag).toHaveBeenCalledWith('red', 'crimson')
    expect(state.models[0].tags).toEqual(['crimson', 'blue'])
    expect(state.models[1].tags).toEqual(['crimson'])
    // 编辑态退出，输入框消失
    expect(wrapper.find('.tag-edit-input').exists()).toBe(false)
  })

  it('目标名已存在时先弹合并确认，接受后执行合并（去重）', async () => {
    seed()
    window.api.models.renameTag.mockResolvedValue({ changed: 3 })
    const wrapper = mountPanel()

    await findRow(wrapper, 'red').find('button').trigger('click')
    await wrapper.find('.tag-edit-input').setValue('blue')
    await wrapper.find('button.btn-primary').trigger('click')

    // 确认层出现且明示合并语义
    expect(state.confirm.visible).toBe(true)
    expect(state.confirm.text).toContain('合并')
    await acceptConfirm()
    await settle()

    expect(window.api.models.renameTag).toHaveBeenCalledWith('red', 'blue')
    // m1 同时持有 red/blue：合并后去重为单个 blue
    expect(state.models[0].tags).toEqual(['blue'])
    expect(state.models[1].tags).toEqual(['blue'])
  })

  it('确认被拒绝时不发起 IPC，编辑态保留', async () => {
    seed()
    const wrapper = mountPanel()

    await findRow(wrapper, 'red').find('button').trigger('click')
    await wrapper.find('.tag-edit-input').setValue('blue')
    await wrapper.find('button.btn-primary').trigger('click')
    await rejectConfirm()
    await settle()

    expect(window.api.models.renameTag).not.toHaveBeenCalled()
    expect(wrapper.find('.tag-edit-input').exists()).toBe(true)
  })

  it('Esc 取消编辑：退出编辑态且不发起 IPC', async () => {
    seed()
    const wrapper = mountPanel()

    await findRow(wrapper, 'red').find('button').trigger('click')
    await wrapper.find('.tag-edit-input').setValue('crimson')
    await wrapper.find('.tag-edit-input').trigger('keyup.esc')

    expect(wrapper.find('.tag-edit-input').exists()).toBe(false)
    expect(window.api.models.renameTag).not.toHaveBeenCalled()
  })

  it('空名称被拦截：保存按钮禁用，Enter 提示且不发起 IPC', async () => {
    seed()
    const wrapper = mountPanel()

    await findRow(wrapper, 'red').find('button').trigger('click')
    const input = wrapper.find('.tag-edit-input')
    await input.setValue('   ')
    expect(
      wrapper.find('button.btn-primary').attributes('disabled'),
    ).toBeDefined()

    await input.trigger('keyup.enter')
    await settle()

    expect(state.toasts.some((t) => t.text.includes('标签名称不能为空'))).toBe(
      true,
    )
    expect(window.api.models.renameTag).not.toHaveBeenCalled()
  })

  it('名称与原标题相同：保存按钮禁用（无变化不提交）', async () => {
    seed()
    const wrapper = mountPanel()

    await findRow(wrapper, 'red').find('button').trigger('click')
    await wrapper.find('.tag-edit-input').setValue('red')
    expect(
      wrapper.find('button.btn-primary').attributes('disabled'),
    ).toBeDefined()
  })

  it('busy 锁：IPC 在途时编辑行保存/取消与其他行按钮禁用', async () => {
    seed()
    let release
    window.api.models.renameTag.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ changed: 2 })
        }),
    )
    const wrapper = mountPanel()

    await findRow(wrapper, 'red').find('button').trigger('click')
    await wrapper.find('.tag-edit-input').setValue('crimson')
    await wrapper.find('button.btn-primary').trigger('click')
    await settle()

    // 在途：编辑行按钮禁用
    expect(
      wrapper.find('button.btn-primary').attributes('disabled'),
    ).toBeDefined()
    release()
    await settle()
    // 完成：busy 解除，编辑态退出
    expect(wrapper.find('button.btn-primary').exists()).toBe(false)
  })
})

describe('移除', () => {
  it('确认后调 removeTag IPC，本地模型列表同步更新', async () => {
    seed()
    window.api.models.removeTag.mockResolvedValue({ changed: 2 })
    const wrapper = mountPanel()

    const row = findRow(wrapper, 'red')
    await row.findAll('button')[1].trigger('click')

    expect(state.confirm.visible).toBe(true)
    expect(state.confirm.text).toContain('移除标签')
    expect(state.confirm.text).toContain('2 个模型')
    await acceptConfirm()
    await settle()

    expect(window.api.models.removeTag).toHaveBeenCalledWith('red')
    expect(state.models[0].tags).toEqual(['blue'])
    expect(state.models[1].tags).toEqual([])
  })

  it('确认被拒绝时不发起 IPC', async () => {
    seed()
    const wrapper = mountPanel()

    const row = findRow(wrapper, 'red')
    await row.findAll('button')[1].trigger('click')
    await rejectConfirm()
    await settle()

    expect(window.api.models.removeTag).not.toHaveBeenCalled()
    expect(state.models[0].tags).toEqual(['red', 'blue'])
  })
})
