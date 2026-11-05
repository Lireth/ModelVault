/**
 * 文件级操作链路（批次 4）——聚合门面（C2/A-04 拆分惯例，O-2）：
 * 逻辑按域拆分至子模块，本文件仅保留导入路径与注册入口（无逻辑，
 * 纯 re-export + 注册编排），历史导入方（tests/modelsFiles.test.js 等）
 * 与 ipc/models/index.js 的注册路径不变。
 *
 * 域划分：
 * - files-rename.js：models:toggleDisabled（F10 禁用/启用）+ models:renameModel
 *   （N1 重命名）——「改名类」操作，维护锁内执行；
 * - files-organize.js：models:moveModelTo（F11 库内移动）+ models:transferToLibrary
 *   （F-3 跨库传输）+ models:organizeByTags（自动标签一键整理）——「移动类」操作；
 * - files-import.js：models:importModels（F2 外部模型导入，复制/移动入台）。
 */

export {
  isImportableModelFile,
  planImportTarget,
  splitModelFileName,
} from './files-import'
export { planRenameTarget } from './files-rename'
export { planOrganizeMoves } from './files-organize'

import { registerImportModelsHandler } from './files-import'
import { registerRenameHandlers } from './files-rename'
import { registerMoveHandlers } from './files-organize'

/** 注册文件操作链路的全部 IPC 处理器（注册顺序与拆分前一致） */
export function registerFilesHandlers() {
  registerRenameHandlers()
  registerMoveHandlers()
  registerImportModelsHandler()
}
