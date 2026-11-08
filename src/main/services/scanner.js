/**
 * 模型扫描服务（门面）：分层后保持导入路径 `services/scanner` 与全部公共 API 不变。
 *
 * 内部按职责拆分（依赖单向：rules ← walk / sidecar，rules 无 IO）：
 * - scanner/rules.js   扩展名、排除/可见性策略、分类规则、添加时间派生（纯函数）
 * - scanner/walk.js    目录递归遍历与并行 stat（I/O，产出扫描结果与目录快照）
 * - scanner/sidecar.js 同名 sidecar（预览图/文本/civitai.info）定位与导入补丁
 *
 * 扫描与监控（watcher）共享 rules.js 的排除/可见性单一入口，避免两侧规则漂移。
 */

export {
  MODEL_EXTENSIONS,
  IMAGE_EXTENSIONS,
  MAX_SCAN_DEPTH,
  isExcludedScanEntryName,
  isExcludedScanName,
  isVisibleScanEntry,
  classifyModel,
  classifySubCategory,
  modelAddedMs,
} from './scanner/rules'

export { scanModels } from './scanner/walk'

export {
  SIDECAR_PREVIEW_EXTS,
  sidecarBaseOf,
  sidecarFilesFor,
  statSidecarSet,
  findSidecarPreview,
  findSidecarText,
  sidecarImportPatch,
  findSidecarCivitaiInfo,
  civitaiImportPatch,
} from './scanner/sidecar'
