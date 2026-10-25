import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  batchEditTags,
  normalizeBatchTags,
  replaceModels,
  state,
} from '../src/renderer/src/store/appStore'

/**
 * 批量自由标签编辑（FEAT-01）store 测试：
 * - 添加 / 移除 / 替换三种语义
 * - 标签归一化（去空白/截断/去重）
 * - 超上限、空输入、busy/取消等边界
 */

const id = (name) => `D:\\models\\${name}.safetensors`

/** 注入模型（tags 可覆盖） */
function seedModels(models) {
  replaceModels(
    models.map((m, i) => ({
      id: m.id || id(m.name),
      name: m.name,
      type: 'lora',
      tags: m.tags || [],
      size: 1 + i,
      mtimeMs: 1,
      favorite: false,
      nsfw: false,
      rating: 0,
      alias: '',
      note: '',
      subCategory: '',
      triggerWords: '',
      coverUrl: '',
      covers: [],
      ...m,
    })),
  )
}

/** window.api 桩：setModelTags 原样回显标签 */
function makeApi() {
  return {
    api: {
      models: {
        setModelTags: vi.fn((modelId, tags) =>
          Promise.resolve({ meta: { tags } }),
        ),
      },
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('window', makeApi())
  vi.stubGlobal('document', {
    documentElement: {
      classList: { toggle: vi.fn() },
      style: { setProperty: vi.fn() },
    },
  })
  state.folder = 'D:\\models'
  state.typeFilter = 'all'
  state.subFilter = ''
  state.tagFilters = []
  state.search = ''
  state.multiSelect.active = true
  state.multiSelect.ids = []
  state.multiSelect.busy = false
  state.multiSelect.progress = ''
  state.multiSelect.cancelRequested = false
  state.toasts.splice(0, state.toasts.length)
  seedModels([
    { name: 'a', tags: ['已有'] },
    { name: 'b', tags: [] },
  ])
})

describe('normalizeBatchTags', () => {
  it('数组/逗号字符串均可：去空白、截断 32 字、精确去重、上限 20', () => {
    expect(normalizeBatchTags([' 风格 ', '角色', '风格', ''])).toEqual([
      '风格',
      '角色',
    ])
    expect(normalizeBatchTags('风格, 角色，概念')).toEqual([
      '风格',
      '角色',
      '概念',
    ])
    expect(normalizeBatchTags(['x'.repeat(40)])[0]).toHaveLength(32)
    expect(
      normalizeBatchTags(Array.from({ length: 30 }, (_, i) => `t${i}`)),
    ).toHaveLength(20)
    expect(normalizeBatchTags(null)).toEqual([])
  })
})

describe('batchEditTags', () => {
  it('添加：保留现有标签并去重', async () => {
    state.multiSelect.ids = [id('a'), id('b')]
    await expect(
      batchEditTags({ mode: 'add', tags: ['已有', '新标签'] }),
    ).resolves.toBe(true)
    expect(window.api.models.setModelTags).toHaveBeenCalledTimes(2)
    expect(state.models.find((m) => m.id === id('a')).tags).toEqual([
      '已有',
      '新标签',
    ])
    expect(state.models.find((m) => m.id === id('b')).tags).toEqual([
      '已有',
      '新标签',
    ])
  })

  it('移除：只移除命中的同名标签', async () => {
    seedModels([
      { name: 'a', tags: ['x', 'y'] },
      { name: 'b', tags: ['x'] },
    ])
    state.multiSelect.ids = [id('a'), id('b')]
    await expect(batchEditTags({ mode: 'remove', tags: ['x'] })).resolves.toBe(
      true,
    )
    expect(state.models.find((m) => m.id === id('a')).tags).toEqual(['y'])
    expect(state.models.find((m) => m.id === id('b')).tags).toEqual([])
  })

  it('替换：整体覆写为输入标签', async () => {
    state.multiSelect.ids = [id('a'), id('b')]
    await expect(
      batchEditTags({ mode: 'replace', tags: ['统一', '统一'] }),
    ).resolves.toBe(true)
    expect(state.models.find((m) => m.id === id('a')).tags).toEqual(['统一'])
    expect(state.models.find((m) => m.id === id('b')).tags).toEqual(['统一'])
  })

  it('全部无变化时不发 IPC 并提示', async () => {
    state.multiSelect.ids = [id('a')]
    await expect(batchEditTags({ mode: 'add', tags: ['已有'] })).resolves.toBe(
      false,
    )
    expect(window.api.models.setModelTags).not.toHaveBeenCalled()
    expect(
      state.toasts.some((t) => t.text.includes('没有需要更新标签的模型')),
    ).toBe(true)
  })

  it('添加后超过 20 个标签上限的模型跳过，其余继续', async () => {
    seedModels([
      { name: 'full', tags: Array.from({ length: 20 }, (_, i) => `t${i}`) },
      { name: 'room', tags: [] },
    ])
    state.multiSelect.ids = [id('full'), id('room')]
    await expect(batchEditTags({ mode: 'add', tags: ['new'] })).resolves.toBe(
      true,
    )
    expect(window.api.models.setModelTags).toHaveBeenCalledTimes(1)
    expect(window.api.models.setModelTags).toHaveBeenCalledWith(id('room'), [
      'new',
    ])
    expect(state.toasts.some((t) => t.text.includes('超上限跳过 1 个'))).toBe(
      true,
    )
  })

  it('空标签、未知模式、busy 与取消均不发 IPC', async () => {
    state.multiSelect.ids = [id('a')]
    expect(await batchEditTags({ mode: 'add', tags: [] })).toBe(false)
    expect(await batchEditTags({ mode: 'bogus', tags: ['x'] })).toBe(false)
    expect(await batchEditTags({ mode: 'toString', tags: ['x'] })).toBe(false)
    state.multiSelect.busy = true
    expect(await batchEditTags({ mode: 'add', tags: ['x'] })).toBe(false)
    state.multiSelect.busy = false
    state.multiSelect.cancelRequested = true
    expect(await batchEditTags({ mode: 'add', tags: ['x'] })).toBe(false)
    expect(window.api.models.setModelTags).not.toHaveBeenCalled()
  })

  it('部分 IPC 失败仍保留成功项并汇总提示', async () => {
    state.multiSelect.ids = [id('a'), id('b')]
    window.api.models.setModelTags.mockImplementation((modelId, tags) =>
      modelId === id('b')
        ? Promise.resolve({ error: '写入失败' })
        : Promise.resolve({ meta: { tags } }),
    )
    await expect(batchEditTags({ mode: 'add', tags: ['x'] })).resolves.toBe(
      true,
    )
    expect(state.models.find((m) => m.id === id('a')).tags).toEqual([
      '已有',
      'x',
    ])
    expect(state.models.find((m) => m.id === id('b')).tags).toEqual([])
    expect(
      state.toasts.some(
        (t) => t.type === 'warn' && t.text.includes('失败 1 个'),
      ),
    ).toBe(true)
  })
})
