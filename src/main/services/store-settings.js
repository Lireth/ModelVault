import path from 'node:path'
import fs from 'node:fs/promises'
import { app } from 'electron'
import logger from '../logger'
import { preserveCorruptedFile, samePathIgnoreCase } from '../utils'
import { BOOTSTRAP_SETTING_KEYS } from '../../shared/defaults'
import {
  LEGACY_STORE_FILE,
  getCurrentRoot,
  getLibSettingsFilePath,
} from './store-paths'
import {
  defaultBootstrapSettings,
  defaultLibrarySettings,
  normalizeBootstrapSettings,
  normalizeLibrarySettings,
  normalizeSettings,
} from './store-settings-normalize'
import {
  flushSettingsSave,
  getSettingsFilePath,
  isDirectoryAvailable,
  queueBootstrapSave,
  queueLibrarySave,
  writeBootstrapNow,
  writeLibraryNow,
} from './store-settings-persist'
import { errorCode, errorMessage } from '../../shared/error-text'

/**
 * 应用设置门面（C2 自 store.js 拆出；按职责再拆为 normalize/persist）：
 *
 * 双层存储：
 * - 引导层 %APPDATA%/modelvault/settings.json：仅 modelsFolder（激活库）与
 *   modelsFolders（库列表）。这两项无法存在某个库内部——尚未找到库时读不到
 *   列表（引导悖论），必须留在系统目录作为启动引导。
 * - 库层 <模型根目录>/.modelvault/settings.json：其余全部字段（主题/外观/
 *   扫描/浏览/智能视图等）。库文件随模型文件夹移动/复制，换机器打开即恢复
 *   完整配置；每个库相互独立。
 *
 * 内存中保持双态（bootstrap + library），getSettings() 对外返回合并视图，
 * 既有消费方（扫描/窗口主题/备份）的读取 API 与行为不变。
 *
 * 模块布局：
 * - store-settings-normalize.js 默认值/旧版迁移/类型与枚举收口（纯函数）
 * - store-settings-persist.js   引导层/库层写盘链、防抖合并与 flush 等待
 * - 本文件                      内存态、加载编排、更新入口与公共 API
 *
 * 旧版迁移：settings.json 曾承载全部字段。启动加载时若库设置文件不存在，
 * 以全局文件（或旧版 store.json 内嵌 settings）的字段为种子初始化当前激活库，
 * 随后将全局文件原子精简为仅引导字段；其余库在首次切换时以默认值初始化。
 */

/** 引导字段（随系统留存 %APPDATA%，不写入任何库文件；键清单共享单一来源） */
const BOOTSTRAP_KEYS = new Set(BOOTSTRAP_SETTING_KEYS)

/** 内存中的引导设置（modelsFolder / modelsFolders） */
let bootstrap = null

/** 内存中的当前库设置（除引导字段外的全部设置，随模型根目录切换） */
let library = null

/**
 * 加载指定根目录的库设置文件（.modelvault/settings.json）。
 * @param {string} root 模型根目录绝对路径
 * @param {object|null} [seedRaw] 首次初始化种子（旧版全局设置的遗留字段；空则用默认值）
 * @returns {Promise<object>} 规范化后的库设置（仅内存，不写引导层）
 */
