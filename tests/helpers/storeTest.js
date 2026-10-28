import { vi } from 'vitest'
import {
  clearCoverOverrides,
  replaceModels,
  state,
  transferState,
  updateAvailable,
} from '../../src/renderer/src/store/appStore'

/**
 * appStore（渲染层 store）测试共享装配（ENG-1 自 appStore.test.js 抽出）：
 * makeApiMock + resetStoreTestState + makeModel——各分域测试文件在
 * beforeEach 中以 resetStoreTestState(makeApiMock() 产物) 复位模块级单例
 * 状态，保证用例间互不污染（口径与原 appStore.test.js 完全一致）。
 */

/** 构造 window.api 桩（按用例覆写具体方法返回值） */
export function makeApiMock() {
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
      renameModel: vi.fn(),
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
      onStoreError: vi.fn(() => () => {}),
    },
    settings: { update: vi.fn() },
    window: { setTheme: vi.fn(() => Promise.resolve()) },
    app: { getInfo: vi.fn() },
  }
}

/**
 * 复位渲染层全局状态（原 appStore.test.js beforeEach 主体）。
 * @param {ReturnType<typeof makeApiMock>} api makeApiMock 产物（同时绑定到 window）
 */
export function resetStoreTestState(api) {
  clearCoverOverrides()
  vi.stubGlobal('window', { api })
  // applyTheme/applyAccent（saveSettings/主题与强调色切换）会触碰 document
  vi.stubGlobal('document', {
    documentElement: {
      classList: { toggle: vi.fn() },
      style: { setProperty: vi.fn() },
    },
  })
  // 重置模块级单例状态，用例间互不污染
  state.folder = ''
  state.scanning = false
  state.backgroundScanning = false
  state.importing = false
  state.partialScanning = false
  state.scanError = ''
  // F1-offline：离线态与失效库清单
  state.folderMissing = false
  state.missingRoots = []
  replaceModels([])
  state.typeFilter = 'all'
  state.subFilter = ''
  state.tagFilters = []
  state.showFavoritesOnly = false
  state.showDuplicatesOnly = false
  state.search = ''
  state.sortBy = 'name'
  state.sortAsc = true
  state.selectedId = null
  state.detailDirty = false
  state.settingsOpen = false
  // O3：multiSelect 为内嵌深响应集合，就地表合并复位（含批量取消标志）
  Object.assign(state.multiSelect, {
    active: false,
    ids: [],
    busy: false,
    progress: '',
    cancelRequested: false,
  })
  state.toasts.splice(0, state.toasts.length)
  if (state.confirm.resolve) state.confirm.resolve(false)
  // O3：state 为 shallowReactive，confirm 是内嵌深响应集合，就地表合并复位
  Object.assign(state.confirm, { visible: false, text: '', resolve: null })
  // 跨库传输浮层与启动更新提示均为模块级单例：用例间复位
  Object.assign(transferState, {
    visible: false,
    ids: [],
    mode: 'copy',
    busy: false,
  })
  updateAvailable.value = null
}

/** 生成测试模型对象 */
export function makeModel(id, overrides = {}) {
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
    ...overrides,
  }
}
