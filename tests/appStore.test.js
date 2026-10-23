import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setModelCoverUrl } from '../src/renderer/src/store/cover-overrides'
import {
  acceptConfirm,
  allFilteredSelected,
  applyHashUpdate,
  applyThumbUpdates,
  applyUpdateAvailable,
  clearCoverOverrides,
  coverThumbUrl,
  modelCoverUrl,
  batchApplyTriggers,
  batchCivitaiIdentify,
  batchCivitaiImages,
  batchDeleteModels,
  batchFavorite,
  batchToggleDisabled,
  batchAssignCivitaiTags,
  batchOrganizeByTags,
  clearAllCovers,
  closeTransfer,
  confirmDialog,
  confirmTransfer,
  deleteModel,
  dismissToast,
  duplicateGroups,
  duplicateIdSet,
  duplicateWastedBytes,
  allTags,
  filteredModels,
  formatSize,
  importCoversFromDrop,
  importModels,
  initApp,
  moveModelTo,
  multiSelectIdSet,
  openTransferToLibrary,
  partialScanModels,
  rejectConfirm,
  revealModel,
  replaceModels,
  requestBatchCancel,
  saveSettings,
  scanModels,
  selectedModel,
  setModelTags,
  showContextMenu,
  sortDirectional,
  state,
  switchRoot,
  targetDisplayName,
  toast,
  toggleDisabledModel,
  toggleFavorite,
  transferState,
  transferTargets,
  typeCounts,
  updateAvailable
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
      openLibrary: vi.fn(),
      importModels: vi.fn(),
      scan: vi.fn(),
      cancelScan: vi.fn(() => Promise.resolve({ ok: false })),
      chooseFolder: vi.fn(),
      setMetaFlags: vi.fn(),
      setModelTags: vi.fn(),
      toggleDisabled: vi.fn(),
      moveModelTo: vi.fn(),
      deleteModel: vi.fn(),
      popupMenu: vi.fn(),
      reveal: vi.fn(),
      saveModelData: vi.fn(),
      uploadCover: vi.fn(),
      pasteCover: vi.fn(),
      setDefaultCover: vi.fn(),
      deleteCover: vi.fn(),
      clearAllCovers: vi.fn(),
      importCover: vi.fn(),
      civitaiIdentify: vi.fn(),
      civitaiCategory: vi.fn(),
      organizeByTags: vi.fn(),
      civitaiImportImages: vi.fn(),
      transferToLibrary: vi.fn(),
      partialScan: vi.fn(),
      warmupHash: vi.fn(() => Promise.resolve({ ok: true })),
      onScanProgress: vi.fn(() => () => {}),
      onWarmupProgress: vi.fn(() => () => {}),
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
  clearCoverOverrides()
  vi.stubGlobal('window', { api })
  // applyTheme/applyAccent（saveSettings/主题与强调色切换）会触碰 document
  vi.stubGlobal('document', {
    documentElement: { classList: { toggle: vi.fn() }, style: { setProperty: vi.fn() } }
  })
  // 重置模块级单例状态，用例间互不污染
  state.folder = ''
  state.scanning = false
  state.backgroundScanning = false
  state.importing = false
  state.partialScanning = false
  state.scanError = ''
  replaceModels([])
  state.typeFilter = 'all'
  state.subFilter = ''
  state.showFavoritesOnly = false
  state.search = ''
  state.sortBy = 'name'
  state.sortAsc = true
  state.selectedId = null
  state.detailDirty = false
  state.settingsOpen = false
  // O3：multiSelect 为内嵌深响应集合，就地表合并复位（含批量取消标志）
  Object.assign(state.multiSelect, { active: false, ids: [], busy: false, progress: '', cancelRequested: false })
  state.toasts.splice(0, state.toasts.length)
  if (state.confirm.resolve) state.confirm.resolve(false)
  // O3：state 为 shallowReactive，confirm 是内嵌深响应集合，就地表合并复位
  Object.assign(state.confirm, { visible: false, text: '', resolve: null })
  // 跨库传输浮层与启动更新提示均为模块级单例：用例间复位
  Object.assign(transferState, { visible: false, ids: [], mode: 'copy', busy: false })
  updateAvailable.value = null
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

  it('O3：子树超过上限时收敛为一级目录后发送，不静默截断', async () => {
    setGrid([])
    api.models.partialScan.mockResolvedValue({ models: [], dirs: ['bulk'], relinked: 0 })
    const dirs = Array.from({ length: 205 }, (_, i) => `bulk/item-${i}`)

    await partialScanModels(dirs)

    expect(api.models.partialScan).toHaveBeenCalledWith({
      folder: 'D:\\models',
      dirs: ['bulk']
    })
  })

  it('O3：一级目录仍超过上限时降级全量扫描', async () => {
    setGrid([makeModel('keep-id')])
    api.models.scan.mockResolvedValue({ models: [makeModel('keep-id')], errors: [] })
    const dirs = Array.from({ length: 205 }, (_, i) => `top${i}`)

    await partialScanModels(dirs)

    expect(api.models.partialScan).not.toHaveBeenCalled()
    expect(api.models.scan).toHaveBeenCalled()
    expect(state.toasts.some((t) => t.type === 'warn' && t.text.includes('变更目录过多'))).toBe(
      true
    )
  })

  it('O3：主进程返回 fullScanRequired 时降级全量扫描', async () => {
    setGrid([makeModel('keep-id')])
    api.models.partialScan.mockResolvedValue({ fullScanRequired: true })
    api.models.scan.mockResolvedValue({ models: [makeModel('keep-id')], errors: [] })

    await partialScanModels(['lora'])
    // fallback 全量扫描在 finalize 中异步发起
    await new Promise((resolve) => setImmediate(resolve))

    expect(api.models.scan).toHaveBeenCalled()
    expect(state.toasts.some((t) => t.type === 'warn' && t.text.includes('变更目录过多'))).toBe(
      true
    )
  })

  it('请求发出后切库：旧根响应丢弃，不覆盖新库列表（B-01）', async () => {
    setGrid([makeModel('D:\\models\\lora\\a.safetensors', { name: 'a', relDir: 'lora' })])
    let resolveRequest
    api.models.partialScan.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve
      })
    )

    const pending = partialScanModels(['lora'])
    // 模拟切库：根与列表已换成新库
    state.folder = 'D:\\other'
    replaceModels([makeModel('D:\\other\\new.safetensors', { name: 'new', relDir: '' })])
    resolveRequest({
      models: [makeModel('D:\\models\\lora\\b.safetensors', { name: 'b', relDir: 'lora' })],
      dirs: ['lora'],
      relinked: 0
    })
    await pending

    expect(state.models.map((m) => m.id)).toEqual(['D:\\other\\new.safetensors'])
    expect(state.partialScanning).toBe(false)
  })

  it('并发局部扫描串行化：在途变更合并后补扫一次（B-01）', async () => {
    setGrid([makeModel('D:\\models\\keep.safetensors', { name: 'keep', relDir: '' })])
    let resolveFirst
    api.models.partialScan.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve
      })
    )

    const first = partialScanModels(['lora'])
    api.models.partialScan.mockResolvedValue({ models: [], dirs: ['vae'], relinked: 0 })
    // 在途期间的新变更不并发发起，合并入队
    await partialScanModels(['vae'])
    expect(api.models.partialScan).toHaveBeenCalledTimes(1)

    resolveFirst({ models: [], dirs: ['lora'], relinked: 0 })
    await first
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(api.models.partialScan).toHaveBeenCalledTimes(2)
    expect(api.models.partialScan.mock.calls[1][0]).toEqual({
      folder: 'D:\\models',
      dirs: ['vae']
    })
    expect(state.partialScanning).toBe(false)
  })

  it('局部扫描失败降级全量扫描时，不会因锁标志被自身拦截（B-01）', async () => {
    setGrid([])
    api.models.partialScan.mockResolvedValue({ error: '该目录不在模型库列表中' })
    api.models.scan.mockResolvedValue({ models: [makeModel('m1')], errors: [] })

    await partialScanModels(['lora'])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(api.models.scan).toHaveBeenCalledTimes(1)
    expect(state.partialScanning).toBe(false)
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

describe('切库状态机（V-02）', () => {
  it('目标库扫描成功后提交 state.folder 并替换列表', async () => {
    state.folder = 'D:\\models'
    replaceModels([makeModel('D:\\models\\old.safetensors')])
    api.models.scan.mockResolvedValue({
      root: 'D:\\other',
      models: [makeModel('D:\\other\\new.safetensors')],
      errors: []
    })

    await switchRoot('D:\\other')

    expect(state.folder).toBe('D:\\other')
    expect(state.models.map((m) => m.id)).toEqual(['D:\\other\\new.safetensors'])
  })

  it('目标库扫描失败时保持原库与旧列表', async () => {
    state.folder = 'D:\\models'
    replaceModels([makeModel('D:\\models\\old.safetensors')])
    api.models.scan.mockResolvedValue({ error: '模型文件夹不存在或不是目录' })

    await switchRoot('D:\\other')

    expect(state.folder).toBe('D:\\models')
    expect(state.models.map((m) => m.id)).toEqual(['D:\\models\\old.safetensors'])
    expect(state.toasts.some((t) => t.type === 'error')).toBe(true)
  })

  it('扫描被取消时保持原库与旧列表', async () => {
    state.folder = 'D:\\models'
    replaceModels([makeModel('D:\\models\\old.safetensors')])
    api.models.scan.mockResolvedValue({ canceled: true })

    await switchRoot('D:\\other')

    expect(state.folder).toBe('D:\\models')
    expect(state.models.map((m) => m.id)).toEqual(['D:\\models\\old.safetensors'])
  })
})

describe('F2 模型导入', () => {
  it('导入成功后提示并对目标子树执行局部扫描', async () => {
    state.folder = 'D:\\models'
    api.models.importModels.mockResolvedValue({
      imported: 2,
      renamed: 1,
      failed: [],
      warnings: [],
      targetRelDir: 'lora'
    })
    api.models.partialScan.mockResolvedValue({ models: [], dirs: ['lora'], relinked: 0 })

    const ok = await importModels('copy')

    expect(ok).toBe(true)
    expect(api.models.importModels).toHaveBeenCalledWith('copy')
    expect(api.models.partialScan).toHaveBeenCalledWith({
      folder: 'D:\\models',
      dirs: ['lora']
    })
    expect(state.toasts.some((t) => t.type === 'success' && t.text.includes('2 个模型'))).toBe(
      true
    )
    expect(state.importing).toBe(false)
  })

  it('全部失败时不触发局部扫描；扫描中拒绝导入', async () => {
    state.folder = 'D:\\models'
    api.models.importModels.mockResolvedValue({
      imported: 0,
      renamed: 0,
      failed: [{ source: 'x', error: '不支持' }],
      warnings: [],
      targetRelDir: ''
    })
    expect(await importModels('copy')).toBe(false)
    expect(api.models.partialScan).not.toHaveBeenCalled()
    expect(state.toasts.some((t) => t.type === 'warn' && t.text.includes('导入失败'))).toBe(true)

    state.scanning = true
    expect(await importModels('copy')).toBe(false)
    expect(api.models.importModels).toHaveBeenCalledTimes(1)
  })
})

describe('F1 本地索引：秒切库与后台校验', () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve))

  it('switchRoot 有索引时立即展示缓存，再后台校验并替换为磁盘结果', async () => {
    state.folder = 'D:\\models'
    state.settings.autoScan = true
    replaceModels([makeModel('D:\\models\\old.safetensors')])
    api.models.openLibrary.mockResolvedValue({
      root: 'D:\\other',
      cached: true,
      durationMs: 5,
      models: [makeModel('D:\\other\\cached.safetensors')],
      settings: { modelsFolder: 'D:\\other', autoScan: true }
    })
    let releaseScan
    api.models.scan.mockReturnValue(new Promise((resolve) => { releaseScan = resolve }))

    await switchRoot('D:\\other')

    expect(state.folder).toBe('D:\\other')
    expect(state.models.map((m) => m.id)).toEqual(['D:\\other\\cached.safetensors'])
    expect(state.backgroundScanning).toBe(true)
    expect(state.toasts.some((t) => t.type === 'success' && t.text.includes('秒开本地索引'))).toBe(
      true
    )
    expect(api.models.scan).toHaveBeenCalledWith('D:\\other')

    releaseScan({
      root: 'D:\\other',
      models: [makeModel('D:\\other\\fresh.safetensors')],
      errors: [],
      durationMs: 10
    })
    await tick()
    expect(state.backgroundScanning).toBe(false)
    expect(state.models.map((m) => m.id)).toEqual(['D:\\other\\fresh.safetensors'])
  })

  it('后台校验失败时保留缓存列表且不进入全屏错误态', async () => {
    state.folder = 'D:\\models'
    state.settings.autoScan = true
    api.models.openLibrary.mockResolvedValue({
      root: 'D:\\other',
      cached: true,
      models: [makeModel('D:\\other\\cached.safetensors')],
      settings: { modelsFolder: 'D:\\other', autoScan: true }
    })
    api.models.scan.mockResolvedValue({ error: '磁盘读取失败' })

    await switchRoot('D:\\other')
    await tick()

    expect(state.models.map((m) => m.id)).toEqual(['D:\\other\\cached.safetensors'])
    expect(state.scanError).toBe('')
    expect(state.backgroundScanning).toBe(false)
    expect(
      state.toasts.some((t) => t.type === 'warn' && t.text.includes('后台校验失败'))
    ).toBe(true)
  })

  it('initApp 有缓存时先展示并后台校验；autoScan=false 时只展示', async () => {
    state.booting = true
    api.models.loadStore.mockResolvedValue({
      settings: { modelsFolder: 'D:\\lib', autoScan: true },
      models: {},
      cachedIndex: { models: [makeModel('D:\\lib\\cached.safetensors')], durationMs: 3 }
    })
    let releaseScan
    api.models.scan.mockReturnValue(new Promise((resolve) => { releaseScan = resolve }))

    await initApp()

    expect(state.booting).toBe(false)
    expect(state.folder).toBe('D:\\lib')
    expect(state.models.map((m) => m.id)).toEqual(['D:\\lib\\cached.safetensors'])
    expect(state.backgroundScanning).toBe(true)

    releaseScan({ root: 'D:\\lib', models: [makeModel('D:\\lib\\fresh.safetensors')], errors: [] })
    await tick()
    expect(state.backgroundScanning).toBe(false)
    expect(state.models.map((m) => m.id)).toEqual(['D:\\lib\\fresh.safetensors'])
  })

  it('initApp autoScan=false 且有缓存：展示缓存但不触发扫描', async () => {
    state.booting = true
    api.models.loadStore.mockResolvedValue({
      settings: { modelsFolder: 'D:\\lib', autoScan: false },
      models: {},
      cachedIndex: { models: [makeModel('D:\\lib\\cached.safetensors')], durationMs: 3 }
    })

    await initApp()

    expect(state.booting).toBe(false)
    expect(state.models.map((m) => m.id)).toEqual(['D:\\lib\\cached.safetensors'])
    expect(state.backgroundScanning).toBe(false)
    expect(api.models.scan).not.toHaveBeenCalled()
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

  it('确认后 state.confirm 保持响应式代理（回归：整体替换致第二次弹窗失效）', async () => {
    const { isReactive, nextTick, watch } = await import('vue')
    const changes = []
    const stop = watch(
      () => state.confirm.visible,
      (v) => changes.push(v)
    )
    // 第一轮确认：acceptConfirm 曾用原始对象整体替换 state.confirm，
    // shallowReactive 不深代理 → 后续逐字段赋值失去响应性，弹窗不再显示
    const p1 = confirmDialog('第一轮')
    await nextTick() // 等待监听 flush，否则同 tick 内 true→false 被去重
    expect(changes).toEqual([true])
    acceptConfirm()
    await expect(p1).resolves.toBe(true)
    await nextTick()
    expect(changes).toEqual([true, false])
    expect(isReactive(state.confirm)).toBe(true)
    // 第二轮（回归点）：visible 逐字段赋值必须仍触发响应（渲染层据此显示弹窗）
    const p2 = confirmDialog('第二轮')
    await nextTick()
    expect(changes).toEqual([true, false, true])
    expect(state.confirm.visible).toBe(true)
    stop()
    rejectConfirm()
    await expect(p2).resolves.toBe(false)
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

  it('搜索域纳入 safetensors 自动解析信息（F2）：作者/基底模型/训练标签可命中', () => {
    state.models = [
      makeModel('lora1', {
        name: '神秘模型',
        autoInfo: { baseModel: 'sd_xl_base_1.0', author: 'KohyaStyle', triggerCandidates: ['masterpiece', 'best quality'] }
      }),
      makeModel('lora2', { name: '普通模型', autoInfo: null })
    ]
    // 按基底模型搜（「那个 SDXL 的 LoRA 在哪」；真实头部值形如 sd_xl_base_1.0，
    // 搜索为子串匹配——搜「sd_xl」或「xl_base」均可命中）
    state.search = 'sd_xl'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['lora1'])
    // 按作者搜
    state.search = 'kohya'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['lora1'])
    // 按训练标签候选搜
    state.search = 'masterpiece'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['lora1'])
    // 无 autoInfo 的模型不受空字段干扰
    state.search = '普通'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['lora2'])
    state.search = ''
  })

  it('自由标签筛选与标签池（F-5）：包含即命中，跨类型维度不随主分类清空', () => {
    state.models = [
      makeModel('a', { type: 'lora', tags: ['赛博朋克', '服装'] }),
      makeModel('b', { type: 'checkpoint', tags: ['赛博朋克'] }),
      makeModel('c', { type: 'vae', tags: [] })
    ]
    // 标签池：按使用次数降序
    expect(allTags.value).toEqual(['赛博朋克', '服装'])
    // 筛选：包含该标签的模型命中（跨类型）
    state.tagFilter = '赛博朋克'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['a', 'b'])
    state.tagFilter = '服装'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['a'])
    // 跨类型维度：切主分类不清空（与 subFilter/baseFilter 不同）
    state.typeFilter = 'lora'
    expect(state.tagFilter).toBe('服装')
    expect(filteredModels.value.map((m) => m.id)).toEqual(['a'])
    state.typeFilter = 'all'
    state.tagFilter = ''
    // 库内无标签时标签池为空
    state.models = [makeModel('x', { tags: [] })]
    expect(allTags.value).toEqual([])
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

describe('标注操作响应传播（shallowReactive 回归）', () => {
  it('元素级更新后派生状态（selectedModel/filteredModels）立即同步，无需整体替换', async () => {
    // 与真实扫描一致：列表经 replaceModels 装配（数组为 shallowReactive 代理）
    replaceModels([
      makeModel('m1', { name: '甲', favorite: false }),
      makeModel('m2', { name: '乙' })
    ])
    api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: true, nsfw: true, rating: 3 }
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

  it('未经 replaceModels 装配的原始数组不具备该保证（守卫约定边界）', async () => {
    // 直接裸赋值（测试遗留写法）：数据会变，但派生状态不重算——
    // 固化「数组级更新必须走 replaceModels」的约定，防止约定被悄然破坏
    state.models = [makeModel('m1', { favorite: false })]
    state.selectedId = 'm1'
    expect(selectedModel.value.favorite).toBe(false) // 先读一次，建立派生缓存
    api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: true, nsfw: false, rating: 0 }
    })
    await toggleFavorite('m1')
    expect(state.models[0].favorite).toBe(true)
    expect(selectedModel.value.favorite).toBe(false)
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

  it('批量收藏按统一限流执行：同时在途 IPC 不超过上限', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `m${i}`)
    state.models = ids.map((id) => makeModel(id))
    state.multiSelect.ids = ids
    let inFlight = 0
    let maxInFlight = 0
    api.models.setMetaFlags.mockImplementation(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return { meta: { favorite: true, nsfw: false, rating: 0 } }
    })

    await batchFavorite(true)

    expect(api.models.setMetaFlags).toHaveBeenCalledTimes(40)
    expect(maxInFlight).toBeGreaterThan(0)
    expect(maxInFlight).toBeLessThanOrEqual(16)
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

  it('一键分配标签：确认后逐个按 Civitai 分类分配并单趟同步标签字段', async () => {
    state.models = [makeModel('a', { type: 'lora' }), makeModel('b', { type: 'lora' })]
    state.multiSelect.ids = ['a', 'b']
    api.models.civitaiCategory.mockImplementation((id) =>
      id === 'a'
        ? Promise.resolve({ found: true, subCategory: 'role', meta: { subCategory: 'role' } })
        : Promise.resolve({ skipped: true })
    )
    const p = batchAssignCivitaiTags()
    acceptConfirm()
    await p
    expect(api.models.civitaiCategory).toHaveBeenCalledTimes(2)
    expect(state.models.find((m) => m.id === 'a').subCategory).toBe('role')
    expect(
      state.toasts.some((t) => t.type === 'success' && t.text.includes('成功 1 个') && t.text.includes('无 Civitai 链接 1 个'))
    ).toBe(true)
  })

  it('一键分配标签：非 LoRA 模型不发起 IPC 且计入汇总', async () => {
    state.models = [makeModel('a', { type: 'lora' }), makeModel('b', { type: 'checkpoint' })]
    state.multiSelect.ids = ['a', 'b']
    api.models.civitaiCategory.mockResolvedValue({ found: true, subCategory: 'role', meta: { subCategory: 'role' } })
    const p = batchAssignCivitaiTags()
    acceptConfirm()
    await p
    expect(api.models.civitaiCategory).toHaveBeenCalledTimes(1)
    expect(api.models.civitaiCategory).toHaveBeenCalledWith('a')
    expect(
      state.toasts.some((t) => t.type === 'success' && t.text.includes('成功 1 个') && t.text.includes('非 LoRA 1 个'))
    ).toBe(true)
  })

  it('一键分配标签：全选均非 LoRA 时提示且不发起 IPC', async () => {
    state.models = [makeModel('a', { type: 'checkpoint' })]
    state.multiSelect.ids = ['a']
    await batchAssignCivitaiTags()
    expect(api.models.civitaiCategory).not.toHaveBeenCalled()
    expect(state.toasts.some((t) => t.text.includes('均不是 LoRA'))).toBe(true)
  })

  it('一键分配标签：确认层拒绝时不发起任何 IPC', async () => {
    state.models = [makeModel('a', { type: 'lora' })]
    state.multiSelect.ids = ['a']
    const p = batchAssignCivitaiTags()
    rejectConfirm()
    await p
    expect(api.models.civitaiCategory).not.toHaveBeenCalled()
  })

  it('一键移动文件：已标注与未标注 LoRA 按新结构提交移动并整表重扫，非 LoRA 不参与', async () => {
    state.models = [
      makeModel('a', { type: 'lora', subCategory: 'role' }),
      makeModel('b', { type: 'lora', subCategory: '' }),
      makeModel('c', { type: 'checkpoint', subCategory: 'base' })
    ]
    state.multiSelect.ids = ['a', 'b', 'c']
    state.scanning = true // 跳过移动后的整表重扫（该链路由 scanner/watcher 测试覆盖）
    api.models.organizeByTags.mockResolvedValue({ moved: 2, failed: [], skipped: [] })
    const p = batchOrganizeByTags()
    acceptConfirm()
    await p
    expect(api.models.organizeByTags).toHaveBeenCalledWith([
      { id: 'a', subCategory: 'role' },
      { id: 'b', subCategory: '' }
    ])
    expect(state.toasts.some((t) => t.type === 'success' && t.text.includes('已移动 2 个 LoRA 模型'))).toBe(true)
  })

  it('一键移动文件：选中模型均非 LoRA 时提示且不发起 IPC', async () => {
    state.models = [makeModel('a', { type: 'checkpoint', subCategory: '' })]
    state.multiSelect.ids = ['a']
    await batchOrganizeByTags()
    expect(api.models.organizeByTags).not.toHaveBeenCalled()
    expect(state.toasts.some((t) => t.text.includes('均不是 LoRA'))).toBe(true)
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

  it('批量删除按文件操作并发上限执行：同时在途 IPC 不超过上限', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `d${i}`)
    state.models = ids.map((id) => makeModel(id))
    state.multiSelect.ids = ids
    let inFlight = 0
    let maxInFlight = 0
    api.models.deleteModel.mockImplementation(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return { ok: true }
    })

    const pending = batchDeleteModels()
    acceptConfirm()
    await pending

    expect(api.models.deleteModel).toHaveBeenCalledTimes(40)
    expect(maxInFlight).toBeGreaterThan(0)
    expect(maxInFlight).toBeLessThanOrEqual(8)
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

  it('批量提交在途时连点被拦截：不重复发起 IPC（B6 in-flight 防护）', async () => {
    state.models = [makeModel('a'), makeModel('b')]
    state.multiSelect.ids = ['a', 'b']
    state.multiSelect.busy = false
    // 两个模型的 IPC 各自挂起：逐一收集 resolve（单个变量会被后一次调用覆盖）
    const resolvers = []
    api.models.setMetaFlags.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        })
    )

    const first = batchFavorite(true) // 不 await：构造在途窗口（busy 同步置位）
    const second = batchFavorite(true) // 在途期间的连点：必须被 busy 拦截
    await second

    // 仅第一批 2 个 IPC（每模型一个）；连点不得把同一批再提交一遍
    expect(api.models.setMetaFlags).toHaveBeenCalledTimes(2)
    expect(state.multiSelect.busy).toBe(true) // 首批在途，按钮应保持禁用

    for (const resolve of resolvers) resolve({ meta: { favorite: true, nsfw: false, rating: 0 } })
    await first
    expect(state.multiSelect.busy).toBe(false) // 完成后恢复可用
    expect(state.models.map((m) => m.favorite)).toEqual([true, true])
  })

  it('批量删除在途（含确认层弹出）时连点不重复提交', async () => {
    state.models = [makeModel('a')]
    state.multiSelect.ids = ['a']
    state.multiSelect.busy = false
    let release = () => {}
    api.models.deleteModel.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true })
        })
    )

    const first = batchDeleteModels()
    // 确认层已弹出但删除 IPC 尚未发出：busy 已置位，连点直接拦截
    const second = await batchDeleteModels()
    expect(second).toBeUndefined()
    expect(state.multiSelect.busy).toBe(true)

    acceptConfirm() // 通过第一个（已在途的）确认层
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()
    await first
    expect(api.models.deleteModel).toHaveBeenCalledTimes(1)
    expect(state.models).toHaveLength(0)
    expect(state.multiSelect.busy).toBe(false)
  })

  it('批量填入自动触发词（F3）：仅填空触发词且有候选的模型，绝不覆盖已有标注', async () => {
    state.models = [
      makeModel('fresh', { autoInfo: { triggerCandidates: ['tag-a', 'tag-b'] } }),
      makeModel('owned', { triggerWords: '已有词', autoInfo: { triggerCandidates: ['tag-x'] } }),
      makeModel('nocand', { autoInfo: null })
    ]
    state.multiSelect.ids = ['fresh', 'owned', 'nocand']
    api.models.saveModelData.mockImplementation(({ triggerWords }) =>
      Promise.resolve({ meta: { triggerWords, triggerWordsSource: '' } })
    )

    await batchApplyTriggers()

    // 仅对「fresh」发起保存：已有触发词与无候选的模型跳过
    expect(api.models.saveModelData).toHaveBeenCalledTimes(1)
    expect(api.models.saveModelData.mock.calls[0][0]).toEqual({
      id: 'fresh',
      triggerWords: 'tag-a, tag-b'
    })
    // 本地列表同步填入结果，其余模型不受影响
    expect(state.models[0].triggerWords).toBe('tag-a, tag-b')
    expect(state.models[1].triggerWords).toBe('已有词')
    expect(state.toasts.some((t) => t.type === 'success' && t.text.includes('已为 1 个模型填入触发词'))).toBe(true)
    expect(state.toasts.some((t) => t.text.includes('2 个已有触发词或无候选'))).toBe(true)
  })

  it('批量填入触发词按统一限流执行：同时在途 IPC 不超过上限', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `t${i}`)
    state.models = ids.map((id) =>
      makeModel(id, {
        autoInfo: { triggerCandidates: ['tag'] },
        triggerWords: ''
      })
    )
    state.multiSelect.ids = ids
    let inFlight = 0
    let maxInFlight = 0
    api.models.saveModelData.mockImplementation(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return { meta: { triggerWords: 'tag', triggerWordsSource: 'civitai' } }
    })

    await batchApplyTriggers()

    expect(api.models.saveModelData).toHaveBeenCalledTimes(40)
    expect(maxInFlight).toBeGreaterThan(0)
    expect(maxInFlight).toBeLessThanOrEqual(16)
  })

  it('批量填入触发词：选中模型全部无可填时提示且零 IPC', async () => {
    state.models = [makeModel('owned', { triggerWords: 'x' })]
    state.multiSelect.ids = ['owned']
    await batchApplyTriggers()
    expect(api.models.saveModelData).not.toHaveBeenCalled()
    expect(state.toasts.some((t) => t.text.includes('均已有触发词或无自动解析候选'))).toBe(true)
  })

  it('批量 Civitai 识别：串行逐个调用，未收录不算失败，civitaiUrl 单趟同步', async () => {
    state.models = [makeModel('a'), makeModel('b'), makeModel('c')]
    state.multiSelect.ids = ['a', 'b', 'c']
    api.models.civitaiIdentify.mockImplementation((id) => {
      if (id === 'a') return Promise.resolve({ found: true, meta: { civitaiUrl: 'https://civitai.com/models/1' } })
      if (id === 'b') return Promise.resolve({ found: false })
      return Promise.reject(new Error('网络断开'))
    })
    await batchCivitaiIdentify()
    // 逐个串行调用（而非并发）
    expect(api.models.civitaiIdentify).toHaveBeenCalledTimes(3)
    expect(api.models.civitaiIdentify.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c'])
    // 识别成功者同步 civitaiUrl，未收录/失败者保持空串
    expect(state.models[0].civitaiUrl).toBe('https://civitai.com/models/1')
    expect(state.models[1].civitaiUrl).toBeUndefined()
    expect(state.models[2].civitaiUrl).toBeUndefined()
    // 汇总提示含未收录与失败统计
    expect(state.toasts.some((t) => t.type === 'warn' && t.text.includes('成功 1 个'))).toBe(true)
    expect(state.toasts.some((t) => t.text.includes('未收录 1 个'))).toBe(true)
    expect(state.toasts.some((t) => t.text.includes('失败 1 个'))).toBe(true)
    // 批量结束后忙碌与进度复位
    expect(state.multiSelect.busy).toBe(false)
    expect(state.multiSelect.progress).toBe('')
  })

  it('批量 Civitai 识别：识别期间更新逐个进度文案', async () => {
    state.models = [makeModel('a'), makeModel('b')]
    state.multiSelect.ids = ['a', 'b']
    const seen = []
    api.models.civitaiIdentify.mockImplementation(() => {
      seen.push(state.multiSelect.progress)
      return Promise.resolve({ found: false })
    })
    await batchCivitaiIdentify()
    expect(seen).toEqual(['识别中 1/2：a', '识别中 2/2：b'])
  })

  it('批量获取示例图：仅处理无封面模型，取前 4 张并同步封面状态', async () => {
    const coversRsp = {
      cover: 'D:\\m\\.modelvault\\covers\\1.png',
      coverUrl: 'mvimg:///1.png',
      covers: [
        { rel: 'covers/1.png', path: 'D:\\m\\1.png', url: 'mvimg:///1.png' }
      ]
    }
    state.models = [
      makeModel('nocover'),
      makeModel('hascover', { hasManualCover: true, covers: [{ rel: 'covers/x.png' }] })
    ]
    state.multiSelect.ids = ['nocover', 'hascover']
    api.models.civitaiIdentify.mockImplementation((id) =>
      id === 'nocover'
        ? Promise.resolve({
            found: true,
            meta: { civitaiUrl: 'https://civitai.com/models/9' },
            info: { images: [{ url: 'u1' }, { url: 'u2' }, { url: 'u3' }, { url: 'u4' }, { url: 'u5' }, { url: 'u6' }] }
          })
        : Promise.resolve({ found: false })
    )
    api.models.civitaiImportImages.mockResolvedValue({ added: 4, ...coversRsp })

    await batchCivitaiImages()

    // 已有封面的模型完全跳过（识别与导入均不调用）
    expect(api.models.civitaiIdentify).toHaveBeenCalledTimes(1)
    expect(api.models.civitaiIdentify).toHaveBeenCalledWith('nocover')
    // 单模型最多取前 4 张（BATCH_CIVITAI_IMAGES_PER_MODEL）
    expect(api.models.civitaiImportImages).toHaveBeenCalledTimes(1)
    expect(api.models.civitaiImportImages).toHaveBeenCalledWith('nocover', [
      { url: 'u1' }, { url: 'u2' }, { url: 'u3' }, { url: 'u4' }
    ])
    // 封面结果与 civitaiUrl 同步到本地列表
    const m = state.models.find((mm) => mm.id === 'nocover')
    expect(m.hasManualCover).toBe(true)
    expect(m.cover).toBe(coversRsp.cover)
    expect(m.covers).toEqual(coversRsp.covers)
    expect(m.civitaiUrl).toBe('https://civitai.com/models/9')
    expect(state.toasts.some((t) => t.type === 'success' && t.text.includes('已为 1 个模型添加共 4 张示例图'))).toBe(true)
    expect(state.toasts.some((t) => t.text.includes('已有示例图跳过 1 个'))).toBe(true)
  })

  it('批量获取示例图：选中模型均已有封面时提示且零 IPC', async () => {
    state.models = [makeModel('a', { hasManualCover: true, covers: [{ rel: 'covers/a.png' }] })]
    state.multiSelect.ids = ['a']
    await batchCivitaiImages()
    expect(api.models.civitaiIdentify).not.toHaveBeenCalled()
    expect(api.models.civitaiImportImages).not.toHaveBeenCalled()
    expect(state.toasts.some((t) => t.text.includes('均已有示例图'))).toBe(true)
  })
})