async function loadLibrarySettings(root, seedRaw = null) {
  const file = getLibSettingsFilePath(root)
  try {
    const text = await fs.readFile(file, 'utf-8')
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('根节点不是 JSON 对象')
    }
    return normalizeLibrarySettings(parsed)
  } catch (err) {
    if (errorCode(err) === 'ENOENT') {
      // 该库首次打开：以迁移种子（旧版全局设置遗留字段）或默认值初始化并落盘。
      // O5：库目录离线（被移动/盘符未挂载）时只驻内存，不写入（否则 mkdir
      // 会把 .modelvault 重建到已失效的旧路径）
      const seeded = normalizeLibrarySettings(seedRaw)
      if (!(await isDirectoryAvailable(root))) {
        logger.warn(`模型库目录不可用，跳过库设置初始化写入: ${root}`)
        return seeded
      }
      try {
        await writeLibraryNow(root, JSON.stringify(seeded, null, 2))
        if (seedRaw) logger.info(`应用设置已迁移至模型库: ${file}`)
      } catch (writeErr) {
        // 目录只读/磁盘离线等：库文件不落盘，设置本次会话仅内存生效
        logger.warn(
          `库设置初始化写入失败（仅内存生效）: ${errorMessage(writeErr)}`,
        )
      }
      return seeded
    }
    // 库设置损坏（如写入中断电、磁盘错误）：备份原文件后重置，保留手动恢复机会
    // （时间戳命名滚动保留，连续损坏不互相覆盖）
    try {
      const backup = await preserveCorruptedFile(file)
      logger.error(
        `库设置文件损坏，原文件已备份为 ${path.basename(backup)} 后重置: ${errorMessage(err)}`,
      )
    } catch (backupErr) {
      logger.error(
        `库设置加载失败，已重置（备份失败: ${errorMessage(backupErr)}）: ${errorMessage(err)}`,
      )
    }
    return defaultLibrarySettings()
  }
}

/** 将引导字段原子写入全局设置文件（精简后的引导层布局） */
async function writeBootstrapFile() {
  await writeBootstrapNow(JSON.stringify(bootstrap, null, 2))
}

/**
 * 加载应用设置（双层）：引导层读 %APPDATA%，随后按激活库加载库层设置。
 * 仅应用启动时调用一次，运行期以 getSettings() 读取内存值。
 * 旧版兼容：settings.json 不存在时尝试从旧版 store.json 内嵌 settings 恢复；
 * 全局文件仍为旧版完整布局时，激活库完成种子迁移后自动精简为引导字段。
 * @returns {Promise<Record<string, any>>} 合并后的设置视图
 */
export async function loadSettings() {
  // OPT-4：先完整冲刷防抖待写再读盘——重入场景（loadStore 链路会在会话中
  // 再次调用本函数）若读到滞后的磁盘，会用陈旧引导层重置内存，把尚未落盘的
  // 激活库/库列表更新静默回滚。无待写时冲刷为立即返回的空操作
  await flushSettingsSave()
  let rawGlobal = null
  let globalCorrupt = false
  try {
    const text = await fs.readFile(getSettingsFilePath(), 'utf-8')
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('根节点不是 JSON 对象')
    }
    rawGlobal = parsed
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') {
      globalCorrupt = true
      // settings.json 损坏：备份原文件后重置，保留手动恢复机会
      // （时间戳命名滚动保留，连续损坏不互相覆盖）
      bootstrap = defaultBootstrapSettings()
      try {
        const backup = await preserveCorruptedFile(getSettingsFilePath())
        logger.error(
          `应用设置文件损坏，原文件已备份为 ${path.basename(backup)} 后重置: ${errorMessage(err)}`,
        )
      } catch (backupErr) {
        logger.error(
          `应用设置加载失败，已重置（备份失败: ${errorMessage(backupErr)}）: ${errorMessage(err)}`,
        )
      }
    }
  }

  if (rawGlobal) {
    bootstrap = normalizeBootstrapSettings(rawGlobal)
  } else if (!globalCorrupt) {
    bootstrap = defaultBootstrapSettings()
    // settings.json 不存在：尝试从旧版 store.json 恢复设置
    try {
      const legacyText = await fs.readFile(
        path.join(app.getPath('userData'), LEGACY_STORE_FILE),
        'utf-8',
      )
      const legacy = JSON.parse(legacyText)
      if (
        typeof legacy?.settings?.modelsFolder === 'string' &&
        legacy.settings.modelsFolder
      ) {
        bootstrap = normalizeBootstrapSettings(legacy.settings)
        rawGlobal = legacy.settings
        logger.info(`已从旧版存储恢复应用设置: ${bootstrap.modelsFolder}`)
      }
    } catch {
      /* 无旧版数据，使用默认值 */
    }
  }

  if (bootstrap.modelsFolder) {
    // 已设置目录不存在（磁盘离线/被移动）时库设置以默认值驻内存，不落盘、不迁移
    library = await loadLibrarySettings(bootstrap.modelsFolder, rawGlobal)
    // 旧版布局迁移收尾：激活库文件已生成后，将全局文件精简为仅引导字段
    // （旧值已迁入库文件；库文件写入失败时保留全局原样，下次启动重试迁移）
    const hasLegacyFields = Object.keys(rawGlobal || {}).some(
      (k) => !BOOTSTRAP_KEYS.has(k),
    )
    if (hasLegacyFields) {
      try {
        await fs.access(getLibSettingsFilePath(bootstrap.modelsFolder))
        await writeBootstrapFile()
        logger.info(
          '全局设置已精简为引导字段（激活库/库列表），其余设置随模型库存储',
        )
      } catch {
        /* 库文件尚未生成，保留全局文件作为下次迁移种子 */
      }
    }
  } else if (getCurrentRoot()) {
    // 引导层尚无激活库但内存中已有生效根目录（loadStore 重入等场景）：
    // 库设置跟随当前激活根加载，避免把已生效的库设置重置为默认值
    library = await loadLibrarySettings(getCurrentRoot())
  } else {
    library = defaultLibrarySettings()
  }
  return getSettings()
}

