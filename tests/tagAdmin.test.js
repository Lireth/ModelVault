import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  makeApiMock,
  resetStoreTestState,
  makeModel,
} from './helpers/storeTest'
import {
  removeTagGlobally,
  renameTagGlobally,
} from '../src/renderer/src/store/tag-admin'
import { state } from '../src/renderer/src/store/appStore'

/**
 * 全库标签管理 store 测试（F4，O-1 覆盖盲区回补）：
 * tag-admin.js 为数据完整性关键路径（整库改写 store.json 后本地同步），
 * 此前 0% 覆盖。用例覆盖：
 * - 重命名/移除的本地同步语义（未命中模型保持对象引用不变——浅响应约定）
 * - 目标名已存在时的合并去重（大小写不敏感，保留首次写法）
 * - IPC 业务错误（res.error）与通道异常（reject）两条失败路径
 */

let api

beforeEach(() => {
  api = makeApiMock()
  // F4 标签管理通道：storeTest 通用桩未含（历史无覆盖），此处补齐
  api.models.renameTag = vi.fn()
  api.models.removeTag = vi.fn()
  resetStoreTestState(api)
})

describe('全库重命名标签（renameTagGlobally）', () => {
  it('命中模型逐个替换标签，未命中模型保持同一对象引用', async () => {
    state.models = [
      makeModel('m1', { tags: ['red', 'blue'] }),
      makeModel('m2', { tags: ['red'] }),
      makeModel('m3', { tags: ['green'] }),
    ]
    const untouched = state.models[2]
    api.models.renameTag.mockResolvedValue({ changed: 2 })

    const res = await renameTagGlobally('red', 'crimson')

    expect(api.models.renameTag).toHaveBeenCalledWith('red', 'crimson')
    expect(res).toEqual({ changed: 2 })
    expect(state.models[0].tags).toEqual(['crimson', 'blue'])
    expect(state.models[1].tags).toEqual(['crimson'])
    // 未命中：元素整体不替换（与 meta-apply 的浅响应约定一致）
    expect(state.models[2]).toBe(untouched)
    expect(state.toasts.some((t) => t.text.includes('2 个模型'))).toBe(true)
    expect(
      state.toasts.some((t) => t.type === 'success' && t.text.includes('crimson')),
    ).toBe(true)
  })

  it('目标名已存在时合并：重命名后大小写不敏感去重（保留首次写法）', async () => {
    // m1 命中：['a', 'A', 'b'] → 映射为 ['b', 'A', 'b'] → 去重 ['b', 'A']
    state.models = [makeModel('m1', { tags: ['a', 'A', 'b'] })]
    api.models.renameTag.mockResolvedValue({ changed: 1 })

    await renameTagGlobally('a', 'b')

    expect(state.models[0].tags).toEqual(['b', 'A'])
  })

  it('业务错误（res.error）：提示错误并原样返回，本地列表不动', async () => {
    state.models = [makeModel('m1', { tags: ['red'] })]
    const before = state.models[0]
    api.models.renameTag.mockResolvedValue({ changed: 0, error: '标签不存在' })

    const res = await renameTagGlobally('red', 'x')

    expect(res.error).toBe('标签不存在')
    expect(state.models[0]).toBe(before)
    expect(state.toasts.some((t) => t.type === 'error')).toBe(true)
  })

  it('IPC 通道异常：返回 { changed: 0, error } 并提示「标签重命名失败」', async () => {
    state.models = [makeModel('m1', { tags: ['red'] })]
    api.models.renameTag.mockRejectedValue(new Error('IPC 断开'))

    const res = await renameTagGlobally('red', 'x')

    expect(res).toEqual({ changed: 0, error: 'IPC 断开' })
    expect(
      state.toasts.some((t) => t.text.includes('标签重命名失败')),
    ).toBe(true)
    expect(state.models[0].tags).toEqual(['red'])
  })
})

describe('全库移除标签（removeTagGlobally）', () => {
  it('从命中模型上移除标签，未命中模型保持同一对象引用', async () => {
    state.models = [
      makeModel('m1', { tags: ['red', 'blue'] }),
      makeModel('m2', { tags: ['red'] }),
      makeModel('m3', { tags: ['green'] }),
    ]
    const untouched = state.models[2]
    api.models.removeTag.mockResolvedValue({ changed: 2 })

    const res = await removeTagGlobally('red')

    expect(api.models.removeTag).toHaveBeenCalledWith('red')
    expect(res).toEqual({ changed: 2 })
    expect(state.models[0].tags).toEqual(['blue'])
    expect(state.models[1].tags).toEqual([])
    expect(state.models[2]).toBe(untouched)
    expect(
      state.toasts.some(
        (t) => t.type === 'success' && t.text.includes('已移除标签'),
      ),
    ).toBe(true)
  })

  it('业务错误：本地列表不动并提示错误', async () => {
    state.models = [makeModel('m1', { tags: ['red'] })]
    const before = state.models[0]
    api.models.removeTag.mockResolvedValue({ changed: 0, error: '标签不存在' })

    const res = await removeTagGlobally('red')

    expect(res.error).toBe('标签不存在')
    expect(state.models[0]).toBe(before)
    expect(state.toasts.some((t) => t.type === 'error')).toBe(true)
  })

  it('IPC 通道异常：返回 { changed: 0, error } 并提示「标签移除失败」', async () => {
    api.models.removeTag.mockRejectedValue(new Error('磁盘忙'))

    const res = await removeTagGlobally('red')

    expect(res).toEqual({ changed: 0, error: '磁盘忙' })
    expect(state.toasts.some((t) => t.text.includes('标签移除失败'))).toBe(true)
  })

  it('tags 缺失的模型物化为空数组；有 tags 但未命中的模型保持引用', async () => {
    state.models = [makeModel('m1'), makeModel('m2', { tags: ['blue'] }), makeModel('m3', { tags: ['red'] })]
    const untouched = state.models[1]
    api.models.removeTag.mockResolvedValue({ changed: 2 })

    await removeTagGlobally('red')

    // m1 无 tags 字段：edit([]) 返回新建空数组 → 引用必然变化（物化为 tags: []）
    expect(state.models[0].tags).toEqual([])
    // m2 有 tags 但不含目标：edit 返回原数组引用 → 整个模型对象不替换
    expect(state.models[1]).toBe(untouched)
    expect(state.models[2].tags).toEqual([])
  })
})
