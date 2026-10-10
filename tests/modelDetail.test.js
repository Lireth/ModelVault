// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ModelDetail from '../src/renderer/src/components/ModelDetail.vue'
import { acceptConfirm, rejectConfirm, state } from '../src/renderer/src/store/appStore'
import { setupComponentTest, settle } from './helpers/componentTest'

/**
 * ModelDetail 组件测试（OPT-21）：
 * 表单脏数据保护（C8）涉及用户标注防丢失——覆盖填充基线、脏检测同步、
 * 参数校验（范围/区间）、保存落账、同模型引用替换时保留编辑、
 * ESC 关闭前确认，以及收藏/NSFW/评分/复制触发词的 store 接线。
 */

setupComponentTest()

/** 构造最小模型对象（字段与扫描装饰结果对齐） */
function makeDetailModel(id, overrides = {}) {
  return {
    id,
    name: id,
    type: 'checkpoint',
    size: 2000000,
    mtimeMs: 1000,
    ext: '.safetensors',
    folder: 'D:\\models',
    relDir: 'Checkpoints',
    alias: '',
    note: '',
    subCategory: '',
    triggerWords: '',
    favorite: false,
    nsfw: false,
    rating: 0,
    cover: '',
    coverUrl: '',
    covers: [],
    noteSource: '',
    autoInfo: null,
    params: null,
    ...overrides
  }
}

/** 选中模型并返回（selectedModel 由此派生，挂载即触发表单填充） */
function selectModel(overrides = {}) {
  const m = makeDetailModel('m1', overrides)
  state.models = [m]
  state.selectedId = m.id
  return m
}

/**
 * 挂载详情页：整体 UI 位于 <Teleport to="body">，VTU 的 wrapper.find 触达
 * 传送后节点——以 Teleport 桩令其内联渲染（查询仍走组件树）。
 */
function mountDetail() {
  return mount(ModelDetail, { global: { stubs: { Teleport: true } } })
}

/** 保存按钮（表单操作区主按钮） */
function saveBtn(wrapper) {
  return wrapper.find('.form-actions .btn-primary')
}

describe('ModelDetail 表单填充与脏检测（C8）', () => {
  it('挂载后按模型填充表单，初始非脏', async () => {
    selectModel({
      alias: '我的大模型',
      note: '备注内容',
      params: { steps: 28, cfgMin: 4, cfgMax: 8, sampler: 'euler', scheduler: 'karras', precision: 'FP16', resMin: 512, resMax: 1024 }
    })
    const wrapper = mountDetail()
    await flushPromises()
    // 数值字段按 params 填充（输入框 min/max 与 PARAM_LIMITS 同源，可定位）
    expect(wrapper.find('input[min="1"][max="200"]').element.value).toBe('28')
    const cfgInputs = wrapper.findAll('.range-inputs input')
    expect(cfgInputs[0].element.value).toBe('4')
    expect(cfgInputs[1].element.value).toBe('8')
    expect(wrapper.find('input[maxlength="100"]').element.value).toBe('我的大模型')
    expect(wrapper.find('.note-input').element.value).toBe('备注内容')
    // 脏基线建立：detailDirty 为 false
    expect(state.detailDirty).toBe(false)
    wrapper.unmount()
  })

  it('大模型自动标注为「基底模型」且不可手动更改', async () => {
    selectModel({ type: 'checkpoint' })
    const wrapper = mountDetail()
    await flushPromises()
    const locked = wrapper.findAll('.subcat-chip.locked')
    expect(locked).toHaveLength(1)
    expect(locked[0].text()).toBe('基底模型')
    // 点击不改变表单值（locked 分支直接 return）
    await locked[0].trigger('click')
    expect(state.detailDirty).toBe(false)
    wrapper.unmount()
  })

  it('修改任一字段即置脏（state.detailDirty 同步，供切换前确认）', async () => {
    selectModel()
    const wrapper = mountDetail()
    await flushPromises()
    await wrapper.find('input[maxlength="100"]').setValue('新备注名')
    expect(state.detailDirty).toBe(true)
    wrapper.unmount()
  })

  it('同一模型引用替换（收藏/缩略图补齐）且表单有编辑时保留编辑不重填', async () => {
    const m = selectModel({ alias: '原值' })
    const wrapper = mountDetail()
    await flushPromises()
    const aliasInput = wrapper.find('input[maxlength="100"]')
    await aliasInput.setValue('我的修改')
    expect(state.detailDirty).toBe(true)
    // 服务端推送同 id 新引用（如 toggleFavorite 后 applyMetaFlags）
    state.models = [{ ...m, alias: '服务端新值', favorite: true }]
    await flushPromises()
    // 编辑被保留，未被静默覆盖
    expect(aliasInput.element.value).toBe('我的修改')
    wrapper.unmount()
  })
})