/**
 * 获取当前内存中的应用设置（引导层 + 当前库的合并视图）。
 * @returns {Record<string, any>} 合并后的设置
 */
export function getSettings() {
  // loadSettings 之前防御性返回默认值（正常启动时序下不会走到）
  if (!bootstrap) bootstrap = defaultBootstrapSettings()
  if (!library) library = defaultLibrarySettings()
  return { ...library, ...bootstrap }
}

/** 获取当前库设置（不含引导字段；备份导出用——备份不得携带库列表/激活库） */
export function getLibrarySettings() {
  if (!library) library = defaultLibrarySettings()
  return library
}

/**
 * 目录是否属于模型库白名单（B1，单一可信来源）：settings.modelsFolders
 * （上限 20）。列表条目只能经 models:chooseFolder（用户对话框确认）写入；
 * 主进程扫描成功链路只更新已登记库的激活根，不新增条目；settings:update
 * 仅允许激活/移除/重排已登记库，不能再新增根目录。该列表是
 * 「.modelvault 写入点可以指向哪里」的唯一可信来源；渲染进程直接传入的
 * 任意路径不得成为关联存储根。Windows 大小写不敏感比较。
 * @param {unknown} dir 目标目录
 * @returns {boolean} 已登记为模型库时为 true
 */
export function isRegisteredLibrary(dir) {
  const list = getSettings().modelsFolders || []
  const lower = String(dir).toLowerCase()
  return list.some((f) => typeof f === 'string' && f.toLowerCase() === lower)
}

/**
 * 更新应用设置（规范化后按层拆分，内存即时生效，落盘经防抖合并）：
 * - 内存：规范化结果与当前内存逐层比对，有变化才替换（getSettings 立即可见）；
 * - 变更检测（OPT-4）：纯重复更新（同一设置重复提交、规范化幂等回退）零磁盘
 *   IO、不入防抖队列——主题/排序/卡片尺寸等连续切换不再逐次触发全量
 *   「mkdir + tmp + fsync + rename」；
 * - 防抖（OPT-4）：短窗口内的多次更新合并为一次落盘（与元数据侧 SAVE_DELAY
 *   同值 500ms，持续变更受最长等待约束保证前进）；快照与 root 仍在调用
 *   同步段捕获（B-02），迟到的落盘只写「本次调用所属库」的内容；
 * - 引导字段 → %APPDATA%/modelvault/settings.json；库字段 →
 *   <当前模型根目录>/.modelvault/settings.json（无激活根时仅内存生效，
 *   首次选库扫描后经库设置初始化落盘）。切库/备份/退出经 flushSettingsSave
 *   冲刷待写快照，落盘时机语义与防抖前一致。
 * @param {Record<string, any>} patch 设置增量
 * @returns {Promise<void>}
 */
