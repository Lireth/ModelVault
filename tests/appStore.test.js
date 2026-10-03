import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  applyThumbUpdates,
  confirmDialog,
  acceptConfirm,
  deleteModel,
  dismissToast,
  filteredModels,
  formatSize,
  rejectConfirm,
  saveSettings,
  state,
  toast,
  toggleFavorite,
  typeCounts
} from '../src/renderer/src/store/appStore'

/**
 * 渲染进程全局状态仓库单元测试（D2：渲染层此前零测试，近期提交热点）。
 * appStore 为纯 JS 响应式模块（无 DOM 依赖），window/document 以桩注入：
 * - 确认层语义（U4）：同时仅一个确认、后者覆盖前者
 * - 筛选/搜索/排序（U2：收藏优先/评分/方向翻转）
 * - IPC reject 兜底（A6）：失败 toast 提示而非 unhandledrejection 静默进日志
 * - 缩略图增量更新与分类计数派生
 */

/** 构造 window.api 桩（按用例覆写具体方法返回值） */
function makeApiMock() {
  return {
    models: {
      loadStore: vi.fn(),
      scan: vi.fn(),
      cancelScan: vi.fn(() => Promise.resolve({ ok: false })),
      chooseFolder: vi.fn(),
      setMetaFlags: vi.fn(),
      deleteModel: vi.fn(),
      popupMenu: vi.fn(),
      reveal: vi.fn(),
      saveModelData: vi.fn(),
      uploadCover: vi.fn(),
      pasteCover: vi.fn(),
      setDefaultCover: vi.fn(),
      deleteCover: vi.fn(),
      importCover: vi.fn(),
      onScanProgress: vi.fn(() => () => {}),
      onMenuAction: vi.fn(() => () => {}),
      onThumbsReady: vi.fn(() => () => {}),
      onStoreError: vi.fn(() => () => {})
    },
    settings: { update: vi.fn() },
    window: { setTheme: vi.fn(() => Promise.resolve()) },
    app: { getInfo: vi.fn() }
  }
}

let api

beforeEach(() => {
  api = makeApiMock()
  vi.stubGlobal('window', { api })
  // applyTheme（saveSettings/主题切换）会触碰 document
  vi.stubGlobal('document', {
    documentElement: { classList: { toggle: vi.fn() } }
  })
  // 重置模块级单例状态，用例间互不污染
  state.folder = ''
  state.scanning = false
  state.scanError = ''
  state.models = []
  state.typeFilter = 'all'
  state.subFilter = ''
  state.showFavoritesOnly = false
  state.search = ''
  state.sortBy = 'name'
  state.sortAsc = true
  state.selectedId = null
  state.detailDirty = false
  state.settingsOpen = false
  state.toasts.splice(0, state.toasts.length)
  if (state.confirm.resolve) state.confirm.resolve(false)
  state.confirm = { visible: false, text: '', resolve: null }
})

/** 生成测试模型对象 */
function makeModel(id, overrides = {}) {
  return {
    id,
    name: id,
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
    ...overrides
  }
}

describe('确认层（U4）', () => {
  it('confirmDialog 确认/取消分别 resolve true/false', async () => {
    const p1 = confirmDialog('确认操作？')
    acceptConfirm()
    await expect(p1).resolves.toBe(true)
    const p2 = confirmDialog('确认操作？')
    rejectConfirm()
    await expect(p2).resolves.toBe(false)
  })

  it('同时仅允许一个确认：新确认覆盖旧确认（旧的 resolve false）', async () => {
    const first = confirmDialog('第一个')
    const second = confirmDialog('第二个')
    acceptConfirm()
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(true)
  })
})

describe('Toast 通知', () => {
  it('toast 入队后可经 dismissToast 移除', () => {
    toast('error', '错误信息')
    expect(state.toasts).toHaveLength(1)
    expect(state.toasts[0].type).toBe('error')
    dismissToast(state.toasts[0].id)
    expect(state.toasts).toHaveLength(0)
  })
})

describe('formatSize', () => {
  it('按区间选单位；非法输入返回 -', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(2048)).toBe('2.0 KB')
    expect(formatSize(1024 * 1024 * 3.5)).toBe('3.5 MB')
    expect(formatSize(-1)).toBe('-')
    expect(formatSize(Number.NaN)).toBe('-')
  })
})

