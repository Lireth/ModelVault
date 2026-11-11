import { beforeEach, vi } from 'vitest'
import {
  clearCoverOverrides,
  closeCompare,
  defaultSettings,
  exitMultiSelect,
  replaceModels,
  resetLibraryOverview,
  state,
} from '../../src/renderer/src/store/appStore'

/**
 * 渲染层组件测试通用装配（OPT-16 测试基建）：
 * - window.api 桩：组件交互经此与主进程通信（与 appStore.test.js 同构，
 *   额外覆盖导出列表 / 目录变更等事件通道）；
 * - matchMedia 桩：jsdom 未实现该 API，TopBar 窄屏菜单的断点监听依赖它；
 * - store 状态复位：组件直接读写全局 state，用例间必须隔离；
 * - 清理 document.body：@vue/test-utils 默认不自动卸载，避免跨用例残留。
 */

/** 构造 window.api 桩（按用例覆写具体方法返回值） */
function makeComponentApiMock() {
  return {
    // 拖拽文件真实路径解析（preload webUtils 的测试替身）：
    // 默认取 File 对象的 path 属性（测试构造的 File-like 对象携带），无则空串
    getPathForFile: vi.fn((file) =>
      file && typeof file.path === 'string' ? file.path : '',
    ),
    models: {
      // 默认返回已落定的空结果：调用方普遍直接 .catch 链式使用
      loadStore: vi.fn(() => Promise.resolve(null)),
      openLibrary: vi.fn(),
      // 详情按需补全（OPT-PAYLOAD）：默认返回空模型，避免覆盖用例种子数据
      getDetail: vi.fn(() => Promise.resolve({ model: null })),
      // F3 使用轨迹：默认返回零值，避免覆盖用例种子数据
      recordModelOpen: vi.fn(() =>
        Promise.resolve({ meta: { lastOpenedAt: 0, openCount: 0 } }),
      ),
      scan: vi.fn(),
      cancelScan: vi.fn(() => Promise.resolve({ ok: false })),
      chooseFolder: vi.fn(),
      setMetaFlags: vi.fn(),
      setMetaFlagsBulk: vi.fn(() =>
        Promise.resolve({ updated: [], failed: [] }),
      ),
      setModelTags: vi.fn(() => Promise.resolve({ meta: { tags: [] } })),
      setModelTagsBulk: vi.fn(() =>
        Promise.resolve({ updated: [], failed: [] }),
      ),
      renameModel: vi.fn(() =>
        Promise.resolve({ path: '', sidecarWarnings: [] }),
      ),
      renameTag: vi.fn(() => Promise.resolve({ changed: 0 })),
      removeTag: vi.fn(() => Promise.resolve({ changed: 0 })),
      deleteModel: vi.fn(),
      popupMenu: vi.fn(),
      reveal: vi.fn(),
      saveModelData: vi.fn(),
      uploadCover: vi.fn(),
      pasteCover: vi.fn(),
      setDefaultCover: vi.fn(),
      deleteCover: vi.fn(),
      importCover: vi.fn(),
      partialScan: vi.fn(() =>
        Promise.resolve({ models: [], dirs: [], relinked: 0 }),
      ),
      // F2/F-4：外部模型导入（设置页按钮与 App 拖拽导入）
      importModels: vi.fn(() =>
        Promise.resolve({
          imported: 0,
          renamed: 0,
          failed: [],
          warnings: [],
          targetRelDir: '',
        }),
      ),
      transferToLibrary: vi.fn(() =>
        Promise.resolve({ transferred: 0, skipped: [], failed: [] }),
      ),
      warmupHash: vi.fn(() => Promise.resolve({ ok: true })),
      checkHealth: vi.fn(() => Promise.resolve({ report: null })),
      repairHealth: vi.fn(() => Promise.resolve({ repaired: {} })),
      exportModelList: vi.fn(() =>
        Promise.resolve({ ok: true, path: 'list.csv' }),
      ),
      crossLibraryOverview: vi.fn(() =>
        Promise.resolve({
          overview: {
            totals: {
              libraries: 0,
              availableLibraries: 0,
              models: 0,
              knownBytes: 0,
              hashedModels: 0,
              crossGroups: 0,
              redundantCopies: 0,
              wastedBytes: 0,
              unknownSizeGroups: 0,
            },
            libraries: [],
            crossLibraryGroups: [],
          },
          warnings: [],
        }),
      ),
      // 备份/恢复（SettingsBackup + useBackupTransfer）
      exportBackup: vi.fn(() =>
        Promise.resolve({
          path: 'D:\\backup.zip',
          mode: 'full',
          models: 0,
          covers: 0,
        }),
      ),
      importBackup: vi.fn(() => Promise.resolve({ canceled: true })),
      // 封面批量清理（SettingsBackup 数据管理区）
      clearAllCovers: vi.fn(() => Promise.resolve({ cleared: 0, images: 0 })),
      // Civitai 在线识别（CivitaiPanel）
      civitaiIdentify: vi.fn(() => Promise.resolve({ found: false })),
      civitaiComplete: vi.fn(() => Promise.resolve({ found: false })),
      civitaiImportImages: vi.fn(() =>
        Promise.resolve({
          added: 0,
          failed: [],
          cover: '',
          coverUrl: '',
          covers: [],
        }),
      ),
      // 可取消操作令牌（跨库传输/批量整理）
      cancelOp: vi.fn(() => Promise.resolve({ ok: true })),
      onScanProgress: vi.fn(() => () => {}),
      onWarmupProgress: vi.fn(() => () => {}),
      onMenuAction: vi.fn(() => () => {}),
      onThumbsReady: vi.fn(() => () => {}),
      onStoreError: vi.fn(() => () => {}),
      onFsChanged: vi.fn(() => () => {}),
    },
    settings: { update: vi.fn() },
    window: { setTheme: vi.fn(() => Promise.resolve()) },
    app: {
      getInfo: vi.fn(),
      checkUpdate: vi.fn(() => Promise.resolve({ hasUpdate: false })),
      downloadUpdate: vi.fn(() =>
        Promise.resolve({ error: '没有可用的更新信息' }),
      ),
      cancelUpdateDownload: vi.fn(() => Promise.resolve({ ok: true })),
      installUpdate: vi.fn(() => Promise.resolve({ error: '尚未下载更新包' })),
      onUpdateProgress: vi.fn(() => () => {}),
      openLogs: vi.fn(() => Promise.resolve({ ok: true })),
      exportDiagnostics: vi.fn(() =>
        Promise.resolve({ ok: true, path: 'diag.zip', logs: 0 }),
      ),
    },
  }
}

