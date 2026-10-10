import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  acceptConfirm,
  allFilteredSelected,
  applyThumbUpdates,
  batchDeleteModels,
  batchFavorite,
  batchSetSubCategory,
  closeDiskUsage,
  confirmDialog,
  deleteModel,
  dismissToast,
  diskUsage,
  filteredModels,
  formatSize,
  importCoversFromDrop,
  largestModels,
  multiSelectIdSet,
  openDiskUsage,
  partialScanModels,
  rejectConfirm,
  saveSettings,
  scanModels,
  selectedModel,
  sortDirectional,
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
      partialScan: vi.fn(),
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
  state.organize.open = false
  state.organize.pendingIds = []
  state.diskUsage.open = false
  state.toasts.splice(0, state.toasts.length)
  if (state.confirm.resolve) state.confirm.resolve(false)
  state.confirm = { visible: false, text: '', resolve: null }
})

describe('partialScanModels 增量合并（A-03）', () => {
  function setGrid(models) {
    state.folder = 'D:\\models'
    state.models = models
  }

  it('新模型并入列表，子树外模型保持不动', async () => {
    setGrid([
      makeModel('D:\\models\\keep.safetensors', { name: 'keep', relDir: '' }),
      makeModel('D:\\models\\lora\\a.safetensors', { name: 'a', relDir: 'lora' })
    ])
    api.models.partialScan.mockResolvedValue({
      models: [
        makeModel('D:\\models\\lora\\a.safetensors', { name: 'a', relDir: 'lora' }),
        makeModel('D:\\models\\lora\\b.safetensors', { name: 'b', relDir: 'lora' })
      ],
      dirs: ['lora'],
      relinked: 0
    })

    await partialScanModels(['lora'])

    const ids = state.models.map((m) => m.id)
    expect(ids).toContain('D:\\models\\keep.safetensors') // 子树外不动
    expect(ids).toContain('D:\\models\\lora\\a.safetensors') // 子树内存量被新结果替换
    expect(ids).toContain('D:\\models\\lora\\b.safetensors') // 新增
    expect(state.models).toHaveLength(3)
    // IPC 入参透传子树
    expect(api.models.partialScan).toHaveBeenCalledWith({ folder: 'D:\\models', dirs: ['lora'] })
  })

  it('子树内消失的模型从列表移除，子树外模型保留', async () => {
    setGrid([
      makeModel('D:\\models\\lora\\gone.safetensors', { name: 'gone', relDir: 'lora' }),
      makeModel('D:\\models\\keep.safetensors', { name: 'keep', relDir: '' })
    ])
    api.models.partialScan.mockResolvedValue({ models: [], dirs: ['lora'], relinked: 0 })

    await partialScanModels(['lora'])

    const ids = state.models.map((m) => m.id)
    expect(ids).not.toContain('D:\\models\\lora\\gone.safetensors')
    expect(ids).toContain('D:\\models\\keep.safetensors')
  })

  it('dirs 含根目录空串时影响根直属模型，但不影响子目录模型', async () => {
    setGrid([
      makeModel('D:\\models\\root-file.safetensors', { name: 'root-file', relDir: '' }),
      makeModel('D:\\models\\lora\\deep.safetensors', { name: 'deep', relDir: 'lora' })
    ])
    api.models.partialScan.mockResolvedValue({ models: [], dirs: [''], relinked: 0 })

    await partialScanModels([''])

    const ids = state.models.map((m) => m.id)
    expect(ids).not.toContain('D:\\models\\root-file.safetensors')
    expect(ids).toContain('D:\\models\\lora\\deep.safetensors')
  })

  it('合并后同步清理多选选区中已消失的 id', async () => {
    setGrid([
      makeModel('D:\\models\\lora\\gone.safetensors', { name: 'gone', relDir: 'lora' }),
      makeModel('D:\\models\\keep.safetensors', { name: 'keep', relDir: '' })
    ])
    state.multiSelect.active = true
    state.multiSelect.ids = ['D:\\models\\lora\\gone.safetensors', 'D:\\models\\keep.safetensors']
    api.models.partialScan.mockResolvedValue({ models: [], dirs: ['lora'], relinked: 0 })

    await partialScanModels(['lora'])

    expect(state.multiSelect.ids).toEqual(['D:\\models\\keep.safetensors'])
  })

  it('子树内当前打开详情的模型消失时关闭详情', async () => {
    setGrid([makeModel('D:\\models\\lora\\gone.safetensors', { name: 'gone', relDir: 'lora' })])
    state.selectedId = 'D:\\models\\lora\\gone.safetensors'
    api.models.partialScan.mockResolvedValue({ models: [], dirs: ['lora'], relinked: 0 })

    await partialScanModels(['lora'])

    expect(state.selectedId).toBeNull()
  })

  it('dirs 为空/缺省时回退全量扫描（防御 watcher 载荷异常）', async () => {
    setGrid([])
    api.models.scan.mockResolvedValue({ models: [makeModel('m1')], errors: [] })
    api.models.partialScan.mockResolvedValue({ models: [makeModel('m2')], dirs: [] })

    await partialScanModels([])

    expect(api.models.scan).toHaveBeenCalled()
    expect(api.models.partialScan).not.toHaveBeenCalled()
  })

  it('IPC 返回错误时 toast 提示且不改动列表', async () => {
    setGrid([makeModel('keep-id')])
    api.models.partialScan.mockRejectedValue(new Error('局部扫描失败'))

    await partialScanModels(['lora'])

    expect(state.models.map((m) => m.id)).toEqual(['keep-id'])
    expect(state.toasts.some((t) => t.type === 'error')).toBe(true)
  })
})

