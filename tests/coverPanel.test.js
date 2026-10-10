// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CoverPanel from '../src/renderer/src/components/detail/CoverPanel.vue'
import { state } from '../src/renderer/src/store/appStore'
import { setupComponentTest, settle } from './helpers/componentTest'

/**
 * CoverPanel 组件测试（OPT-16 基建；OPT-9 回归）：
 * 多文件拖入导入的批量行为——路径预解析、逐文件 IPC、末尾单趟状态应用、
 * 汇总提示分级（成功/warn/error）、单张失败不中断其余。
 */

setupComponentTest()

/** 构造最小模型对象并选中（封面字段与装饰结果对齐） */
function selectModel(overrides = {}) {
  const m = {
    id: 'm1',
    name: 'm1',
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
    cover: '',
    coverUrl: '',
    covers: [],
    ...overrides
  }
  state.models = [m]
  state.selectedId = 'm1'
  return m
}

/** 构造 File-like 拖入对象（携带 path，helper 桩据此解析真实路径） */
function dropFile(name) {
  return { name, path: `D:\\imgs\\${name}` }
}

/** 触发拖放事件（dataTransfer 携带文件列表） */
function dropFiles(wrapper, files) {
  return wrapper
    .find('.detail-cover')
    .trigger('drop', { dataTransfer: { files, types: ['Files'] } })
}

/** importCover 的成功响应（covers 为最新完整列表） */
function coverRes(n) {
  return {
    cover: `abs-${n}`,
    coverUrl: `url-${n}`,
    covers: Array.from({ length: n }, (_, i) => ({
      rel: `c${i + 1}`,
      path: `p${i + 1}`,
      url: `u${i + 1}`
    })),
    meta: {}
  }
}

describe('CoverPanel 多文件拖入导入（OPT-9 回归）', () => {
  it('多文件全部成功：逐文件调用 IPC，末尾单趟应用并汇总提示', async () => {
    selectModel()
    let call = 0
    window.api.models.importCover.mockImplementation(() => {
      call += 1
      return Promise.resolve(coverRes(call))
    })
    const wrapper = mount(CoverPanel)
    await dropFiles(wrapper, [dropFile('a.png'), dropFile('b.png')])
    await settle()
    expect(window.api.models.importCover).toHaveBeenCalledTimes(2)
    expect(window.api.models.importCover).toHaveBeenCalledWith('m1', 'D:\\imgs\\a.png')
    expect(window.api.models.importCover).toHaveBeenCalledWith('m1', 'D:\\imgs\\b.png')
    // 末尾单趟应用：covers 为最后一次响应的完整列表
    expect(state.models[0].covers).toHaveLength(2)
    expect(state.models[0].coverUrl).toBe('url-2')
    // 仅一条汇总 toast（旧实现会逐张弹 N 条）
    expect(state.toasts).toHaveLength(1)
    expect(state.toasts[0].type).toBe('success')
    expect(state.toasts[0].text).toBe('封面导入完成：成功 2 张')
  })

  it('单张失败不中断其余：warn 汇总含失败计数，成功张仍应用', async () => {
    selectModel()
    window.api.models.importCover.mockImplementation((id, path) =>
      path === 'D:\\imgs\\bad.png'
        ? Promise.resolve({ error: '文件内容不是有效的图片，已拒绝导入' })
        : Promise.resolve(coverRes(1))
    )
    const wrapper = mount(CoverPanel)
    await dropFiles(wrapper, [dropFile('a.png'), dropFile('bad.png'), dropFile('b.png')])
    await settle()
    // 关键回归点：旧实现第一张失败即中断，后续不再导入
    expect(window.api.models.importCover).toHaveBeenCalledTimes(3)
    expect(state.models[0].covers).toHaveLength(1)
    expect(state.toasts).toHaveLength(1)
    expect(state.toasts[0].type).toBe('warn')
    expect(state.toasts[0].text).toBe('封面导入完成：成功 2 张，失败 1 张')
  })

  it('无法解析路径的文件计为跳过并计入汇总', async () => {
    selectModel()
    window.api.models.importCover.mockResolvedValue(coverRes(1))
    const wrapper = mount(CoverPanel)
    // 第二项无 path（getPathForFile 返回空 → 跳过，不进 IPC）
    await dropFiles(wrapper, [dropFile('a.png'), { name: 'weird' }])
    await settle()
    expect(window.api.models.importCover).toHaveBeenCalledTimes(1)
    expect(state.toasts[0].type).toBe('warn')
    expect(state.toasts[0].text).toBe('封面导入完成：成功 1 张，跳过 1 个')
  })

  it('全部失败时给出 error 汇总且不应用状态', async () => {
    selectModel()
    window.api.models.importCover.mockResolvedValue({ error: '不支持的格式' })
    const wrapper = mount(CoverPanel)
    await dropFiles(wrapper, [dropFile('a.png'), dropFile('b.png')])
    await settle()
    expect(window.api.models.importCover).toHaveBeenCalledTimes(2)
    expect(state.models[0].covers).toHaveLength(0)
    expect(state.toasts[0].type).toBe('error')
    expect(state.toasts[0].text).toBe('封面导入失败：成功 0 张，失败 2 张')
  })

  it('拖入项全部无法解析路径时提示且不调用 IPC', async () => {
    selectModel()
    const wrapper = mount(CoverPanel)
    await dropFiles(wrapper, [{ name: 'x' }, { name: 'y' }])
    await settle()
    expect(window.api.models.importCover).not.toHaveBeenCalled()
    expect(state.toasts[0].text).toContain('未能解析拖入的文件')
  })

  it('导入期间按钮置忙（busy），结束后恢复', async () => {
    selectModel()
    let resolveIpc
    window.api.models.importCover.mockImplementation(
      () => new Promise((resolve) => {
        resolveIpc = resolve
      })
    )
    const wrapper = mount(CoverPanel)
    const dropPromise = dropFiles(wrapper, [dropFile('a.png')])
    await settle()
    // IPC 在途：上传/粘贴按钮禁用
    expect(wrapper.find('button.btn-primary').attributes('disabled')).toBeDefined()
    resolveIpc(coverRes(1))
    await dropPromise
    await settle()
    expect(wrapper.find('button.btn-primary').attributes('disabled')).toBeUndefined()
  })
})
