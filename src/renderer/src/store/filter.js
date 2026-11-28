/**
 * 筛选/搜索/排序派生状态门面（O6 按域拆分，保持 A-04 拆分惯例与既有
 * 导入路径不变）：本文件仅聚合 re-export，逻辑位于 filter/ 子模块——
 * - search.js      搜索域缓存/拼音空闲预构建/关键词模糊命中
 * - visibility.js  NSFW 可见性谓词与重复分组
 * - sorting.js     比较器/排序键/有序下标构建（PERF-SORT）
 * - pipeline.js    过滤层 + 排序结果缓存（filteredModels）
 * - collator.js    中文比较器共享实例
 * - tags.js        标签计数/标签池/分类计数
 */
export { prebuildPinyinSearchIndex } from './filter/search'
export {
  isModelVisible,
  visibleModels,
  allDuplicateGroups,
  duplicateGroups,
  duplicateIdSet,
  duplicateWastedBytes,
  allDuplicateWastedBytes,
} from './filter/visibility'
export { filteredModels } from './filter/pipeline'
export { tagCounts, allTags, visibleTags, typeCounts } from './filter/tags'
