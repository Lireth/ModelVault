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
  effectiveFavorite,
  effectiveNsfw,
  effectiveRating,
  filteredModels,
  modelById,
  modelCoverUrl,
  deleteModel,
  replaceModels,
  saveSettings,
  selectedModel,
  setMetaOverride,
  setRating,
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
  it('成功时以返回的 meta 写入标注覆盖层（P1-1：对象保持引用稳定）', async () => {
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
    // 元素对象不再被替换（O7：避免全量派生失效重排），有效读取器反映新值
    expect(state.models[0].favorite).toBe(false)
    expect(effectiveFavorite(state.models[0])).toBe(true)
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
    expect(effectiveFavorite(state.models[0])).toBe(false)
    expect(state.toasts.some((t) => t.text.includes('模型不存在'))).toBe(true)
  })
})

describe('标注覆盖写入后的读取传播（O7/P1-1 回归）', () => {
  it('覆盖写入后模型对象引用稳定，详情页经有效读取器立即读到新值', async () => {
    // 与真实扫描一致：列表经 replaceModels 装配（数组为 shallowReactive 代理）
    replaceModels([
      makeModel('m1', { name: '甲', favorite: false }),
      makeModel('m2', { name: '乙' }),
    ])
    api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: true, nsfw: true, rating: 3 },
    })
    state.selectedId = 'm1'
    expect(effectiveFavorite(selectedModel.value)).toBe(false)
    expect(effectiveNsfw(selectedModel.value)).toBe(false)

    const before = state.models[0]
    await toggleFavorite('m1')

    // 数据层：元素对象保持引用稳定（不再触发 filteredModels/typeCounts 等
    // 全量派生失效重排与搜索域 WeakMap 缓存失效——本优化消除的热点）
    expect(state.models[0]).toBe(before)
    // 响应传播层（回归核心）：覆盖映射按覆盖键精确失效，详情页标注按钮
    // 经有效读取器点击后视觉立即变化
    expect(effectiveFavorite(selectedModel.value)).toBe(true)
    expect(effectiveNsfw(selectedModel.value)).toBe(true)
    expect(effectiveRating(selectedModel.value)).toBe(3)
  })

  it('modelById 映射不因标注覆盖重建，元素引用跨标注保持（OPT-1）', async () => {
    // 与真实扫描一致：列表经 replaceModels 装配（数组为 shallowReactive 代理）
    replaceModels([
      makeModel('m1', { favorite: false }),
      makeModel('m2', { favorite: false }),
    ])
    state.selectedId = 'm1'
    expect(effectiveFavorite(modelById.value.get('m1'))).toBe(false)

    api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: true, nsfw: false, rating: 5 },
    })
    await toggleFavorite('m1')

    // 标注写入覆盖层：模型对象与映射值引用均保持不变（旧实现在此逐个
    // 元素替换——数千模型库上每次标注点击使 modelById/filteredModels
    // 等派生全部失效重算，即本优化消除的热点）
    expect(effectiveFavorite(modelById.value.get('m1'))).toBe(true)
    expect(modelById.value.get('m1')).toBe(state.models[0])
    expect(modelById.value.get('m2')).toBe(state.models[1])
    // 下游派生传播：selectedModel 引用不变，经有效读取器读到覆盖值
    expect(effectiveFavorite(selectedModel.value)).toBe(true)

    // 数组整体替换（切库/重扫语义）→ 全量重建，旧键不残留
    replaceModels([makeModel('m3')])
    expect(modelById.value.get('m1')).toBeUndefined()
    expect(modelById.value.get('m3')).toBe(state.models[0])
  })

  it('标注覆盖不依赖数组装配方式：裸赋值数组同样经有效读取器生效', async () => {
    // 直接裸赋值（测试遗留写法）：覆盖层的响应性来自 reactive Map 本身，
    // 与数组的 shallowReactive 装配无关——标注值始终即时可读
    state.models = [makeModel('m1', { favorite: false })]
    state.selectedId = 'm1'
    expect(effectiveFavorite(selectedModel.value)).toBe(false) // 先读一次
    api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: true, nsfw: false, rating: 0 },
    })
    await toggleFavorite('m1')
    // 元素对象保持引用稳定（无元素写入），有效读取器即时反映新值
    expect(state.models[0].favorite).toBe(false)
    expect(effectiveFavorite(selectedModel.value)).toBe(true)
  })

  it('覆盖优先、对象值兜底；replaceModels 剪枝消失 id（O7 语义）', () => {
    replaceModels([makeModel('m1', { favorite: true, rating: 2 })])
    setMetaOverride('m1', { favorite: false, nsfw: true, rating: 4 })
    expect(effectiveFavorite(state.models[0])).toBe(false)
    expect(effectiveNsfw(state.models[0])).toBe(true)
    expect(effectiveRating(state.models[0])).toBe(4)
    // 模型对象未被污染
    expect(state.models[0].favorite).toBe(true)
    expect(state.models[0].rating).toBe(2)

    // 列表整体替换：消失 id 的覆盖被剪枝，回归后回退对象自带值
    replaceModels([makeModel('m2', { favorite: false })])
    replaceModels([makeModel('m1', { favorite: true, rating: 2 })])
    expect(effectiveFavorite(state.models[0])).toBe(true)
    expect(effectiveRating(state.models[0])).toBe(2)
  })

  it('即时标注后收藏筛选与评分排序立即生效（无需重扫）', async () => {
    replaceModels([
      makeModel('m1', { name: '甲', favorite: false, rating: 0 }),
      makeModel('m2', { name: '乙', favorite: false, rating: 3 }),
    ])
    state.sortBy = 'rating'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['m2', 'm1'])

    // 收藏筛选：收藏 m2 后进入收藏视图（覆盖写入，未重扫）
    api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: true, nsfw: false, rating: 3 },
    })
    await toggleFavorite('m2')
    state.showFavoritesOnly = true
    expect(filteredModels.value.map((m) => m.id)).toEqual(['m2'])

    // 评分排序：m1 评分覆盖 5 后升至首位（对象值保持 0，排序读覆盖层）
    api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: false, nsfw: false, rating: 5 },
    })
    await setRating('m1', 5)
    state.showFavoritesOnly = false
    expect(filteredModels.value.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(state.models[0].rating).toBe(0)
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