describe('批量取消（Esc 请求取消，串行批量提前收尾）', () => {
  it('requestBatchCancel 仅在 busy 期间置位', () => {
    state.multiSelect.busy = false
    requestBatchCancel()
    expect(state.multiSelect.cancelRequested).toBe(false)
    state.multiSelect.busy = true
    requestBatchCancel()
    expect(state.multiSelect.cancelRequested).toBe(true)
  })

  it('批量禁用进行中请求取消：循环提前收尾、标志位 finally 复位、提示已完成数', async () => {
    state.models = [makeModel('a'), makeModel('b'), makeModel('c')]
    state.multiSelect.ids = ['a', 'b', 'c']
    state.multiSelect.busy = false
    state.scanning = true // 跳过禁用后的整表重扫（该链路由 scanner/watcher 测试覆盖）
    let calls = 0
    api.models.toggleDisabled.mockImplementation(() => {
      calls += 1
      if (calls === 1) requestBatchCancel() // 第一个完成后按 Esc 请求取消（busy 已置位的真实路径）
      return Promise.resolve({ ok: true })
    })

    await batchToggleDisabled(true)

    expect(calls).toBe(1) // 第二轮循环顶部检查取消标志，提前 break
    expect(state.multiSelect.busy).toBe(false)
    expect(state.multiSelect.cancelRequested).toBe(false)
    expect(state.toasts.some((t) => t.text.includes('已取消（完成 1/3）'))).toBe(true)
  })

  it('批量识别进行中请求取消：已完成部分保存并提示进度', async () => {
    state.models = [makeModel('a'), makeModel('b'), makeModel('c')]
    state.multiSelect.ids = ['a', 'b', 'c']
    let calls = 0
    api.models.civitaiIdentify.mockImplementation(() => {
      calls += 1
      if (calls === 2) requestBatchCancel() // 识别完第二个后请求取消
      return Promise.resolve({ found: true, meta: { civitaiUrl: 'https://civitai.com/models/x' } })
    })

    await batchCivitaiIdentify()

    expect(calls).toBe(2)
    expect(state.multiSelect.cancelRequested).toBe(false)
    expect(state.toasts.some((t) => t.text.includes('识别已取消（完成 2/3）'))).toBe(true)
    // 已识别部分已保存：a/b 的 civitaiUrl 已写入
    expect(state.models.find((m) => m.id === 'a').civitaiUrl).toBe('https://civitai.com/models/x')
    expect(state.models.find((m) => m.id === 'b').civitaiUrl).toBe('https://civitai.com/models/x')
  })
})

