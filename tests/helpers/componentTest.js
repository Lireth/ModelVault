import { beforeEach, vi } from 'vitest'
import { defaultSettings, resetViews, state } from '../../src/renderer/src/store/appStore'

/**
 * 渲染层组件测试通用装配（OPT-16 测试基建）：
 * - window.api 桩：组件交互经此与主进程通信（与 appStore.test.js 同构，
 *   额外覆盖导出列表 / 哈希批处理 / 目录变更等事件通道）；
 * - matchMedia 桩：jsdom 未实现该 API，TopBar 窄屏菜单的断点监听依赖它；
 * - store 状态复位：组件直接读写全局 state，用例间必须隔离；
 * - 清理 document.body：@vue/test-utils 默认不自动卸载，避免跨用例残留。
 */

/** 构造 window.api 桩（按用例覆写具体方法返回值） */
export function makeComponentApiMock() {
  return {
    // 拖拽文件真实路径解析（preload webUtils 的测试替身）：
    // 默认取 File 对象的 path 属性（测试构造的 File-like 对象携带），无则空串
    getPathForFile: vi.fn((file) => (file && typeof file.path === 'string' ? file.path : '')),
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
      exportList: vi.fn(() => Promise.resolve({ canceled: true })),
      computeHashBatch: vi.fn(() => Promise.resolve({ hashes: {} })),
      cancelHashBatch: vi.fn(() => Promise.resolve({ ok: false })),
      partialScan: vi.fn(() => Promise.resolve({ models: [], dirs: [], relinked: 0 })),
      // B-06 应用内整理
      listDirs: vi.fn(() => Promise.resolve({ dirs: [''] })),
      createFolder: vi.fn(() => Promise.resolve({ ok: true, dir: '' })),
      renameFolder: vi.fn(() => Promise.resolve({ ok: true, oldDir: '', newDir: '', moved: 0 })),
      moveModels: vi.fn(() => Promise.resolve({ moved: [], failed: [], destDir: '' })),
      metaGaps: vi.fn(() => Promise.resolve({ orphans: [], newcomers: [] })),
      bindMeta: vi.fn(() => Promise.resolve({ ok: true, model: null })),
      onScanProgress: vi.fn(() => () => {}),
      onMenuAction: vi.fn(() => () => {}),
      onThumbsReady: vi.fn(() => () => {}),
      onStoreError: vi.fn(() => () => {}),
      onHashProgress: vi.fn(() => () => {}),
      onFsChanged: vi.fn(() => () => {})
    },
    settings: { update: vi.fn() },
    window: { setTheme: vi.fn(() => Promise.resolve()) },
    app: {
      getInfo: vi.fn(),
      checkUpdate: vi.fn(() => Promise.resolve({ hasUpdate: false })),
      openLogs: vi.fn(() => Promise.resolve({ ok: true }))
    }
  }
}

/** 复位渲染层全局状态（与组件行为相关的字段；口径与 appStore.test.js 一致） */
function resetStoreState() {
  state.folder = ''
  state.scanning = false
  state.scanError = ''
  state.progress = { dirs: 0, found: 0, current: '' }
  state.models = []
  state.typeFilter = 'all'
  state.subFilter = ''
  state.showFavoritesOnly = false
  state.dirFilter = ''
  state.search = ''
  state.sortBy = 'name'
  state.sortAsc = true
  state.selectedId = null
  state.detailDirty = false
  state.multiSelect = { active: false, ids: [] }
  state.dedupe = { open: false, running: false, progress: null, groups: [], canceled: false }
  state.diskUsage = { open: false }
  state.organize = {
    open: false,
    busy: false,
    dirs: [],
    targetDir: '',
    pendingIds: [],
    gapsLoading: false,
    orphans: [],
    newcomers: []
  }
  resetViews()
  state.settingsOpen = false
  state.settings = defaultSettings()
  state.toasts.splice(0, state.toasts.length)
  state.confirm = { visible: false, text: '', resolve: null }
}

/**
 * 组件测试通用环境（每个组件测试文件调用一次）。
 * 逐用例重置 window.api 与 store 状态，并桩好 jsdom 缺失的 matchMedia。
 */
export function setupComponentTest() {
  beforeEach(() => {
    window.api = makeComponentApiMock()
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn()
    })
    resetStoreState()
    document.body.innerHTML = ''
  })
}

/**
 * 等待多级异步落定（确认层 resolve → 并发 IPC → 状态同步 → 提示）。
 * setTimeout(0) 宏任务边界可覆盖微任务链与 Promise.allSettled 的后续回合。
 */
export function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
