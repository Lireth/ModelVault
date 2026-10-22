// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  removeTagGlobally,
  renameTagGlobally,
  replaceModels,
  state
} from '../src/renderer/src/store/appStore'

/**
 * 全库标签管理 store 模块测试（F4）：
 * - 重命名：本地列表同步替换 + 合并去重；未命中的模型引用不变
 * - 移除：仅摘除指定标签
 * - IPC 异常 / 业务错误 → toast 提示且不触碰本地列表
 */

function makeApiMock() {
  return {
    models: {
      renameTag: vi.fn(() => Promise.resolve({ changed: 0 })),
      removeTag: vi.fn(() => Promise.resolve({ changed: 0 }))
    }
  }
}

function seedModels() {
  replaceModels([
    { id: 'a', name: 'a.safetensors', tags: ['角色', '废弃'] },
    { id: 'b', name: 'b.safetensors', tags: ['废弃'] },
    { id: 'c', name: 'c.safetensors', tags: ['风格'] }
  ])
}

function lastToast() {
  return state.toasts[state.toasts.length - 1]
}

beforeEach(() => {
  window.api = makeApiMock()
  seedModels()
  state.toasts.splice(0, state.toasts.length)
})

describe('renameTagGlobally', () => {
  it('整库替换标签并本地同步；未命中的模型引用不变', async () => {
    window.api.models.renameTag.mockResolvedValue({ changed: 2 })
    const res = await renameTagGlobally('废弃', '待清理')
    expect(res).toEqual({ changed: 2 })
    expect(window.api.models.renameTag).toHaveBeenCalledWith('废弃', '待清理')
    expect(state.models[0].tags).toEqual(['角色', '待清理'])
    expect(state.models[1].tags).toEqual(['待清理'])
    // 未命中的模型保持原对象引用（浅响应约定）
    expect(state.models[2].tags).toEqual(['风格'])
    expect(lastToast().type).toBe('success')
  })

  it('目标名已存在时本地去重合并', async () => {
    window.api.models.renameTag.mockResolvedValue({ changed: 2 })
    await renameTagGlobally('废弃', '角色')
    expect(state.models[0].tags).toEqual(['角色'])
    expect(state.models[1].tags).toEqual(['角色'])
  })

  it('业务错误 toast 提示且不触碰本地列表', async () => {
    window.api.models.renameTag.mockResolvedValue({ error: '标签名称不能为空' })
    const res = await renameTagGlobally('', 'x')
    expect(res.error).toBe('标签名称不能为空')
    expect(lastToast().text).toBe('标签名称不能为空')
    expect(state.models[0].tags).toEqual(['角色', '废弃'])
  })

  it('IPC 异常 toast 提示', async () => {
    window.api.models.renameTag.mockRejectedValue(new Error('IPC 断开'))
    const res = await renameTagGlobally('废弃', 'x')
    expect(res.error).toBe('IPC 断开')
    expect(lastToast().text).toContain('标签重命名失败')
  })
})

describe('removeTagGlobally', () => {
  it('整库移除标签并本地同步', async () => {
    window.api.models.removeTag.mockResolvedValue({ changed: 2 })
    const res = await removeTagGlobally('废弃')
    expect(res).toEqual({ changed: 2 })
    expect(window.api.models.removeTag).toHaveBeenCalledWith('废弃')
    expect(state.models[0].tags).toEqual(['角色'])
    expect(state.models[1].tags).toEqual([])
    expect(state.models[2].tags).toEqual(['风格'])
    expect(lastToast().text).toContain('已移除标签「废弃」')
  })

  it('业务错误 toast 提示且不触碰本地列表', async () => {
    window.api.models.removeTag.mockResolvedValue({ error: '标签名称不能为空' })
    const res = await removeTagGlobally('')
    expect(res.error).toBe('标签名称不能为空')
    expect(state.models[0].tags).toEqual(['角色', '废弃'])
  })
})