describe('启动引导态（B8）', () => {
  it('initApp 完成后清除 booting：异步恢复 folder 期间不闪现引导页', async () => {
    state.booting = true
    api.models.loadStore.mockResolvedValue({ settings: { modelsFolder: '' }, models: {} })
    // 无 folder：不触发扫描，initApp 直接完成
    await initApp()
    expect(state.folder).toBe('')
    expect(state.booting).toBe(false)
  })

  it('已配置过文件夹时 initApp 后扫描完成，引导页全程不出现', async () => {
    state.booting = true
    api.models.loadStore.mockResolvedValue({ settings: { modelsFolder: 'D:\\lib' }, models: {} })
    api.models.scan.mockResolvedValue({ models: [], errors: [], byType: {}, durationMs: 1 })
    await initApp()
    expect(state.folder).toBe('D:\\lib')
    expect(state.scanning).toBe(false)
    expect(state.booting).toBe(false)
  })

  it('initApp 失败（IPC 异常）时 booting 仍清除，失败可见', async () => {
    state.booting = true
    api.models.loadStore.mockRejectedValue(new Error('IPC 断开'))
    await initApp()
    expect(state.booting).toBe(false)
    expect(state.toasts.some((t) => t.type === 'error' && t.text.includes('初始化失败'))).toBe(true)
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
  it('按 id 写入展示覆盖；模型对象保持引用与字段不变', () => {
    state.models = [makeModel('m1', { coverUrl: 'orig' }), makeModel('m2', { coverUrl: 'orig2' })]
    const before = state.models[0]
    applyThumbUpdates([
      { id: 'm1', coverUrl: 'thumb1' },
      { id: 'missing', coverUrl: 'x' },
      { id: 'm2', coverUrl: '' }
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
          { rel: 'b.png', path: 'p-b', url: 'u-b' }
        ]
      })
    ]
    // 仅 coverThumb：默认封面 URL 不变，目标 covers 条目的展示缩略图走覆盖
    applyThumbUpdates([{ id: 'm1', coverThumb: { path: 'p-b', thumbUrl: 't-b' } }])
    expect(modelCoverUrl(state.models[0])).toBe('orig')
    expect(coverThumbUrl(state.models[0].covers[0])).toBe('')
    expect(coverThumbUrl(state.models[0].covers[1])).toBe('t-b')
    expect(state.models[0].covers[1].thumbUrl).toBeUndefined()
    // coverUrl 与 coverThumb 同时携带时一并生效；未知 path 静默忽略
    applyThumbUpdates([
      { id: 'm1', coverUrl: 'thumb1', coverThumb: { path: 'p-a', thumbUrl: 't-a' } },
      { id: 'm1', coverThumb: { path: 'p-missing', thumbUrl: 't-x' } }
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
          { rel: 'b.png', path: 'p-b', url: 'u-b' }
        ]
      })
    ])
    const before = state.models[0]
    applyThumbUpdates([
      { id: 'm1', coverUrl: 't-default' },
      { id: 'm1', coverThumb: { path: 'p-a', thumbUrl: 't-a' } },
      { id: 'm1', coverThumb: { path: 'p-b', thumbUrl: 't-b' } }
    ])

    expect(state.models[0]).toBe(before)
    expect(modelCoverUrl(state.models[0])).toBe('t-default')
    expect(state.models[0].covers.map(coverThumbUrl)).toEqual(['t-a', 't-b'])
  })
})

