// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import OrganizePanel from '../src/renderer/src/components/OrganizePanel.vue'
import { acceptConfirm, openOrganize, state } from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * 应用内整理面板组件测试（B-06）：
 * 待移动计数与目标选择、确认后发起移动、内联新建文件夹、失联绑定流程。
 */

setupComponentTest()

function rowByText(wrapper, text) {
  return wrapper.findAll('.folder-tree .tree-row').find((r) => r.text().includes(text))
}

describe('OrganizePanel 移动模型', () => {
  it('带入选区时显示待移动数量；选择目录后确认发起 moveModels', async () => {
    window.api.models.listDirs.mockResolvedValue({ dirs: ['', 'dest'] })
    window.api.models.moveModels.mockResolvedValue({
      moved: [{ from: 'm1', to: 'dest-m1', model: { id: 'dest-m1' } }],
      failed: [],
      destDir: 'dest'
    })
    await openOrganize(['m1'])
    const wrapper = mount(OrganizePanel)
    await flushPromises()

    expect(wrapper.text()).toContain('待移动 1 个模型')
    // 选择目标目录
    await rowByText(wrapper, 'dest').trigger('click')
    expect(state.organize.targetDir).toBe('dest')

    const moveBtn = wrapper.findAll('button').find((b) => b.text().includes('移动'))
    await moveBtn.trigger('click')
    acceptConfirm()
    await flushPromises()
    expect(window.api.models.moveModels).toHaveBeenCalledWith({ ids: ['m1'], destDir: 'dest' })
  })

  it('内联新建文件夹走 createFolder IPC', async () => {
    window.api.models.listDirs.mockResolvedValue({ dirs: [''] })
    window.api.models.createFolder.mockResolvedValue({ ok: true, dir: 'newdir' })
    state.organize.open = true
    const wrapper = mount(OrganizePanel)
    await flushPromises()

    // 根行的「新建」操作按钮
    const createBtn = wrapper.findAll('.folder-tree .tree-row')[0].findAll('.tree-action')[0]
    await createBtn.trigger('click')
    const input = wrapper.find('.tree-edit-input')
    expect(input.exists()).toBe(true)
    await input.setValue('newdir')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(window.api.models.createFolder).toHaveBeenCalledWith('newdir')
  })
})

describe('OrganizePanel 失联标注绑定', () => {
  it('孤儿展示摘要角标，选择新模型绑定后调用 bindMeta 并移除条目', async () => {
    window.api.models.listDirs.mockResolvedValue({ dirs: [''] })
    window.api.models.bindMeta.mockResolvedValue({ ok: true, model: { id: 'abs-new' } })
    state.organize.open = true
    state.organize.orphans = [
      {
        key: 'old/x.safetensors',
        name: 'x',
        ext: '.safetensors',
        dir: 'old',
        alias: '失联模型',
        favorite: true,
        rating: 4,
        hasCover: true,
        hasNote: false,
        triggerWords: ''
      }
    ]
    state.organize.newcomers = [{ key: 'new/y.safetensors', name: 'y', ext: '.safetensors', dir: 'new' }]
    state.models = [{ id: 'abs-new' }]

    const wrapper = mount(OrganizePanel)
    expect(wrapper.text()).toContain('失联模型')
    expect(wrapper.text()).toContain('封面')

    const select = wrapper.find('.gap-select')
    await select.setValue('new/y.safetensors')
    const bindBtn = wrapper.findAll('button').find((b) => b.text().trim() === '绑定')
    await bindBtn.trigger('click')
    await flushPromises()

    expect(window.api.models.bindMeta).toHaveBeenCalledWith(
      'old/x.safetensors',
      'new/y.safetensors'
    )
    expect(state.organize.orphans).toHaveLength(0)
    expect(state.organize.newcomers).toHaveLength(0)
  })

  it('无失联标注时显示空态', () => {
    state.organize.open = true
    state.organize.orphans = []
    state.organize.newcomers = []
    const wrapper = mount(OrganizePanel)
    expect(wrapper.text()).toContain('没有失联的标注')
  })
})