/** 复位渲染层全局状态（与组件行为相关的字段；口径与 appStore.test.js 一致）。
 *  O3 后 state 为 shallowReactive：multiSelect/settings/confirm 是内嵌深响应
 *  集合，整体替换会换成 raw 对象丢失深层响应，须就地表合并复位 */
function resetStoreState() {
  state.folder = ''
  state.booting = false
  state.scanning = false
  state.backgroundScanning = false
  state.importing = false
  state.scanError = ''
  // F1-offline：离线态与失效库清单
  state.folderMissing = false
  state.missingRoots = []
  state.progress = { dirs: 0, found: 0, current: '' }
  replaceModels([])
  state.typeFilter = 'all'
  state.subFilter = ''
  state.tagFilters = []
  state.showFavoritesOnly = false
  state.showSuspectOnly = false
  state.search = ''
  state.sortBy = 'name'
  state.sortAsc = true
  state.selectedId = null
  state.detailDirty = false
  Object.assign(state.multiSelect, {
    busy: false,
    progress: '',
    cancelRequested: false,
    failures: null,
  })
  // active/ids 经 exitMultiSelect 复位：顺带清掉 store 模块级的 Shift
  // 范围选择锚点（非响应式记忆，整体赋值复位无法触达）
  exitMultiSelect()
  state.settingsOpen = false
  // 后台哈希预热进度（CivitaiPanel 进度条消费）：整体复位，避免跨用例残留
  Object.assign(state.warmup, {
    active: false,
    id: '',
    percent: 0,
    hashedBytes: 0,
    totalBytes: 0,
    done: 0,
    remaining: 0,
  })
  Object.assign(state.settings, defaultSettings())
  state.toasts.splice(0, state.toasts.length)
  Object.assign(state.confirm, { visible: false, text: '', resolve: null })
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
      removeListener: vi.fn(),
    })
    resetStoreState()
    resetLibraryOverview()
    clearCoverOverrides()
    closeCompare()
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
