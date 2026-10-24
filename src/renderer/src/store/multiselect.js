/**
 * 多选批量操作统一门面（E4/E6，A-04 自 appStore.js 拆出；
 * O-4 按域二次拆分为 multiselect/ 目录，本文件仅保留导出契约：
 * appStore.js 与各测试文件的导入路径不变）。
 *
 * - selection.js：多选模式/单选/全选/范围选择/反选/重复项选择/批量取消入口
 * - batch-flags.js：批量收藏 / NSFW / 评分
 * - batch-tags.js：批量自由标签添加 / 移除 / 替换（FEAT-01）
 * - batch-civitai.js：批量 Civitai 分配标签 / 识别 / 示例图采集
 * - batch-files.js：一键移动文件 / 批量触发词 / 批量禁用启用 / 批量删除
 */
export {
  multiSelectIdSet,
  multiSelectedModels,
  multiSelectUniformType,
  toggleMultiSelectMode,
  exitMultiSelect,
  toggleSelect,
  allFilteredSelected,
  toggleSelectAllFiltered,
  selectRangeTo,
  invertSelectionFiltered,
  selectRedundantDuplicates,
  requestBatchCancel
} from './multiselect/selection'

export { batchFavorite, batchNsfw, batchRating } from './multiselect/batch-flags'

export { batchEditTags, normalizeBatchTags } from './multiselect/batch-tags'

export {
  batchAssignCivitaiTags,
  batchCivitaiIdentify,
  batchCivitaiImages
} from './multiselect/batch-civitai'

export {
  batchOrganizeByTags,
  batchApplyTriggers,
  batchToggleDisabled,
  batchDeleteModels
} from './multiselect/batch-files'