describe('ModelDetail 参数校验与保存', () => {
  it('采样步数超范围：toast 错误且不调用保存 IPC', async () => {
    selectModel()
    const wrapper = mountDetail()
    await flushPromises()
    await wrapper.find('input[min="1"][max="200"]').setValue('999')
    await saveBtn(wrapper).trigger('click')
    expect(state.toasts.some((t) => t.text.includes('采样步数') && t.text.includes('超出合理范围'))).toBe(true)
    expect(window.api.models.saveModelData).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('CFG 最小值大于最大值：toast 错误且不调用保存 IPC', async () => {
    selectModel()
    const wrapper = mountDetail()
    await flushPromises()
    const cfgInputs = wrapper.findAll('.range-inputs input')
    await cfgInputs[0].setValue('8')
    await cfgInputs[1].setValue('4')
    await saveBtn(wrapper).trigger('click')
    expect(state.toasts.some((t) => t.text === 'CFG 最小值不能大于最大值')).toBe(true)
    expect(window.api.models.saveModelData).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('分辨率最小值大于最大值：toast 错误且不调用保存 IPC', async () => {
    selectModel()
    const wrapper = mountDetail()
    await flushPromises()
    const resInputs = wrapper.findAll('.form-grid input[min="16"]')
    await resInputs[0].setValue('2048')
    await resInputs[1].setValue('512')
    await saveBtn(wrapper).trigger('click')
    expect(state.toasts.some((t) => t.text === '最小分辨率不能大于最大分辨率')).toBe(true)
    expect(window.api.models.saveModelData).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('保存成功：载荷完整、本地列表更新、脏标记清除', async () => {
    selectModel({ type: 'lora', triggerWords: '1girl, solo' })
    window.api.models.saveModelData.mockResolvedValue({
      meta: {
        alias: '新备注名',
        note: '',
        params: { steps: null, cfgMin: null, cfgMax: null, sampler: '', scheduler: '', precision: '', resMin: null, resMax: null },
        subCategory: '',
        triggerWords: '1girl, solo'
      }
    })
    const wrapper = mountDetail()
    await flushPromises()
    await wrapper.find('input[maxlength="100"]').setValue('新备注名')
    await saveBtn(wrapper).trigger('click')
    await settle()
    // 载荷：LoRA 携带触发词；非数值参数为空值
    expect(window.api.models.saveModelData).toHaveBeenCalledWith({
      id: 'm1',
      alias: '新备注名',
      params: { steps: null, cfgMin: null, cfgMax: null, sampler: '', scheduler: '', precision: '', resMin: null, resMax: null },
      note: '',
      subCategory: '',
      triggerWords: '1girl, solo'
    })
    // store 已用响应 meta 更新本地列表，脏基线刷新
    expect(state.models[0].alias).toBe('新备注名')
    expect(state.detailDirty).toBe(false)
    expect(state.toasts.some((t) => t.text === '参数已保存')).toBe(true)
    wrapper.unmount()
  })

  it('保存 IPC reject：toast 错误且保持脏状态可重试', async () => {
    selectModel()
    window.api.models.saveModelData.mockRejectedValue(new Error('磁盘错误'))
    const wrapper = mountDetail()
    await flushPromises()
    await wrapper.find('input[maxlength="100"]').setValue('x')
    await saveBtn(wrapper).trigger('click')
    await settle()
    expect(state.toasts.some((t) => t.text.includes('保存失败'))).toBe(true)
    expect(state.detailDirty).toBe(true)
    wrapper.unmount()
  })
})

describe('ModelDetail 关闭保护与快捷操作', () => {
  it('ESC 关闭详情（非脏时直接关闭）', async () => {
    selectModel()
    const wrapper = mountDetail()
    await flushPromises()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(state.selectedId).toBeNull()
    wrapper.unmount()
  })

  it('ESC 且有未保存修改：先确认，取消则保持打开', async () => {
    selectModel()
    const wrapper = mountDetail()
    await flushPromises()
    await wrapper.find('input[maxlength="100"]').setValue('未保存')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(state.confirm.visible).toBe(true)
    rejectConfirm()
    await flushPromises()
    expect(state.selectedId).toBe('m1')
    wrapper.unmount()
  })

  it('ESC 确认后关闭详情', async () => {
    selectModel()
    const wrapper = mountDetail()
    await flushPromises()
    await wrapper.find('input[maxlength="100"]').setValue('未保存')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    acceptConfirm()
    await flushPromises()
    expect(state.selectedId).toBeNull()
    wrapper.unmount()
  })

  it('收藏/NSFW/评分按钮经 setMetaFlags 落账', async () => {
    selectModel()
    // 主进程返回更新后的完整 meta（applyMetaFlags 按整包应用）
    window.api.models.setMetaFlags.mockImplementation((payload) => {
      const m = state.models[0]
      return Promise.resolve({ meta: { ...m, ...payload } })
    })
    const wrapper = mountDetail()
    await flushPromises()
    await wrapper.find('.fav-toggle').trigger('click')
    await settle()
    expect(window.api.models.setMetaFlags).toHaveBeenCalledWith({ id: 'm1', favorite: true })
    await wrapper.find('.nsfw-toggle').trigger('click')
    await settle()
    expect(window.api.models.setMetaFlags).toHaveBeenCalledWith({ id: 'm1', nsfw: true })
    // 点击第 3 颗星 → 评分 3
    await wrapper.findAll('.star')[2].trigger('click')
    await settle()
    expect(window.api.models.setMetaFlags).toHaveBeenCalledWith({ id: 'm1', rating: 3 })
    wrapper.unmount()
  })

  it('LoRA 触发词一键复制到剪贴板', async () => {
    selectModel({ type: 'lora', triggerWords: '1girl, solo' })
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true
    })
    const wrapper = mountDetail()
    await flushPromises()
    await wrapper.find('.trigger-row .btn').trigger('click')
    await settle()
    expect(writeText).toHaveBeenCalledWith('1girl, solo')
    wrapper.unmount()
  })
})