describe('重复模型检测与筛选（FEAT-1）', () => {
  /** 注入两重复组 + 干扰项：A 组（p1/p2 同哈希，p2 评分更高）、B 组（q1/q2 同哈希）、s 独立。
   * 须经 replaceModels 注入（包 shallowReactive）——applyHashUpdate 走元素级
   * 索引替换，裸数组赋值会令其失去响应性（state.js 更新约定） */
  function seedDupes() {
    replaceModels([
      makeModel('p1', { hash: 'a'.repeat(64), size: 100, mtimeMs: 1, rating: 0 }),
      makeModel('p2', { hash: 'a'.repeat(64), size: 100, mtimeMs: 2, rating: 4 }),
      makeModel('q1', { hash: 'b'.repeat(64), size: 50, mtimeMs: 1 }),
      makeModel('q2', { hash: 'b'.repeat(64), size: 50, mtimeMs: 2 }),
      makeModel('s', { hash: '', size: 5 })
    ])
  }

  it('按哈希分组：仅保留成员数大于 1 的组，冗余空间按 (n-1)×大小 计', () => {
    seedDupes()
    expect(duplicateGroups.value).toHaveLength(2)
    expect(duplicateGroups.value[0]).toMatchObject({
      hash: 'a'.repeat(64),
      wastedBytes: 100
    })
    expect(duplicateGroups.value[0].models.map((m) => m.id)).toEqual(['p1', 'p2'])
    // 无哈希的独立模型不入组
    expect(duplicateIdSet.value.has('s')).toBe(false)
    expect(duplicateWastedBytes.value).toBe(150)
  })

  it('重复筛选：仅保留组内成员；哈希回填后分组即时出现（渐进可用）', () => {
    seedDupes()
    state.showDuplicatesOnly = true
    expect(filteredModels.value.map((m) => m.id)).toEqual(['p1', 'p2', 'q1', 'q2'])

    // 独立模型的哈希经预热完成事件回填为与 p1 相同 → 立即进入重复组
    // （先就地对齐文件大小，满足「同哈希文件大小一致」的现实前提）
    state.models[4] = { ...state.models[4], size: 100 }
    applyHashUpdate({ active: false, id: 's', hash: 'a'.repeat(64) })
    expect(state.models.find((m) => m.id === 's').hash).toBe('a'.repeat(64))
    expect(duplicateGroups.value[0].models.map((m) => m.id)).toEqual(['p1', 'p2', 's'])
    // a 组 3 成员冗余 2×100，b 组 2 成员冗余 1×50
    expect(duplicateWastedBytes.value).toBe(250)
    expect(filteredModels.value.map((m) => m.id)).toEqual(['p1', 'p2', 's', 'q1', 'q2'])
  })

  it('重复筛选下按哈希稳定排序聚拢同组（组内保持既有排序结果）', () => {
    seedDupes()
    state.showDuplicatesOnly = true
    // mtime 排序制造 A/B 组交错（q2 mtime 3 > p2 2 > q1 1.5 > p1 1）：
    // sortBy=mtime 的基础比较器为「新在前」，sortAsc=true 不翻转 → 纯 mtime
    // 降序为 q2/p2/q1/p1（A/B 交错）；重复筛选下按哈希稳定排序聚拢为
    // a 组（p2/p1）在前、b 组（q2/q1）在后，组内 mtime 降序保持
    replaceModels([
      makeModel('p1', { hash: 'a'.repeat(64), size: 100, mtimeMs: 1 }),
      makeModel('p2', { hash: 'a'.repeat(64), size: 100, mtimeMs: 2 }),
      makeModel('q1', { hash: 'b'.repeat(64), size: 50, mtimeMs: 1.5 }),
      makeModel('q2', { hash: 'b'.repeat(64), size: 50, mtimeMs: 3 })
    ])
    state.sortBy = 'mtime'
    state.sortAsc = true
    expect(filteredModels.value.map((m) => m.id)).toEqual(['p2', 'p1', 'q2', 'q1'])
  })

  it('applyHashUpdate：进行中事件与未知 id 忽略，同值幂等不替换元素', () => {
    seedDupes()
    const sIdx = 4 // s 为 seedDupes 的最后一个模型
    const before = state.models[sIdx]
    // 进行中事件（active=true）不回填
    applyHashUpdate({ active: true, id: 's', hash: 'c'.repeat(64) })
    expect(state.models[sIdx].hash).toBe('')
    // 未知 id 忽略
    applyHashUpdate({ active: false, id: 'no-such', hash: 'c'.repeat(64) })
    // 空 hash 忽略
    applyHashUpdate({ active: false, id: 's', hash: '' })
    expect(state.models[sIdx]).toBe(before)
    // 首次回填：元素级整体替换
    applyHashUpdate({ active: false, id: 's', hash: 'c'.repeat(64) })
    const afterFirst = state.models[sIdx]
    expect(afterFirst).not.toBe(before)
    expect(afterFirst.hash).toBe('c'.repeat(64))
    // 同值幂等：引用不变（避免无意义的响应式失效）
    applyHashUpdate({ active: false, id: 's', hash: 'c'.repeat(64) })
    expect(state.models[sIdx]).toBe(afterFirst)
  })

  it('O2 批次：completions 一次回填多个模型，未知/同值项安全跳过', () => {
    seedDupes()
    const beforeP1 = state.models[0]
    applyHashUpdate({
      active: false,
      id: '',
      hash: '',
      completions: [
        { id: 'p1', hash: 'c'.repeat(64) },
        { id: 'no-such', hash: 'd'.repeat(64) },
        { id: 'p2', hash: 'a'.repeat(64) } // 同值：引用不变
      ]
    })

    expect(state.models[0]).not.toBe(beforeP1)
    expect(state.models[0].hash).toBe('c'.repeat(64))
    expect(state.models[1].hash).toBe('a'.repeat(64))
  })

  it('关闭重复筛选后视图恢复全量（筛选随开关生效与退出）', () => {
    seedDupes()
    state.showDuplicatesOnly = true
    expect(filteredModels.value).toHaveLength(4)
    state.showDuplicatesOnly = false
    expect(filteredModels.value).toHaveLength(5)
  })
})

