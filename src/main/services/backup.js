/**
 * 数据备份与恢复（FEAT-3）——聚合门面（O2 拆分）：
 * - backup-format.js   格式契约层：zip 内布局常量、manifest 校验、封面条目名安全
 * - backup-zip.js      流式编解码层：fflate 异步压缩/解压、逐条与总量限制（B-04）
 * - backup-export.js   导出流程：设置 + 关联存储打包（full/selected/metadata，FN-08）
 * - backup-restore.js  恢复流程：目录交换全量恢复 / 合并恢复 + 残留治理（OPT-18）
 *
 * 本文件仅做显式重导出，维持所有既有 `from './services/backup'`（或相对路径）
 * 的导入名称不变；显式列举（而非 export *）以锁定公共导出契约
 * （与 store.js/appStore.js 门面同一模式）。逻辑在子模块中计量，
 * 本门面不参与覆盖率统计（见 vitest.config.mjs exclude）。
 */

// ---------- 格式契约层 ----------
export {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  PARTIAL_BACKUP_VERSION,
  parseBackupManifest,
  safeCoverName,
} from './backup-format'

// ---------- 流式编解码层 ----------
export { unzipBackupAsync, zipBackupAsync } from './backup-zip'

// ---------- 导出 / 恢复流程 ----------
export { exportBackup } from './backup-export'
export { importBackup } from './backup-restore'
