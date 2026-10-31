import { describe, it, expect, beforeEach } from 'vitest'
import { setModelCoverUrl } from '../src/renderer/src/store/cover-overrides'
import {
  makeApiMock,
  resetStoreTestState,
  makeModel,
} from './helpers/storeTest'
import {
  applyThumbUpdates,
  coverThumbUrl,
  modelById,
  modelCoverUrl,
  deleteModel,
  replaceModels,
  saveSettings,
  selectedModel,
  state,
  toggleFavorite,
} from '../src/renderer/src/store/appStore'

/**
 * appStoreMeta.test.js（ENG-1 自 appStore.test.js 按域拆分，用例内容保持原样）
 */

let api

beforeEach(() => {
  api = makeApiMock()
  resetStoreTestState(api)
})

describe('toggleFavorite（A6 错误可见性）', () => {
  it('成功时以返回的 meta 同步本地状态', async () => {
    state.models = [makeModel('m1', { favorite: false })]
    api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: true, nsfw: false, rating: 0 },
    })
    const ok = await toggleFavorite('m1')
    expect(ok).toBe(true)
    expect(api.models.setMetaFlags).toHaveBeenCalledWith({
      id: 'm1',
      favorite: true,
    })
    expect(state.models[0].favorite).toBe(true)
  })

  it('IPC reject 时 toast 提示且返回 false（不再 unhandledrejection）', async () => {
    state.models = [makeModel('m1')]
    api.models.setMetaFlags.mockRejectedValue(new Error('IPC 断开'))
    const ok = await toggleFavorite('m1')
    expect(ok).toBe(false)
    expect(state.toasts.some((t) => t.text.includes('收藏操作失败'))).toBe(true)
  })

  it('业务错误（res.error）时 toast 提示且本地状态不变', async () => {
    state.models = [makeModel('m1', { favorite: false })]
    api.models.setMetaFlags.mockResolvedValue({ error: '模型不存在' })
    const ok = await toggleFavorite('m1')
    expect(ok).toBe(false)
    expect(state.models[0].favorite).toBe(false)
    expect(state.toasts.some((t) => t.text.includes('模型不存在'))).toBe(true)
  })
})

describe('标注操作响应传播（shallowReactive 回归）', () => {
  it('元素级更新后派生状态（selectedModel/filteredModels）立即同步，无需整体替换', async () => {
    // 与真实扫描一致：列表经 replaceModels 装配（数组为 shallowReactive 代理）
    replaceModels([
      makeModel('m1', { name: '甲', favorite: false }),
      makeModel('m2', { name: '乙' }),
    ])
    api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: true, nsfw: true, rating: 3 },
    })
    state.selectedId = 'm1'
    expect(selectedModel.value.favorite).toBe(false)
    expect(selectedModel.value.nsfw).toBe(false)

    await toggleFavorite('m1')

    // 数据层：元素对象已就位替换
    expect(state.models[0].favorite).toBe(true)
    // 响应传播层（回归核心）：shallowReactive 下元素级索引赋值必须触发
    // modelById→selectedModel 重算，否则详情页标注按钮点击后视觉无变化
    expect(selectedModel.value.favorite).toBe(true)
    expect(selectedModel.value.nsfw).toBe(true)
    expect(selectedModel.value.rating).toBe(3)
  })

  it('元素级替换：映射值增量同步且下游传播保持（OPT-1，不再整表重建）', async () => {
    // 与真实扫描一致：列表经 replaceModels 装配（数组为 shallowReactive 代理）
    replaceModels([
      makeModel('m1', { favorite: false }),
      makeModel('m2', { favorite: false }),
    ])
    state.selectedId = 'm1'
    expect(modelById.value.get('m1').favorite).toBe(false)

    api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: true, nsfw: false, rating: 5 },
    })
    await toggleFavorite('m1')

    // 值经增量同步即时更新——旧实现在此整表重建新 Map（数千模型库上
    // 每次标注点击一次 O(n) 哈希+分配，即本优化消除的热点）
    expect(modelById.value.get('m1').favorite).toBe(true)
    expect(modelById.value.get('m2')).toBe(state.models[1])
    // 下游派生传播保持（Vue 3.4+ 以 Object.is 判定 computed 值变化并决定
    // 是否向下游传播）：selectedModel 必须读到新对象
    expect(selectedModel.value.favorite).toBe(true)

    // 数组整体替换（切库/重扫语义）→ 全量重建，旧键不残留
    replaceModels([makeModel('m3')])
    expect(modelById.value.get('m1')).toBeUndefined()
    expect(modelById.value.get('m3')).toBe(state.models[0])
  })

  it('未经 replaceModels 装配的原始数组不具备该保证（守卫约定边界）', async () => {
    // 直接裸赋值（测试遗留写法）：数据会变，但派生状态不重算——
    // 固化「数组级更新必须走 replaceModels」的约定，防止约定被悄然破坏
    state.models = [makeModel('m1', { favorite: false })]
    state.selectedId = 'm1'
    expect(selectedModel.value.favorite).toBe(false) // 先读一次，建立派生缓存
    api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: true, nsfw: false, rating: 0 },
    })
    await toggleFavorite('m1')
    expect(state.models[0].favorite).toBe(true)
    expect(selectedModel.value.favorite).toBe(false)
  })
})