describe('筛选与排序（filteredModels）', () => {
  beforeEach(() => {
    state.models = [
      makeModel('a', { name: '动漫风格', type: 'lora', favorite: true, rating: 4, size: 300, mtimeMs: 30 }),
      makeModel('b', { name: '写实大模型', type: 'checkpoint', rating: 5, size: 900, mtimeMs: 10 }),
      makeModel('c', { name: 'quick-fix', type: 'vae', size: 600, mtimeMs: 20, alias: '快速修复' })
    ]
  })

  it('按分类筛选；LoRA 子分类仅在选中 LoRA 时生效', () => {
    state.typeFilter = 'lora'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['a'])
    state.typeFilter = 'all'
    expect(filteredModels.value).toHaveLength(3)
  })

  it('搜索覆盖名称/备注名/备注/触发词/分类中文标签', () => {
    state.search = '写实'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['b'])
    state.search = '快速'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['c'])
  })

  it('收藏优先排序：收藏在前，组内按名称；sortAsc=false 翻转结果', () => {
    state.models = [
      makeModel('x', { name: 'a', favorite: false }),
      makeModel('y', { name: 'b', favorite: true }),
      makeModel('z', { name: 'c', favorite: true })
    ]
    state.sortBy = 'favorite'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['y', 'z', 'x'])
    state.sortAsc = false
    expect(filteredModels.value.map((m) => m.id)).toEqual(['x', 'z', 'y'])
  })

  it('按评分排序：高分在前，同分按名称', () => {
    state.sortBy = 'rating'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['b', 'a', 'c'])
  })

  it('按大小/修改时间排序（比较器恒为大/新在前），sortAsc=false 翻转', () => {
    state.sortBy = 'size'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['b', 'c', 'a'])
    state.sortAsc = false
    expect(filteredModels.value.map((m) => m.id)).toEqual(['a', 'c', 'b'])
    state.sortBy = 'mtime'
    state.sortAsc = true
    expect(filteredModels.value.map((m) => m.id)).toEqual(['a', 'c', 'b'])
  })

  it('按分类排序遵循固定分类顺序（checkpoint → vae → lora 依 MODEL_TYPES）', () => {
    state.sortBy = 'type'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['b', 'c', 'a'])
  })

  it('typeCounts 从当前模型列表派生', () => {
    expect(typeCounts.value).toEqual({ all: 3, lora: 1, checkpoint: 1, vae: 1 })
  })
})

describe('toggleFavorite（A6 错误可见性）', () => {
  it('成功时以返回的 meta 同步本地状态', async () => {
    state.models = [makeModel('m1', { favorite: false })]
    api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: true, nsfw: false, rating: 0 }
    })
    const ok = await toggleFavorite('m1')
    expect(ok).toBe(true)
    expect(api.models.setMetaFlags).toHaveBeenCalledWith({ id: 'm1', favorite: true })
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
    api.settings.update.mockResolvedValue({ settings: { ...state.settings, sortBy: 'mtime' } })
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
    api.settings.update.mockResolvedValue({ error: '模型文件夹不存在或不是目录' })
    const ok = await saveSettings({ modelsFolder: 'D:/no-such-dir' })
    expect(ok).toBe(false)
    expect(state.toasts.some((t) => t.text.includes('模型文件夹不存在'))).toBe(true)
  })
})

describe('applyThumbUpdates', () => {
  it('按 id 增量替换 coverUrl；无效输入忽略', () => {
    state.models = [makeModel('m1', { coverUrl: 'orig' }), makeModel('m2', { coverUrl: 'orig2' })]
    applyThumbUpdates([
      { id: 'm1', coverUrl: 'thumb1' },
      { id: 'missing', coverUrl: 'x' },
      { id: 'm2', coverUrl: '' }
    ])
    expect(state.models[0].coverUrl).toBe('thumb1')
    expect(state.models[1].coverUrl).toBe('orig2')
    applyThumbUpdates('not-an-array')
    expect(state.models).toHaveLength(2)
  })
})
