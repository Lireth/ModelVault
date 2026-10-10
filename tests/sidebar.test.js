// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import Sidebar from '../src/renderer/src/components/Sidebar.vue'
import { acceptConfirm, state } from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * Sidebar 组件测试（OPT-16 基建；OPT-2 回归）：
 * 模型库移除按钮原为 display:none + :hover，键盘用户不可达。
 * 修复后以 opacity + pointer-events 保留 Tab 序列，span 补 role/tabindex/
 * 键盘激活——本文件固化这些可 DOM 观测的装配特征与激活行为。
 */

setupComponentTest()

/** 两个模型库：libA 为当前激活库，libB 可被移除 */
function setupTwoRoots() {
  state.folder = 'D:\\libA'
  state.settings.modelsFolders = ['D:\\libA', 'D:\\libB']
}

describe('Sidebar 模型库移除键盘可达（OPT-2 回归）', () => {
  it('移除按钮具备 role/tabindex/aria-label（可键盘聚焦与读屏识别）', () => {
    setupTwoRoots()
    const wrapper = mount(Sidebar)
    const remove = wrapper.find('.root-remove')
    expect(remove.exists()).toBe(true)
    expect(remove.attributes('role')).toBe('button')
    expect(remove.attributes('tabindex')).toBe('0')
    expect(remove.attributes('aria-label')).toContain('libB')
    expect(remove.attributes('title')).toContain('磁盘数据不受影响')
  })

  it('Enter 键触发移除（经 saveSettings 持久化，仅移出列表不删数据）', async () => {
    setupTwoRoots()
    window.api.settings.update.mockResolvedValue({
      settings: { ...state.settings, modelsFolders: ['D:\\libA'] }
    })
    const wrapper = mount(Sidebar)
    await wrapper.find('.root-remove').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(window.api.settings.update).toHaveBeenCalledWith({ modelsFolders: ['D:\\libA'] })
  })

  it('Space 键同样触发移除', async () => {
    setupTwoRoots()
    window.api.settings.update.mockResolvedValue({
      settings: { ...state.settings, modelsFolders: ['D:\\libA'] }
    })
    const wrapper = mount(Sidebar)
    await wrapper.find('.root-remove').trigger('keydown', { key: ' ' })
    await flushPromises()
    expect(window.api.settings.update).toHaveBeenCalledWith({ modelsFolders: ['D:\\libA'] })
  })

  it('点击移除不触发父级「切换模型库」（事件阻断）', async () => {
    setupTwoRoots()
    window.api.settings.update.mockResolvedValue({ settings: { ...state.settings } })
    const wrapper = mount(Sidebar)
    await wrapper.find('.root-remove').trigger('click')
    await flushPromises()
    // 未切换库：folder 不变，且未发起扫描
    expect(state.folder).toBe('D:\\libA')
    expect(window.api.models.scan).not.toHaveBeenCalled()
  })
})

describe('B-01 目录结构树', () => {
  function setupTree() {
    state.folder = 'D:\\libA'
    state.models = [
      { id: 'D:\\libA\\root.safetensors', name: 'root', type: 'checkpoint', relDir: '', size: 1 },
      { id: 'D:\\libA\\lora\\a.safetensors', name: 'a', type: 'lora', relDir: 'lora', size: 2 },
      { id: 'D:\\libA\\lora\\role\\b.safetensors', name: 'b', type: 'lora', relDir: 'lora/role', size: 3 }
    ]
  }

  /** 按目录名查找树行（根行名称为「全部目录」） */
  function rowByPath(wrapper, name) {
    return wrapper.findAll('.folder-tree .tree-row').find((r) => r.text().includes(name))
  }

  it('展示根与顶层目录及子树模型数，深层目录默认折叠', () => {
    setupTree()
    const wrapper = mount(Sidebar)
    const rootRow = rowByPath(wrapper, '全部目录')
    const loraRow = rowByPath(wrapper, 'lora')
    expect(rootRow.exists()).toBe(true)
    expect(loraRow.exists()).toBe(true)
    expect(loraRow.find('.tree-count').text()).toBe('2')
    // lora/role 默认不出现
    expect(rowByPath(wrapper, 'role')).toBeUndefined()
  })

  it('展开后显示深层目录', async () => {
    setupTree()
    const wrapper = mount(Sidebar)
    await rowByPath(wrapper, 'lora').find('.tree-caret').trigger('click')
    await flushPromises()
    expect(rowByPath(wrapper, 'role').exists()).toBe(true)
  })

  it('点击目录设置 dirFilter 筛选并高亮；再点同目录取消；点根节点取消', async () => {
    setupTree()
    const wrapper = mount(Sidebar)
    const loraRow = rowByPath(wrapper, 'lora')
    await loraRow.trigger('click')
    expect(state.dirFilter).toBe('lora')
    expect(rowByPath(wrapper, 'lora').classes()).toContain('active')

    await rowByPath(wrapper, 'lora').trigger('click')
    expect(state.dirFilter).toBe('')

    await rowByPath(wrapper, 'lora').trigger('click')
    await rowByPath(wrapper, '全部目录').trigger('click')
    expect(state.dirFilter).toBe('')
  })

  it('拖拽模型卡片到目录行触发移动（B-06）：确认后调用 moveModels IPC', async () => {
    setupTree()
    window.api.models.moveModels.mockResolvedValue({
      moved: [{ from: 'D:\\libA\\lora\\a.safetensors', to: 'D:\\libA\\lora\\a.safetensors', model: { id: 'x' } }],
      failed: [],
      destDir: 'lora'
    })
    const wrapper = mount(Sidebar)
    const dataTransfer = {
      types: ['application/x-modelvault-ids'],
      getData: () => JSON.stringify(['D:\\libA\\lora\\a.safetensors'])
    }
    const loraRow = rowByPath(wrapper, 'lora')
    await loraRow.trigger('dragover', { dataTransfer })
    await loraRow.trigger('drop', { dataTransfer })
    acceptConfirm()
    await flushPromises()
    expect(window.api.models.moveModels).toHaveBeenCalledWith({
      ids: ['D:\\libA\\lora\\a.safetensors'],
      destDir: 'lora'
    })
  })
})