describe('deleteModel', () => {
  it('成功时从列表移除并清理选中态', async () => {
    state.models = [makeModel('m1'), makeModel('m2')]
    state.selectedId = 'm1'
    api.models.deleteModel.mockResolvedValue({})
    const ok = await deleteModel('m1')
    expect(ok).toBe(true)
    expect(state.models.map((m) => m.id)).toEqual(['m2'])
    expect(state.selectedId).toBeNull()
  })

  it('IPC reject 时 toast 提示且列表不变（A6）', async () => {
    state.models = [makeModel('m1')]
    api.models.deleteModel.mockRejectedValue(new Error('回收站不可用'))
    const ok = await deleteModel('m1')
    expect(ok).toBe(false)
    expect(state.models).toHaveLength(1)
    expect(state.toasts.some((t) => t.text.includes('删除模型失败'))).toBe(true)
  })
})

describe('saveSettings', () => {
  it('成功时更新本地设置', async () => {
    api.settings.update.mockResolvedValue({
      settings: { ...state.settings, sortBy: 'mtime' },
    })
    const ok = await saveSettings({ sortBy: 'mtime' })
    expect(ok).toBe(true)
    expect(state.settings.sortBy).toBe('mtime')
  })

  it('IPC reject 时 toast 提示且返回 false（A6：排序切换等静默失败修复）', async () => {
    api.settings.update.mockRejectedValue(new Error('磁盘错误'))
    const ok = await saveSettings({ sortBy: 'mtime' })
    expect(ok).toBe(false)
    expect(state.toasts.some((t) => t.text.includes('设置保存失败'))).toBe(true)
  })

  it('业务错误（res.error）时 toast 提示且不更新本地设置', async () => {
    api.settings.update.mockResolvedValue({
      error: '模型文件夹不存在或不是目录',
    })
    const ok = await saveSettings({ modelsFolder: 'D:/no-such-dir' })
    expect(ok).toBe(false)
    expect(state.toasts.some((t) => t.text.includes('模型文件夹不存在'))).toBe(
      true,
    )
  })
})