describe('scanModels 重关联提示（A-02）', () => {
  beforeEach(() => {
    state.folder = 'D:\\models'
  })

  it('扫描响应含 relinked>0 时成功提示追加「自动重新关联 N 个」', async () => {
    api.models.scan.mockResolvedValue({ models: [makeModel('m1')], errors: [], relinked: 2 })
    await scanModels()
    const notice = state.toasts.find((t) => t.type === 'success')
    expect(notice.text).toContain('发现 1 个模型')
    expect(notice.text).toContain('自动重新关联 2 个')
  })

  it('relinked 缺省或为 0 时维持原提示文案', async () => {
    api.models.scan.mockResolvedValue({ models: [makeModel('m1')], errors: [] })
    await scanModels()
    const notice = state.toasts.find((t) => t.type === 'success')
    expect(notice.text).toBe('扫描完成：发现 1 个模型')
  })

  it('存在读取错误时重关联计数仍在警告提示中展示', async () => {
    api.models.scan.mockResolvedValue({
      models: [makeModel('m1')],
      errors: [{ dir: 'x', message: 'denied' }],
      relinked: 1
    })
    await scanModels()
    const notice = state.toasts.find((t) => t.type === 'warn')
    expect(notice.text).toContain('1 个目录无法读取')
    expect(notice.text).toContain('自动重新关联 1 个')
  })
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

  it('搜索命中分类标签中文标签（放大模型）', () => {
    state.models = [makeModel('u', { type: 'other', subCategory: 'upscale' })]
    state.search = '放大'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['u'])
  })

  it('搜索域缓存随模型对象替换失效（O3）：新备注可命中、旧备注不再命中', () => {
    state.models = [makeModel('m1', { note: '旧备注内容' })]
    state.search = '旧备注'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['m1'])
    // 模拟标注保存路径：整体替换元素对象（note 变更）
    state.models = [makeModel('m1', { note: '新备注内容' })]
    state.search = '旧备注'
    expect(filteredModels.value).toHaveLength(0)
    state.search = '新备注'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['m1'])
  })

  it('收藏优先排序：收藏在前，组内按名称；固定语义不响应方向翻转（O1）', () => {
    state.models = [
      makeModel('x', { name: 'a', favorite: false }),
      makeModel('y', { name: 'b', favorite: true }),
      makeModel('z', { name: 'c', favorite: true })
    ]
    state.sortBy = 'favorite'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['y', 'z', 'x'])
    state.sortAsc = false
    expect(filteredModels.value.map((m) => m.id)).toEqual(['y', 'z', 'x'])
  })

  it('按评分排序：高分在前，同分按名称；固定语义不响应方向翻转（O1）', () => {
    state.models = [
      makeModel('a', { name: 'a', rating: 4 }),
      makeModel('b', { name: 'b', rating: 5 }),
      makeModel('c', { name: 'c', rating: 0 })
    ]
    state.sortBy = 'rating'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['b', 'a', 'c'])
    state.sortAsc = false
    expect(filteredModels.value.map((m) => m.id)).toEqual(['b', 'a', 'c'])
  })

  it('sortDirectional 标记固定语义排序（O1）：favorite/rating 不支持方向切换', () => {
    expect(sortDirectional('name')).toBe(true)
    expect(sortDirectional('type')).toBe(true)
    expect(sortDirectional('size')).toBe(true)
    expect(sortDirectional('mtime')).toBe(true)
    expect(sortDirectional('favorite')).toBe(false)
    expect(sortDirectional('rating')).toBe(false)
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

describe('快速连点竞态（A5）', () => {
  it('双击收藏：第二次读到第一次落定的状态，IPC 依次收到相反目标值（不丢翻）', async () => {
    state.models = [makeModel('m1', { favorite: false })]
    const sentPayloads = []
    let releaseFirst = () => {}
    api.models.setMetaFlags.mockImplementationOnce((payload) => {
      sentPayloads.push(payload)
      // 第一次调用挂起：模拟 IPC 在途窗口
      return new Promise((resolve) => {
        releaseFirst = () => resolve({ meta: { favorite: true, nsfw: false, rating: 0 } })
      })
    })
    api.models.setMetaFlags.mockImplementationOnce((payload) => {
      sentPayloads.push(payload)
      return Promise.resolve({ meta: { favorite: payload.favorite, nsfw: false, rating: 0 } })
    })

    const first = toggleFavorite('m1') // 不 await：构造连点场景
    const second = toggleFavorite('m1')
    releaseFirst()
    await Promise.all([first, second])

    // 串行化后：第一次读旧值 false -> true；第二次读新值 true -> false
    expect(sentPayloads).toEqual([
      { id: 'm1', favorite: true },
      { id: 'm1', favorite: false }
    ])
    // 净效果翻两次，回到 false（未串行化时两次都发 true，第二次点击看起来失效）
    expect(state.models[0].favorite).toBe(false)
  })

  it('前一次失败不阻塞后续操作：报错后再次点击仍正常生效', async () => {
    state.models = [makeModel('m1', { favorite: false })]
    api.models.setMetaFlags.mockRejectedValueOnce(new Error('IPC 断开'))
    api.models.setMetaFlags.mockResolvedValueOnce({
      meta: { favorite: true, nsfw: false, rating: 0 }
    })

    const ok1 = await toggleFavorite('m1')
    expect(ok1).toBe(false)
    expect(state.toasts.some((t) => t.text.includes('收藏操作失败'))).toBe(true)
    const ok2 = await toggleFavorite('m1')
    expect(ok2).toBe(true)
    expect(state.models[0].favorite).toBe(true)
  })

  it('队列按模型粒度：不同模型的操作互不等待（m1 在途时 m2 立即可完成）', async () => {
    state.models = [makeModel('m1'), makeModel('m2')]
    let m1Started = false
    let releaseFirst = () => {}
    api.models.setMetaFlags.mockImplementation((payload) => {
      if (payload.id === 'm1') {
        m1Started = true
        return new Promise((resolve) => {
          releaseFirst = () => resolve({ meta: { favorite: true, nsfw: false, rating: 0 } })
        })
      }
      return Promise.resolve({ meta: { favorite: true, nsfw: false, rating: 0 } })
    })

    const p1 = toggleFavorite('m1')
    const p2 = toggleFavorite('m2')
    await expect(p2).resolves.toBe(true) // m2 未因 m1 在途而阻塞
    expect(m1Started).toBe(true)
    expect(state.models[1].favorite).toBe(true)
    releaseFirst()
    await expect(p1).resolves.toBe(true)
    expect(state.models[0].favorite).toBe(true)
  })
})

describe('批量操作单次状态合并（O2）', () => {
  it('批量收藏：全部成功时单趟同步全部标记并提示成功', async () => {
    state.models = [makeModel('a'), makeModel('b'), makeModel('c')]
    state.multiSelect.ids = ['a', 'b', 'c']
    api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: true, nsfw: false, rating: 0 }
    })
    await batchFavorite(true)
    expect(state.models.map((m) => m.favorite)).toEqual([true, true, true])
    expect(state.toasts.some((t) => t.type === 'success' && t.text.includes('已为 3 个模型收藏'))).toBe(true)
  })

  it('批量收藏：部分失败时成功者已同步、汇总提示统计', async () => {
    state.models = [makeModel('a'), makeModel('b'), makeModel('c')]
    state.multiSelect.ids = ['a', 'b', 'c']
    api.models.setMetaFlags.mockImplementation(({ id }) =>
      id === 'b'
        ? Promise.reject(new Error('IPC 断开'))
        : Promise.resolve({ meta: { favorite: true, nsfw: false, rating: 0 } })
    )
    await batchFavorite(true)
    expect(state.models.find((m) => m.id === 'a').favorite).toBe(true)
    expect(state.models.find((m) => m.id === 'b').favorite).toBe(false)
    expect(state.models.find((m) => m.id === 'c').favorite).toBe(true)
    expect(state.toasts.some((t) => t.type === 'warn' && t.text.includes('成功 2 个，失败 1 个'))).toBe(true)
  })

  it('批量设置标签：按 {id, subCategory} 调 IPC 并单趟同步标签字段', async () => {
    state.models = [makeModel('a', { type: 'other' }), makeModel('c', { type: 'other' })]
    state.multiSelect.ids = ['a', 'c']
    api.models.saveModelData.mockImplementation(() =>
      Promise.resolve({
        meta: { subCategory: 'controlnet', params: null, alias: '', note: '', triggerWords: '' }
      })
    )
    await batchSetSubCategory('controlnet')
    expect(api.models.saveModelData).toHaveBeenCalledTimes(2)
    expect(api.models.saveModelData).toHaveBeenCalledWith({ id: 'a', subCategory: 'controlnet' })
    expect(api.models.saveModelData).toHaveBeenCalledWith({ id: 'c', subCategory: 'controlnet' })
    expect(state.models.map((m) => m.subCategory)).toEqual(['controlnet', 'controlnet'])
    expect(state.toasts.some((t) => t.type === 'success' && t.text.includes('已为 2 个模型设置标签'))).toBe(true)
  })

  it('批量设置标签：失败不逐个弹错误 toast，仅汇总提示', async () => {
    state.models = [makeModel('a', { type: 'other' }), makeModel('c', { type: 'other' })]
    state.multiSelect.ids = ['a', 'c']
    api.models.saveModelData.mockRejectedValue(new Error('保存失败'))
    const toastCountBefore = state.toasts.length
    await batchSetSubCategory('embedding')
    expect(state.toasts.length - toastCountBefore).toBe(1)
    expect(state.toasts[0].type).toBe('warn')
  })

  it('批量删除：确认后单趟移除并清理 selectedId 与选区', async () => {
    state.models = [makeModel('a'), makeModel('b'), makeModel('c')]
    state.selectedId = 'b'
    state.multiSelect.active = true
    state.multiSelect.ids = ['a', 'b']
    api.models.deleteModel.mockResolvedValue({ ok: true })
    const p = batchDeleteModels()
    acceptConfirm()
    await p
    expect(state.models.map((m) => m.id)).toEqual(['c'])
    expect(state.selectedId).toBeNull()
    // 选区仅移除已删除 id，多选模式保持
    expect(state.multiSelect.active).toBe(true)
    expect(state.multiSelect.ids).toEqual([])
    expect(state.toasts.some((t) => t.type === 'success' && t.text.includes('已将 2 个模型移入回收站'))).toBe(true)
  })

  it('批量删除：部分失败时失败者保留在列表', async () => {
    state.models = [makeModel('a'), makeModel('b')]
    state.multiSelect.ids = ['a', 'b']
    api.models.deleteModel.mockImplementation((id) =>
      id === 'a' ? Promise.resolve({ ok: true }) : Promise.resolve({ error: '文件被占用' })
    )
    const p = batchDeleteModels()
    acceptConfirm()
    await p
    expect(state.models.map((m) => m.id)).toEqual(['b'])
    expect(state.multiSelect.ids).toEqual(['b'])
    expect(state.toasts.some((t) => t.text.includes('成功 1 个，失败 1 个'))).toBe(true)
  })

  it('批量删除：确认取消时不调用删除 IPC', async () => {
    state.models = [makeModel('a')]
    state.multiSelect.ids = ['a']
    const p = batchDeleteModels()
    rejectConfirm()
    await p
    expect(api.models.deleteModel).not.toHaveBeenCalled()
    expect(state.models).toHaveLength(1)
  })
})

