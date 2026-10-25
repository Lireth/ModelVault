/**
 * 备份格式契约层（O2 拆分，纯函数无 IO）：
 * 定义备份文件的 zip 内布局常量、清单（manifest.json）结构与校验、
 * 封面条目名安全校验——导出（backup-export）与恢复（backup-restore）
 * 共同遵守的单一来源。仅做字符串/字节级判定，不触碰文件系统与对话框。
 *
 * 备份文件结构（zip 内）：
 *   manifest.json        格式标识与内容清单（app/version/createdAt/library）
 *   settings.json        库设置快照（随模型库走，不含引导字段）
 *   library/store.json   目标库元数据（按相对路径关联模型）
 *   library/covers/*     封面文件
 */

/** 备份格式标识（manifest.app 必须匹配才接受恢复） */
export const BACKUP_FORMAT = 'modelvault-backup'
/** 备份格式版本（大于当前版本的备份拒绝恢复，提示升级应用） */
export const BACKUP_VERSION = 1
/**
 * 选择性/元数据备份的格式版本（FN-08）：旧版本应用不认识 partial 语义，
 * 若按全量恢复会只保留子集标注。提升版本号让旧应用以「版本过新」拒绝，
 * 新应用同时兼容读取 v1（全量/手工）与 v2（选择性）。
 */
export const PARTIAL_BACKUP_VERSION = 2

/** 库数据在 zip 内的前缀 */
export const LIB_PREFIX = 'library/'
export const LIB_COVERS_PREFIX = 'library/covers/'

/**
 * 备份清单（manifest.json 经 parseBackupManifest 校验后的结构）
 * @typedef {object} BackupManifest
 * @property {string} app 备份格式标识（BACKUP_FORMAT）
 * @property {number} version 备份格式版本
 * @property {string} createdAt 创建时间（ISO 字符串）
 * @property {string} appVersion 导出时的应用版本
 * @property {boolean} settings 是否包含设置数据
 * @property {'full'|'selected'|'metadata'} mode 备份范围
 * @property {boolean} partial 是否为部分备份（合并恢复）
 * @property {{root: string, models: number, covers: number}} [library] 库数据摘要（含库数据时存在）
 */

/**
 * 备份恢复结果（importBackup 的统一返回形状；各路径仅填相关字段）
 * @typedef {object} BackupRestoreResult
 * @property {boolean} [canceled] 用户取消
 * @property {boolean} [settingsRestored] 是否恢复了设置
 * @property {Record<string, any>} [libraryRestored] 库恢复详情（restoreLibrary/restorePartialLibrary 结果）
 * @property {number} [skipped] 解压/合并阶段跳过的条目数
 * @property {boolean} [partial] 是否为部分（合并）恢复
 * @property {string} [error] 错误信息（空缺表示无错误）
 * @property {string} [root] 恢复目标根目录
 * @property {number} [models] 恢复的模型数
 * @property {number} [covers] 恢复的封面数
 * @property {string} [mode] 备份范围模式
 * @property {number} [added] 合并新增的模型数
 * @property {number} [updated] 合并更新的模型数
 * @property {string} [backupPath] 恢复前的 store.json 快照路径
 */

/**
 * 校验并解析备份清单（纯函数）。
 * @param {Uint8Array|null|undefined} bytes manifest.json 的内容字节
 * @returns {{ok: boolean, manifest?: BackupManifest, error?: string}}
 *   ok=false 时 error 必有值；ok=true 时 manifest 必有值
 */
export function parseBackupManifest(bytes) {
  if (!bytes || bytes.byteLength === 0) {
    return { ok: false, error: '备份文件缺少 manifest.json' }
  }
  let manifest
  try {
    manifest = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return { ok: false, error: '备份文件的 manifest.json 损坏' }
  }
  if (manifest?.app !== BACKUP_FORMAT) {
    return { ok: false, error: '不是有效的 ModelVault 备份文件' }
  }
  if (
    !Number.isFinite(manifest.version) ||
    manifest.version > PARTIAL_BACKUP_VERSION
  ) {
    return { ok: false, error: '备份文件版本过新，请升级应用后重试' }
  }
  return { ok: true, manifest }
}

/**
 * 校验 zip 条目名是否为安全的封面文件名（纯函数）：
 * 拒绝路径穿越（..）、绝对/驱动器路径与任何子目录结构——
 * 备份 zip 可能来自不可信来源，条目名不得参与拼接近路。
 * @param {string} entryName zip 内的完整条目名
 * @returns {string} 安全的文件名；不合法返回 ''
 */
export function safeCoverName(entryName) {
  if (typeof entryName !== 'string' || !entryName.startsWith(LIB_COVERS_PREFIX))
    return ''
  const base = entryName.slice(LIB_COVERS_PREFIX.length)
  if (!base || base === '.' || base === '..') return ''
  if (base.includes('/') || base.includes('\\')) return ''
  // 驱动器相对路径（如 C:x.png）在 Windows 上会改变解析基准
  if (/^[a-zA-Z]:/.test(base)) return ''
  return base
}
