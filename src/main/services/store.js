/**
 * 关联存储模块（门面，C2 拆分后保持导入路径与公共 API 不变）：
 *
 * 内部按职责拆分为五个模块，本文件是它们对外的唯一导入入口——
 * 项目约定所有持久化写入（settings.json/window-state.json/store.json）
 * 都必须使用此处导出的 atomicWriteFile，其余模块也应从 './store' 导入：
 * - atomic-write.js  原子写入（临时文件 + rename）
 * - store-events.js  持久化失败通知（监听器注册与广播）
 * - store-paths.js   存储位置常量、根目录状态与路径换算
 * - store-settings.js 应用设置（settings.json 加载/规范化/更新）
 * - store-meta.js    关联存储（.modelvault/store.json 元数据与落盘链）
 *
 * 设计要点：
 * - 应用设置（最近使用的模型根目录）保存在用户数据目录 settings.json
 * - 模型的所有用户数据（封面图片、推荐参数、备注、二级分类标签等）
 *   统一保存在用户所选模型根目录下的 .modelvault/ 文件夹中：
 *     <模型根目录>/.modelvault/store.json   元数据（按相对路径关联模型）
 *     <模型根目录>/.modelvault/covers/      上传的封面图片
 * - 元数据键为相对于模型根目录的路径，封面为相对路径，
 *   因此整个模型文件夹移动/复制到其他位置后关联关系依然成立。
 * - 首次对某个根目录启用关联存储时，自动从旧版（%APPDATA% 全局存储）
 *   迁移属于该目录的记录，并复制封面文件。
 */

/* ---------------- 原子写入 ---------------- */

export { atomicWriteFile } from './atomic-write'

/* ---------------- 持久化失败通知 ---------------- */

export { setStoreSaveErrorListener } from './store-events'

/* ---------------- 存储位置与路径换算 ---------------- */

export {
  DATA_DIR,
  DATA_FILE,
  COVERS_DIR,
  setDataRoot,
  getCurrentRoot,
  getCoversDir,
  isInRoot,
  resolveCover,
  relativizeCover
} from './store-paths'

/* ---------------- 应用设置 ---------------- */

export { loadSettings, getSettings, updateSettings } from './store-settings'

/* ---------------- 关联存储（按模型根目录） ---------------- */

export {
  loadData,
  wasDataReset,
  getReferencedCovers,
  getModelMeta,
  getMetaMapByAbsPath,
  setModelMeta,
  removeModelMeta,
  setModelHash,
  scheduleSave,
  saveStoreNow,
  flushStoreSave,
  switchDataRoot
} from './store-meta'
