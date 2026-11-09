/**
 * 库会话编排：模型根目录切换（关联存储 + 库设置 + 写盘链静止）。
 * 本模块是全域切换关联存储的唯一入口（扫描、秒开库与设置加载共用）。
 */

import logger from '../../../logger'
import { isSettledWithin, samePathIgnoreCase } from '../../../utils'
import {
  flushSettingsSave,
  getCurrentRoot,
  getSwitchFlushTimeoutMs,
  loadData,
  reloadLibrarySettings,
  switchDataRoot,
} from '../../../services/store'
import {
  maintenanceBusyMessage,
  releaseMaintenance,
  tryAcquireMaintenance,
} from '../../../services/maintenance-lock'
import { checkExistingDirectory } from '../../handler'
import { awaitThumbDrain } from '../../../services/decorate/state'

/**
 * 库列表全量根目录的存在性快照（F1-offline 库路径失效处理）：
 * 渲染层侧栏据 exists=false 的条目对失效库给出灰显标记；响应同时携带
 * 激活库的 folderMissing 标志，供渲染层进入离线态（重新定位/重试闭环）。
 * 并行 stat（库列表上限 20 条）：未挂载盘符的单次 stat 可能阻塞数秒，
 * 并行后总耗时取决于最慢一条而非串行累加。
 * @param {unknown} folders 设置中的模型库列表
 * @returns {Promise<Array<{folder: string, exists: boolean}>>}
 */
export async function collectRootStatuses(folders) {
  const list = Array.isArray(folders)
    ? folders.filter((f) => typeof f === 'string' && f)
    : []
  return Promise.all(
    list.map(async (folder) => ({
      folder,
      // checkExistingDirectory 返回空串表示存在（O2 助手语义）
      exists: (await checkExistingDirectory(folder)) === '',
    })),
  )
}

/**
 * 确保指定根目录的关联存储已加载。
 * 切换根目录前必须等待上一轮后台缩略图生成完成（B10）：
 * drain 过程中 getThumbsDir() 依赖 currentRoot，中途切换会把缩略图
 * 写进切换后的目录，且文件不被新根目录 keepNames 命中而被 pruneThumbs 清理。
 * 切库还必须先静止旧根写盘链（A6）：迟到防抖会把旧根数据写进新目录，
 * 见 switchDataRoot。
 *
 * 互斥（V-02）：调用方若已持有全局维护锁（扫描/恢复），必须传入
 * maintenanceToken，避免同一操作内二次加锁；未持有则本函数自行加锁。
 * @param {string} root 目标模型根目录
 * @param {{maintenanceToken?: {id: number}|null}} [options] 已持有的维护锁令牌
 */
export async function ensureRootStore(root, { maintenanceToken = null } = {}) {
  // OPT-19 同根判定（R6）：大小写不敏感比较（单一实现 utils.samePathIgnoreCase，
  // 与 watcher/store-settings 口径一致）——渲染层传来的 `d:\models` 与内存中的
  // `D:\models` 是同一目录，严格相等会误走完整切库（flush + loadData +
  // reloadSettings + 装饰缓存重置），白付一次全量元数据重载与索引 IO
  if (getCurrentRoot() && samePathIgnoreCase(getCurrentRoot(), root)) return

  let token = maintenanceToken
  let owned = false
  if (!token) {
    token = tryAcquireMaintenance('switch', root)
    if (!token) {
      // 调用方（如 loadStore）应把忙状态转换为可读错误；此处抛出由 wrapHandler 兜底
      throw new Error(maintenanceBusyMessage())
    }
    owned = true
  }
  try {
    // 切换根目录前必须等待上一轮后台缩略图生成完成（B10，等待入口收敛于 model-state）
    await awaitThumbDrain()
    // 旧根的库设置也先落盘（B-02）：随后 reloadLibrarySettings 会切换内存视图，
    // 排队中的旧库快照必须在此之前写完（其 target root 已在调度时固定）。
    // OPT-19：挂起磁盘上的该写盘同样可与超时赛跑——超时放弃本次设置落盘
    // （写盘链以调度时固定的旧根为目标在后台续跑），绝不卡死维护锁
    const settingsSettled = await isSettledWithin(
      flushSettingsSave(),
      getSwitchFlushTimeoutMs(),
    )
    if (!settingsSettled) {
      logger.warn('切库前库设置写盘等待超时，放弃本次落盘继续切换')
    }
    // 旧根待落盘数据先写入旧目录，再切换根目录（A6）；switchDataRoot 内部
    // 的元数据 flush 同样有超时底线与迟到残尾的同根守卫（OPT-19）
    await switchDataRoot(root)
    await loadData()
    // 库设置随根目录切换（设置随模型库走）：加载目标库的 .modelvault/settings.json，
    // 文件不存在时以默认值初始化并落盘；主题/视图等随目标库生效
    await reloadLibrarySettings(root)
  } finally {
    if (owned) releaseMaintenance(token)
  }
}