describe('清空全部示例图（OPT-01）', () => {
  it('成功后以元素级替换同步列表，派生查找立即回退且不重扫', async () => {
    replaceModels([
      makeModel('m1', {
        cover: 'covers/a.png',
        coverUrl: 'mvimg://local/covers/a.png',
        covers: [{ rel: 'covers/a.png', path: 'D:\\models\\.modelvault\\covers\\a.png', url: 'mvimg://local/covers/a.png' }],
        hasManualCover: true
      }),
      makeModel('m2', {
        cover: 'covers/b.png',
        coverUrl: 'mvimg://local/covers/b.png',
        covers: [{ rel: 'covers/b.png', path: 'D:\\models\\.modelvault\\covers\\b.png', url: 'mvimg://local/covers/b.png' }],
        hasManualCover: true
      })
    ])
    state.selectedId = 'm1'
    const before = state.models[0]
    api.models.clearAllCovers.mockResolvedValue({ cleared: 2, images: 2 })

    const ok = await clearAllCovers()

    expect(ok).toBe(true)
    // 浅响应数组的元素必须被替换，才能触发依赖其索引的派生状态
    expect(state.models[0]).not.toBe(before)
    for (const m of state.models) {
      expect(m.cover).toBe('')
      expect(m.coverUrl).toBe('')
      expect(m.covers).toEqual([])
      expect(m.hasManualCover).toBe(false)
    }
    // selectedModel 经 modelById 读取到新引用，详情页立即回退占位图
    expect(selectedModel.value?.coverUrl).toBe('')
    expect(state.toasts.at(-1)).toMatchObject({ type: 'success' })
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

describe('跨库传输编排（F-3）', () => {
  beforeEach(() => {
    state.folder = 'D:\\models\\A'
    state.settings.modelsFolders = ['D:\\models\\A', 'D:\\models\\B']
    api.models.scan.mockResolvedValue({ models: [], errors: [], byType: {}, durationMs: 1 })
  })

  it('可选目标库排除当前库；无其他库时不打开浮层并提示', () => {
    expect(transferTargets.value).toEqual(['D:\\models\\B'])

    state.settings.modelsFolders = ['D:\\models\\A']
    expect(transferTargets.value).toEqual([])
    openTransferToLibrary('D:\\models\\A\\x.safetensors')

    expect(transferState.visible).toBe(false)
    expect(state.toasts.some((t) => t.text.includes('当前只有这一个模型库'))).toBe(true)
  })

  it('单模型默认移动、多模型默认复制；空输入不改变浮层', () => {
    openTransferToLibrary('D:\\models\\A\\x.safetensors')
    expect(transferState).toMatchObject({
      visible: true,
      mode: 'move',
      ids: ['D:\\models\\A\\x.safetensors']
    })

    closeTransfer()
    openTransferToLibrary(['a', 'b'])
    expect(transferState).toMatchObject({ visible: true, mode: 'copy', ids: ['a', 'b'] })

    closeTransfer()
    openTransferToLibrary([])
    expect(transferState.visible).toBe(false)
  })

  it('目标库显示名取目录名，盘符根回退规范化路径', () => {
    expect(targetDisplayName('D:\\libs\\B\\')).toBe('B')
    expect(targetDisplayName('D:\\')).toBe('D:')
  })

  it('传输进行中不可关闭；空闲关闭清空待传输 id', () => {
    openTransferToLibrary('a')
    transferState.busy = true
    closeTransfer()
    expect(transferState.visible).toBe(true)
    expect(transferState.ids).toEqual(['a'])

    transferState.busy = false
    closeTransfer()
    expect(transferState.visible).toBe(false)
    expect(transferState.ids).toEqual([])
  })

  it('复制成功：payload 正确、汇总提示、关闭浮层并重扫', async () => {
    openTransferToLibrary(['a', 'b'])
    api.models.transferToLibrary.mockResolvedValue({
      transferred: 2,
      mode: 'copy',
      skipped: [],
      failed: []
    })

    await confirmTransfer('D:\\models\\B')

    expect(api.models.transferToLibrary).toHaveBeenCalledWith({
      ids: ['a', 'b'],
      targetRoot: 'D:\\models\\B',
      mode: 'copy'
    })
    expect(transferState.visible).toBe(false)
    expect(transferState.ids).toEqual([])
    expect(
      state.toasts.some((t) => t.type === 'success' && t.text.includes('跨库传输完成：复制 2 个'))
    ).toBe(true)
    expect(api.models.scan).toHaveBeenCalledTimes(1)
  })

  it('部分跳过/失败以 warn 汇总；零传输以 info 提示并关闭浮层', async () => {
    openTransferToLibrary(['a', 'b', 'c'])
    api.models.transferToLibrary.mockResolvedValue({
      transferred: 1,
      mode: 'copy',
      skipped: [{ id: 'b', reason: 'exists' }],
      failed: [{ id: 'c', error: '磁盘错误' }]
    })

    await confirmTransfer('D:\\models\\B')

    const warn = state.toasts.find((t) => t.type === 'warn' && t.text.includes('跨库传输完成'))
    expect(warn.text).toContain('跳过 1 个')
    expect(warn.text).toContain('失败 1 个')

    state.toasts.splice(0, state.toasts.length)
    openTransferToLibrary('a')
    api.models.transferToLibrary.mockResolvedValue({
      transferred: 0,
      mode: 'move',
      skipped: [{ id: 'a', reason: 'exists' }],
      failed: []
    })
    await confirmTransfer('D:\\models\\B')

    expect(state.toasts.some((t) => t.type === 'info' && t.text.includes('未传输任何模型'))).toBe(
      true
    )
    expect(transferState.visible).toBe(false)
  })

  it('主进程返回 error：提示并保留浮层便于重试，不触发重扫', async () => {
    openTransferToLibrary('a')
    api.models.transferToLibrary.mockResolvedValue({ error: '目标库不可用' })

    await confirmTransfer('D:\\models\\B')

    expect(transferState.visible).toBe(true)
    expect(transferState.busy).toBe(false)
    expect(state.toasts.some((t) => t.type === 'error' && t.text.includes('目标库不可用'))).toBe(
      true
    )
    expect(api.models.scan).not.toHaveBeenCalled()
  })

  it('IPC reject：错误提示并复位 busy', async () => {
    openTransferToLibrary('a')
    api.models.transferToLibrary.mockRejectedValue(new Error('通道断开'))

    await confirmTransfer('D:\\models\\B')

    expect(transferState.busy).toBe(false)
    expect(state.toasts.some((t) => t.type === 'error' && t.text.includes('跨库传输失败'))).toBe(
      true
    )
  })

  it('缺少目标库 / 无待传输项 / busy 时不发 IPC', async () => {
    await confirmTransfer('')
    expect(api.models.transferToLibrary).not.toHaveBeenCalled()

    await confirmTransfer('D:\\models\\B')
    expect(api.models.transferToLibrary).not.toHaveBeenCalled()

    openTransferToLibrary('a')
    transferState.busy = true
    await confirmTransfer('D:\\models\\B')
    expect(api.models.transferToLibrary).not.toHaveBeenCalled()
  })
})

describe('启动自动检查更新结果（O-3）', () => {
  it('无效载荷（空/无更新/缺版本）忽略且不打扰', () => {
    applyUpdateAvailable(null)
    applyUpdateAvailable({ hasUpdate: false, latest: '0.5.0' })
    applyUpdateAvailable({ hasUpdate: true })

    expect(updateAvailable.value).toBeNull()
    expect(state.toasts).toHaveLength(0)
  })

  it('有效载荷记录并提示当前/最新版本', () => {
    const payload = {
      hasUpdate: true,
      current: '0.4.0',
      latest: '0.5.0',
      releaseUrl: 'https://github.com/Lireth/ModelVault/releases/tag/v0.5.0'
    }

    applyUpdateAvailable(payload)

    // ref 会对对象做响应式包装，比较结构而非引用
    expect(updateAvailable.value).toEqual(payload)
    const tip = state.toasts.at(-1)
    expect(tip.type).toBe('success')
    expect(tip.text).toContain('发现新版本 v0.5.0')
    expect(tip.text).toContain('当前 v0.4.0')
  })

  it('后续有效结果覆盖上一次记录', () => {
    applyUpdateAvailable({ hasUpdate: true, current: '0.4.0', latest: '0.5.0' })
    applyUpdateAvailable({ hasUpdate: true, current: '0.4.0', latest: '0.6.0' })

    expect(updateAvailable.value.latest).toBe('0.6.0')
  })
})

describe('文件操作编排（F10/F11）', () => {
  beforeEach(() => {
    state.folder = 'D:\\models'
    api.models.scan.mockResolvedValue({ models: [], errors: [], byType: {}, durationMs: 1 })
  })

  it('setModelTags 成功同步标签；业务错误保留原值并提示', async () => {
    replaceModels([makeModel('m1', { tags: ['旧标签'] })])
    api.models.setModelTags.mockResolvedValue({ meta: { tags: ['新A', '新B'] } })

    expect(await setModelTags('m1', ['新A', '新B'])).toBe(true)
    expect(state.models[0].tags).toEqual(['新A', '新B'])

    api.models.setModelTags.mockResolvedValue({ error: '标签超限' })
    expect(await setModelTags('m1', ['x'])).toBe(false)
    expect(state.models[0].tags).toEqual(['新A', '新B'])
    expect(state.toasts.some((t) => t.text.includes('标签超限'))).toBe(true)
  })

  it('revealModel 调用定位 IPC；失败时提示错误', async () => {
    api.models.reveal.mockResolvedValue({ ok: true })
    await revealModel('D:\\models\\a.safetensors')
    expect(api.models.reveal).toHaveBeenCalledWith('D:\\models\\a.safetensors')

    api.models.reveal.mockResolvedValue({ error: '路径越界' })
    await revealModel('D:\\models\\a.safetensors')
    expect(state.toasts.some((t) => t.text.includes('路径越界'))).toBe(true)
  })

  it('toggleDisabledModel 成功提示并重扫；扫描进行中不重扫', async () => {
    api.models.toggleDisabled.mockResolvedValue({ path: 'D:\\models\\a.safetensors.disabled' })

    expect(await toggleDisabledModel('a', true)).toBe(true)
    expect(state.toasts.some((t) => t.text.includes('已禁用'))).toBe(true)
    expect(api.models.scan).toHaveBeenCalledTimes(1)

    state.scanning = true
    api.models.scan.mockClear()
    expect(await toggleDisabledModel('a', false)).toBe(true)
    expect(api.models.scan).not.toHaveBeenCalled()
  })

  it('moveModelTo：取消静默返回、成功提示并重扫、错误提示', async () => {
    api.models.moveModelTo.mockResolvedValue({ canceled: true })
    expect(await moveModelTo('a')).toBe(false)
    expect(api.models.scan).not.toHaveBeenCalled()

    api.models.moveModelTo.mockResolvedValue({ path: 'D:\\models\\LoRA\\a.safetensors' })
    expect(await moveModelTo('a')).toBe(true)
    expect(state.toasts.some((t) => t.text.includes('已移动到'))).toBe(true)
    expect(api.models.scan).toHaveBeenCalledTimes(1)

    api.models.moveModelTo.mockResolvedValue({ error: '目标目录不可写' })
    expect(await moveModelTo('a')).toBe(false)
    expect(state.toasts.some((t) => t.text.includes('目标目录不可写'))).toBe(true)
  })

  it('showContextMenu 调用原生菜单；IPC 异常时提示错误', async () => {
    api.models.popupMenu.mockResolvedValue({ ok: true })
    await showContextMenu('m1')
    expect(api.models.popupMenu).toHaveBeenCalledWith('m1')

    api.models.popupMenu.mockRejectedValue(new Error('窗口已关闭'))
    await showContextMenu('m1')
    expect(state.toasts.some((t) => t.text.includes('打开右键菜单失败'))).toBe(true)
  })
})