describe('派生查找优化（O4）', () => {
  it('selectedModel 按 id O(1) 命中，未知 id 返回 null', () => {
    state.models = [makeModel('a'), makeModel('b')]
    state.selectedId = 'b'
    expect(selectedModel.value?.id).toBe('b')
    state.selectedId = 'missing'
    expect(selectedModel.value).toBeNull()
  })

  it('selectedModel 随元素替换同步（元数据更新后读到新引用字段）', () => {
    state.models = [makeModel('a', { alias: '' })]
    state.selectedId = 'a'
    state.models = [makeModel('a', { alias: '备注名' })]
    expect(selectedModel.value?.alias).toBe('备注名')
  })

  it('multiSelectIdSet 随 ids 同步，has 判断 O(1) 语义与 includes 一致', () => {
    state.multiSelect.ids = ['a', 'b']
    expect(multiSelectIdSet.value.has('a')).toBe(true)
    expect(multiSelectIdSet.value.has('c')).toBe(false)
    state.multiSelect.ids = []
    expect(multiSelectIdSet.value.size).toBe(0)
  })

  it('allFilteredSelected 基于选中集合：全选为 true、部分选中为 false', () => {
    state.models = [makeModel('a'), makeModel('b')]
    state.multiSelect.ids = ['a']
    expect(allFilteredSelected.value).toBe(false)
    state.multiSelect.ids = ['a', 'b']
    expect(allFilteredSelected.value).toBe(true)
    // 列表新增未选中项后自动变回 false
    state.models = [makeModel('a'), makeModel('b'), makeModel('c')]
    expect(allFilteredSelected.value).toBe(false)
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

describe('磁盘占用分析（FEAT-1）', () => {
  it('diskUsage 按分类与顶层目录聚合总大小', () => {
    state.models = [
      makeModel('a', { type: 'checkpoint', size: 3000, relDir: 'Checkpoints' }),
      makeModel('b', { type: 'lora', size: 1000, relDir: 'Loras/sub' }),
      makeModel('c', { type: 'lora', size: 500 })
    ]
    const usage = diskUsage.value
    expect(usage.total).toBe(4500)
    expect(usage.count).toBe(3)
    // 分类顺序遵循 MODEL_TYPES，仅保留有占用的分类
    expect(usage.byType).toEqual([
      { key: 'checkpoint', label: 'Checkpoint/大模型', color: '#4f9cf9', size: 3000 },
      { key: 'lora', label: 'LoRA', color: '#b18cff', size: 1500 }
    ])
    // 目录按 relDir 首段归类（无 relDir 归「(根目录)」），按大小降序
    expect(usage.byDir).toEqual([
      { name: 'Checkpoints', size: 3000 },
      { name: 'Loras', size: 1000 },
      { name: '(根目录)', size: 500 }
    ])
  })

  it('diskUsage 忽略非有限 size，空库返回零值', () => {
    state.models = [makeModel('bad', { size: undefined })]
    expect(diskUsage.value.total).toBe(0)
    state.models = []
    expect(diskUsage.value).toEqual({ total: 0, count: 0, byType: [], byDir: [] })
  })

  it('largestModels 按大小降序并截取到上限', () => {
    state.models = [
      makeModel('small', { size: 100 }),
      makeModel('big', { size: 9000 }),
      makeModel('mid', { size: 5000 }),
      makeModel('bad', { size: undefined })
    ]
    expect(largestModels.value.map((m) => m.id)).toEqual(['big', 'mid', 'small'])
  })

  it('largestModels 上限为 20：超出部分截断', () => {
    state.models = Array.from({ length: 25 }, (_, i) =>
      makeModel(`m${String(i).padStart(2, '0')}`, { size: (i + 1) * 100 })
    )
    const list = largestModels.value
    expect(list).toHaveLength(20)
    expect(list[0].id).toBe('m24')
    expect(list[19].id).toBe('m05')
  })

  it('openDiskUsage/closeDiskUsage 切换面板开合', () => {
    openDiskUsage()
    expect(state.diskUsage.open).toBe(true)
    closeDiskUsage()
    expect(state.diskUsage.open).toBe(false)
  })
})

describe('批量拖拽导入封面（OPT-9）', () => {
  /** 构造 importCover IPC 的成功响应（covers 为最新完整列表） */
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

  it('多文件：逐文件串行 IPC，末尾单趟应用最终封面列表', async () => {
    state.models = [makeModel('m1', { covers: [] })]
    let call = 0
    api.models.importCover.mockImplementation(() => {
      call += 1
      return Promise.resolve(coverRes(call))
    })
    const res = await importCoversFromDrop('m1', ['a.png', 'b.png', 'c.png'])
    expect(api.models.importCover).toHaveBeenCalledTimes(3)
    expect(res).toMatchObject({ ok: true, total: 3, failed: 0 })
    // 最后一次响应即包含全部 3 张封面
    expect(state.models[0].covers).toHaveLength(3)
    expect(state.models[0].coverUrl).toBe('url-3')
    expect(state.models[0].hasManualCover).toBe(true)
    // store 内不逐条弹 toast（汇总提示交由调用方）
    expect(state.toasts).toHaveLength(0)
  })

  it('单张业务失败不中断其余：失败计数入 errors，成功张仍应用', async () => {
    state.models = [makeModel('m1', { covers: [] })]
    api.models.importCover.mockImplementation((id, path) =>
      path === 'bad.png'
        ? Promise.resolve({ error: '文件内容不是有效的图片，已拒绝导入' })
        : Promise.resolve(coverRes(1))
    )
    const res = await importCoversFromDrop('m1', ['ok1.png', 'bad.png', 'ok2.png'])
    expect(api.models.importCover).toHaveBeenCalledTimes(3)
    expect(res.ok).toBe(true)
    expect(res.total).toBe(3)
    expect(res.failed).toBe(1)
    expect(res.errors[0]).toContain('不是有效的图片')
    expect(state.models[0].covers).toHaveLength(1)
    expect(state.toasts).toHaveLength(0)
  })

  it('IPC reject 同样计入失败且不中断后续文件', async () => {
    state.models = [makeModel('m1', { covers: [] })]
    api.models.importCover.mockImplementation((id, path) =>
      path === 'boom.png' ? Promise.reject(new Error('通道异常')) : Promise.resolve(coverRes(1))
    )
    const res = await importCoversFromDrop('m1', ['boom.png', 'ok.png'])
    expect(res.failed).toBe(1)
    expect(res.errors[0]).toBe('通道异常')
    expect(state.models[0].covers).toHaveLength(1)
  })

  it('全部失败时不应用任何状态', async () => {
    state.models = [makeModel('m1', { covers: [] })]
    api.models.importCover.mockResolvedValue({ error: '不支持的格式' })
    const res = await importCoversFromDrop('m1', ['a.png', 'b.png'])
    expect(res.ok).toBe(false)
    expect(res.failed).toBe(2)
    expect(state.models[0].covers).toHaveLength(0)
  })

  it('空列表/非法输入：不调用 IPC，返回零值', async () => {
    const res = await importCoversFromDrop('m1', [])
    expect(res).toEqual({ ok: false, total: 0, failed: 0, errors: [] })
    const res2 = await importCoversFromDrop('m1', null)
    expect(res2.total).toBe(0)
    expect(api.models.importCover).not.toHaveBeenCalled()
  })
})
