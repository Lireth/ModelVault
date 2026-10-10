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
 * - disk-usage.js    磁盘占用分析
 * - detail.js        详情打开/关闭与选中模型
 * - partial-scan.js  watcher 变更子树驱动的局部增量扫描
 * - dedupe.js        重复检测与智能清理
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
  MODEL_TYPES,
  SUB_CATEGORIES,
  LORA_TAGS,
  CHECKPOINT_TAGS,
  SORT_OPTIONS,
  CARD_SIZE_PRESETS,
  CARD_SIZE_OPTIONS,
  SCAN_EXTENSION_OPTIONS,
  sortDirectional,
  tagsForType,
  typeInfo,
  subCategoryInfo,
  defaultParams,
  defaultSettings
} from './state'

// Toast 与确认层
export { toast, dismissToast, confirmDialog, acceptConfirm, rejectConfirm } from './toast'

// 展示格式化
export { formatSize } from './format'

// 库生命周期与全量扫描
export {
  initApp,
  applyTheme,
  openSettings,
  closeSettings,
  saveSettings,
  chooseFolder,
  switchRoot,
  removeRoot,
  scanModels,
  cancelScan,
  applyThumbUpdates
} from './library'

// 筛选派生
export { filteredModels, typeCounts } from './filter'

// 磁盘占用分析
export { diskUsage, largestModels, openDiskUsage, closeDiskUsage } from './disk-usage'

// 详情
export { selectedModel, openDetail, closeDetail } from './detail'

// 局部增量扫描
export { partialScanModels } from './partial-scan'

// 重复检测与智能清理
export {
  openDedupe,
  closeDedupe,
  cancelDedupe,
  removeDedupeItem,
  pickDuplicateKeeper,
  keeperReason,
  smartCleanDuplicates
} from './dedupe'

// 多选批量操作
export {
  multiSelectIdSet,
  multiSelectedModels,
  multiSelectUniformType,
  multiSelectTags,
  toggleMultiSelectMode,
  exitMultiSelect,
  toggleSelect,
  allFilteredSelected,
  toggleSelectAllFiltered,
  batchFavorite,
  batchNsfw,
  batchRating,
  batchSetSubCategory,
  batchDeleteModels
} from './multiselect'

// 详情数据保存与封面操作
export {
  saveModelData,
  uploadCover,
  pasteCover,
  setDefaultCover,
  deleteCover,
  importCoversFromDrop
} from './covers-store'

// 单模型操作/即时标注/右键菜单/导出
export {
  revealModel,
  deleteModel,
  exportModels,
  toggleFavorite,
  setNsfw,
  setRating,
  showContextMenu,
  handleMenuAction
} from './model-actions'

// 应用内整理（B-06）
export {
  openOrganize,
  closeOrganize,
  setOrganizeTargetDir,
  refreshOrganizeDirs,
  loadMetaGaps,
  createOrganizeFolder,
  renameOrganizeFolder,
  moveModelsToDir,
  movePendingToTarget,
  moveIdsToDir,
  bindGap
} from './organize'