describe('applyThumbUpdates', () => {
  it('按 id 写入展示覆盖；模型对象保持引用与字段不变', () => {
    state.models = [
      makeModel('m1', { coverUrl: 'orig' }),
      makeModel('m2', { coverUrl: 'orig2' }),
    ]
    const before = state.models[0]
    applyThumbUpdates([
      { id: 'm1', coverUrl: 'thumb1' },
      { id: 'missing', coverUrl: 'x' },
      { id: 'm2', coverUrl: '' },
    ])
    expect(modelCoverUrl(state.models[0])).toBe('thumb1')
    expect(state.models[1].coverUrl).toBe('orig2')
    // OP-02：覆盖映射独立，领域对象不被替换
    expect(state.models[0]).toBe(before)
    expect(state.models[0].coverUrl).toBe('orig')
    applyThumbUpdates('not-an-array')
    expect(state.models).toHaveLength(2)
  })

  it('coverThumb 按 path 写入覆盖，不修改 covers 条目（OPT-1）', () => {
    state.models = [
      makeModel('m1', {
        coverUrl: 'orig',
        covers: [
          { rel: 'a.png', path: 'p-a', url: 'u-a' },
          { rel: 'b.png', path: 'p-b', url: 'u-b' },
        ],
      }),
    ]
    // 仅 coverThumb：默认封面 URL 不变，目标 covers 条目的展示缩略图走覆盖
    applyThumbUpdates([
      { id: 'm1', coverThumb: { path: 'p-b', thumbUrl: 't-b' } },
    ])
    expect(modelCoverUrl(state.models[0])).toBe('orig')
    expect(coverThumbUrl(state.models[0].covers[0])).toBe('')
    expect(coverThumbUrl(state.models[0].covers[1])).toBe('t-b')
    expect(state.models[0].covers[1].thumbUrl).toBeUndefined()
    // coverUrl 与 coverThumb 同时携带时一并生效；未知 path 静默忽略
    applyThumbUpdates([
      {
        id: 'm1',
        coverUrl: 'thumb1',
        coverThumb: { path: 'p-a', thumbUrl: 't-a' },
      },
      { id: 'm1', coverThumb: { path: 'p-missing', thumbUrl: 't-x' } },
    ])
    expect(modelCoverUrl(state.models[0])).toBe('thumb1')
    expect(coverThumbUrl(state.models[0].covers[0])).toBe('t-a')
    expect(coverThumbUrl(state.models[0].covers[1])).toBe('t-b')
  })

  it('coverThumb 与 coverUrl 均缺省的更新被忽略', () => {
    state.models = [makeModel('m1', { coverUrl: 'orig' })]
    applyThumbUpdates([{ id: 'm1' }])
    expect(modelCoverUrl(state.models[0])).toBe('orig')
  })

  it('封面替换/清空时覆盖同步：空值回退模型自带字段', () => {
    const m = makeModel('m1', { coverUrl: 'orig' })
    state.models = [m]
    setModelCoverUrl('m1', 'thumb')
    expect(modelCoverUrl(m)).toBe('thumb')
    // 清空封面：覆盖删除，回退模型对象（coverUrl 置空则展示占位）
    setModelCoverUrl('m1', '')
    expect(modelCoverUrl(m)).toBe('orig')
    setModelCoverUrl('m1', 'new-cover')
    expect(modelCoverUrl(m)).toBe('new-cover')
  })

  it('批次更新不触发模型元素替换（避免全量派生重算）', () => {
    replaceModels([
      makeModel('m1', {
        coverUrl: 'orig',
        covers: [
          { rel: 'a.png', path: 'p-a', url: 'u-a' },
          { rel: 'b.png', path: 'p-b', url: 'u-b' },
        ],
      }),
    ])
    const before = state.models[0]
    applyThumbUpdates([
      { id: 'm1', coverUrl: 't-default' },
      { id: 'm1', coverThumb: { path: 'p-a', thumbUrl: 't-a' } },
      { id: 'm1', coverThumb: { path: 'p-b', thumbUrl: 't-b' } },
    ])

    expect(state.models[0]).toBe(before)
    expect(modelCoverUrl(state.models[0])).toBe('t-default')
    expect(state.models[0].covers.map(coverThumbUrl)).toEqual(['t-a', 't-b'])
  })
})