export async function updateSettings(patch) {
  if (!patch || typeof patch !== 'object') return
  // 合并规范化（单一校验入口）
  const merged = normalizeSettings({ ...getSettings(), ...patch })
  const nextBootstrap = normalizeBootstrapSettings(merged)
  const nextLibrary = normalizeLibrarySettings(merged)

  const touchesBootstrap = 'modelsFolder' in patch || 'modelsFolders' in patch
  const touchesLibrary = Object.keys(patch).some((k) => !BOOTSTRAP_KEYS.has(k))

  if (touchesBootstrap) {
    const snapshot = JSON.stringify(nextBootstrap, null, 2)
    if (snapshot !== JSON.stringify(bootstrap, null, 2)) {
      bootstrap = nextBootstrap
      queueBootstrapSave(snapshot)
    }
  }
  if (touchesLibrary) {
    // 调度时立即序列化快照（B-02）：执行时求值会读取可能已被切库/重载替换的
    // 全局 library，导致旧库补丁写入新库。快照 + root 均在同步段捕获，
    // 队列任务只写「本次调用所属库」的内容
    const snapshot = JSON.stringify(nextLibrary, null, 2)
    if (snapshot !== JSON.stringify(library, null, 2)) {
      library = nextLibrary
      const libraryRoot = getCurrentRoot()
      if (libraryRoot) queueLibrarySave(libraryRoot, snapshot)
    }
  }
}

/**
 * 重载指定根目录的库设置到内存（切库/备份恢复到当前库后调用）：
 * 读取该库的 .modelvault/settings.json；文件不存在时以默认值初始化并落盘，
 * 损坏时备份为带时间戳的 .bak（滚动保留最近 3 份）后以默认值重置。root 为
 * 空时内存回退默认值。
 * @param {string|null} root 模型根目录绝对路径
 * @returns {Promise<void>}
 */
export async function reloadLibrarySettings(root) {
  // 先静止旧库写盘链（B-02）：排队中的补丁都携带旧库快照，必须写完再切换内存视图，
  // 避免重载后的新库设置立刻被旧任务覆盖
  await flushSettingsSave()
  library = root ? await loadLibrarySettings(root) : defaultLibrarySettings()
}

/**
 * 保存库设置到指定根目录（备份导入的设置-only 路径使用）：
 * 规范化后原子写入该库的 .modelvault/settings.json；目标为当前激活库时
 * 同步更新内存，使本次会话立即生效。
 * @param {string} root 模型根目录绝对路径
 * @param {object} raw 原始库设置（引导字段被自动剔除）
 * @returns {Promise<object>} 规范化后的库设置
 */
export async function saveLibrarySettings(root, raw) {
  const normalized = normalizeLibrarySettings(raw)
  // 与 updateSettings 共用同一条写盘链（B-02）：备份恢复写入库设置时，
  // 若与在途的设置更新并发，共享临时文件会互相打断或让旧快照后落盘
  const snapshot = JSON.stringify(normalized, null, 2)
  await writeLibraryNow(root, snapshot)
  const active = getCurrentRoot()
  if (root && active && samePathIgnoreCase(root, active)) {
    library = normalized
  }
  return normalized
}

/* ---------------- 公共 API 再导出（保持 store.js 既有导入面） ---------------- */

export { flushSettingsSave, normalizeLibrarySettings }
export {
  flushSettingsSaveBounded,
  setSettingsFlushAwaitTimeoutForTests,
  setSettingsSaveDelayForTests,
} from './store-settings-persist'
