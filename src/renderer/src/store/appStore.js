/**
 * 渲染进程全局状态仓库门面（A-04 按域拆分后的聚合入口）。
 *
 * 历史上本文件是约 1400 行的单体模块，已按职责拆分为同目录子模块：
 * - state.js         响应式 state 单例、分类/排序/卡片尺寸等静态常量与默认值
 * - toast.js         Toast 与自定义确认层
 * - format.js        纯展示格式化
 * - meta-apply.js    主进程元数据结果应用到本地列表的共享工具
 * - library.js       初始化/主题/设置/模型库切换/全量扫描/缩略图回填
 * - filter.js        筛选/搜索/排序派生（filteredModels/typeCounts）
 * - selectors.js     id→模型映射等跨域查找派生
 * - detail.js        详情打开/关闭与选中模型
 * - partial-scan.js  watcher 变更子树驱动的局部增量扫描
 * - multiselect.js   多选批量操作
 * - covers-store.js  详情数据保存与封面操作
 * - model-actions.js 单模型文件操作/即时标注/右键菜单/列表导出
 *
 * 本文件仅做显式重导出，维持所有既有 `import { x } from '../store/appStore'`
 * 的导入路径与名称不变；显式列举（而非 export *）以锁定公共导出契约。
 */

// 状态单例、常量、纯函数
export {
  state,
  replaceModels,
  replaceSettings,
  MODEL_TYPES,
  SUB_CATEGORIES,
  LORA_TAGS,
  CHECKPOINT_TAGS,
  BASE_MODEL_FAMILIES,
  SORT_OPTIONS,
  CARD_SIZE_PRESETS,
  CARD_SIZE_OPTIONS,
  SCAN_EXTENSION_OPTIONS,
  HASH_WARMUP_OPTIONS,
  sortDirectional,
  tagsForType,
  typeInfo,
  subCategoryInfo,
  defaultSettings
} from './state'

// Toast 与确认层
export { toast, dismissToast, confirmDialog, acceptConfirm, rejectConfirm } from './toast'

// 展示格式化
export { formatSize, formatDate, formatParamSummary } from './format'

// 库生命周期与全量扫描
export {
  initApp,
  applyTheme,
  resolveTheme,
  applyAccent,
  openSettings,
  closeSettings,
  openStats,
  closeStats,
  saveSettings,
  chooseFolder,
  switchRoot,
  removeRoot,
  scanModels,
  cancelScan,
  applyThumbUpdates,
  applyHashUpdate
} from './library'

// 筛选派生（含重复模型分组，FEAT-1；自由标签池 F-5）
export {
  filteredModels,
  typeCounts,
  duplicateGroups,
  duplicateIdSet,
  duplicateWastedBytes,
  allTags,
  tagCounts
} from './filter'

// 全库标签管理（F4：设置页标签管理面板）
export { renameTagGlobally, removeTagGlobally } from './tag-admin'

// 智能视图（组合筛选收藏）
export {
  savedViews,
  activeSavedViewId,
  viewSummary,
  saveCurrentAsView,
  applySavedView,
  deleteSavedView
} from './saved-views'

// 跨库存储总览（FN-01，按需拉取，不参与当前库派生链）
export { libraryOverview, loadLibraryOverview, resetLibraryOverview } from './library-overview'

// 封面/缩略图展示覆盖（OP-02：避免缩略图回填触发全量派生重算）
export {
  applyCoverOverrides,
  modelCoverUrl,
  coverThumbUrl,
  clearCoverOverrides
} from './cover-overrides'

// 当前筛选结果导出（FN-04）
export {
  EXPORT_FORMATS,
  buildExportRows,
  buildCsv,
  buildMarkdown,
  buildJson,
  exportModelList
} from './model-export'

// 查找派生
export { modelById } from './selectors'

// 局部增量扫描详情
export { selectedModel, openDetail, closeDetail } from './detail'

// 局部增量扫描
export { partialScanModels } from './partial-scan'

// 多选批量操作
export {
  multiSelectIdSet,
  multiSelectedModels,
  multiSelectUniformType,
  toggleMultiSelectMode,
  exitMultiSelect,
  toggleSelect,
  selectRangeTo,
  invertSelectionFiltered,
  allFilteredSelected,
  toggleSelectAllFiltered,
  selectRedundantDuplicates,
  batchFavorite,
  batchNsfw,
  batchRating,
  batchAssignCivitaiTags,
  batchOrganizeByTags,
  batchApplyTriggers,
  batchToggleDisabled,
  batchDeleteModels,
  batchCivitaiIdentify,
  batchCivitaiImages,
  requestBatchCancel
} from './multiselect'

// 详情数据保存与封面操作
export {
  saveModelData,
  uploadCover,
  pasteCover,
  setDefaultCover,
  deleteCover,
  clearCovers,
  clearAllCovers,
  importCoversFromDrop
} from './covers-store'

// Civitai 在线识别与一键补全
export { civitaiIdentify, civitaiComplete, civitaiImportImages } from './civitai-store'

// 单模型操作/即时标注/右键菜单/文件操作（批次 4）/自由标签（F-5）
export {
  revealModel,
  deleteModel,
  toggleFavorite,
  setNsfw,
  setRating,
  setModelTags,
  showContextMenu,
  handleMenuAction,
  toggleDisabledModel,
  moveModelTo,
  importModels
} from './model-actions'
