import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_PAYLOAD_SCHEMAS } from '../shared/ipc-schema'

/**
 * IPC 通道白名单：渲染进程只能通过以下通道通信，防止任意通道调用。
 * 所有 invoke 均经过白名单校验（统一入口，新增通道必须先在 shared/ipc-schema.js
 * 注册表登记）。O2 单一来源：白名单由 schema 注册表键集派生，不再独立维护，
 * 与主进程注册点的一致性由 tests/ipcSchema.test.js 双向对账锁定。
 */
const VALID_INVOKE_CHANNELS = Object.freeze(Object.keys(IPC_PAYLOAD_SCHEMAS))

const VALID_RECEIVE_CHANNELS = [
  'app:updateProgress',
  'models:scanProgress',
  'models:menuAction',
  'models:thumbsReady',
  'models:storeError',
  'models:fsChanged',
  'models:warmupProgress'
]

/** 带白名单校验的 invoke（所有便捷方法的统一入口） */
function invokeValidated(channel, payload) {
  if (!VALID_INVOKE_CHANNELS.includes(channel)) {
    throw new Error(`不允许的 IPC 通道: ${channel}`)
  }
  return ipcRenderer.invoke(channel, payload)
}

/** 带白名单校验的事件订阅，返回取消监听函数 */
function subscribe(channel, listener) {
  if (!VALID_RECEIVE_CHANNELS.includes(channel)) {
    throw new Error(`不允许的 IPC 通道: ${channel}`)
  }
  const handler = (_event, data) => listener(data)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

/** 通过 contextBridge 向渲染进程暴露安全的 API。 */
const api = {
  /**
   * 获取拖拽文件的真实路径（Electron 32+ 移除了 File.path，
   * 渲染进程须通过 webUtils 解析）。
   * @param {File} file 拖拽事件中的文件对象
   * @returns {string} 文件绝对路径
   */
  getPathForFile: (file) => webUtils.getPathForFile(file),

  /** 应用信息 */
  app: {
    /** 应用与运行时版本信息 */
    getInfo: () => invokeValidated('app:getInfo'),
    /** 上报渲染进程异常（写入主进程日志） */
    reportError: (message, stack) => invokeValidated('app:reportError', { message, stack }),
    /** 应用内检查更新（E1）：返回 { current, latest?, hasUpdate, releaseUrl?, canDownload?, downloadSize? } 或 { error } */
    checkUpdate: () => invokeValidated('app:checkUpdate'),
    /** 下载更新包（F-6，URL 由主进程检查结果提供），进度经 onUpdateProgress 推送 */
    downloadUpdate: () => invokeValidated('app:downloadUpdate'),
    /** 取消进行中的更新包下载 */
    cancelUpdateDownload: () => invokeValidated('app:cancelUpdateDownload'),
    /** 运行更新程序（F-6）：延迟拉起新版本并退出当前应用 */
    installUpdate: () => invokeValidated('app:installUpdate'),
    /** 订阅更新包下载进度（{ received, total }），返回取消监听函数 */
    onUpdateProgress: (listener) => subscribe('app:updateProgress', listener),
    /** 在系统资源管理器中打开日志目录（B-04），返回 { ok } 或 { error } */
    openLogs: () => invokeValidated('app:openLogs')
  },

  /** 窗口相关（最小化/最大化/关闭由原生标题栏叠加层控件处理） */
  window: {
    /** 切换主题（同步原生标题栏颜色） */
    setTheme: (theme) => invokeValidated('window:setTheme', { theme })
  },

  /** 应用设置 */
  settings: {
    /** 更新设置，返回 { settings }（规范化后的完整设置） */
    update: (patch) => invokeValidated('settings:update', patch)
  },

  /** 模型管理 */
  models: {
    /** 加载持久化数据（设置 + 模型元数据 + 本地索引缓存） */
    loadStore: () => invokeValidated('models:loadStore'),
    /**
     * 打开已保存模型库（F1：优先返回本地索引，实现秒切库）
     * @param {string} folder 模型库根目录
     * @returns {Promise<{root:string, settings:object, cached:boolean,
     *   models?:object[], savedAt?:number, durationMs?:number} | {error:string}>}
     */
    openLibrary: (folder) => invokeValidated('models:openLibrary', { folder }),
    /** 弹出目录选择框，返回所选目录或 null */
    chooseFolder: () => invokeValidated('models:chooseFolder'),
    /** 扫描模型目录，返回 { models, byType, errors } 或 { canceled } / { error } */
    scan: (folder) => invokeValidated('models:scan', { folder }),
    /** 取消进行中的扫描，返回 { ok } */
    cancelScan: () => invokeValidated('models:cancelScan'),
    /**
     * 局部增量扫描（A-03）：只扫描指定变更子树，返回这些子树的模型现状。
     * payload 为 { folder, dirs }（dirs 为 POSIX 相对目录数组，'' 为根直属）
     */
    partialScan: (payload) => invokeValidated('models:partialScan', payload),
    /** 保存模型推荐参数与备注 */
    saveModelData: (payload) => invokeValidated('models:saveModelData', payload),
    /** 上传模型封面，返回 { cover, coverUrl, covers, meta } 或 { canceled } / { error } */
    uploadCover: (id) => invokeValidated('models:uploadCover', { id }),
    /** 将剪贴板图片添加为模型预览图，返回 { cover, coverUrl, covers, meta } 或 { error } */
    pasteCover: (id) => invokeValidated('models:pasteCover', { id }),
    /** 设置默认封面（cover 为封面相对路径），返回 { cover, coverUrl, covers, meta } 或 { error } */
    setDefaultCover: (id, cover) => invokeValidated('models:setDefaultCover', { id, cover }),
    /** 删除单张封面（cover 为封面相对路径），返回 { cover, coverUrl, covers, meta } 或 { error } */
    deleteCover: (id, cover) => invokeValidated('models:deleteCover', { id, cover }),
    /** 一键移除全部示例图（清空封面列表并删除物理文件），返回 { cover, coverUrl, covers, meta } 或 { error } */
    clearCovers: (id) => invokeValidated('models:clearCovers', { id }),
    /** 一键清空当前库全部模型的示例图（设置页数据清理），返回 { cleared, images } 或 { error } */
    clearAllCovers: () => invokeValidated('models:clearAllCovers'),
    /**
     * 模型库体检（V-07）：检查缺失模型文件/失效封面引用/孤儿封面/重复哈希，
     * 返回 { report } 或 { error }；只读，不修改任何数据
     */
    checkHealth: () => invokeValidated('models:checkHealth'),
    /**
     * 一键修复（V-07）：移除缺失文件的元数据、清理失效封面引用、
     * 孤儿封面移入 .modelvault/trash；修复前备份 store.json。
     * 返回 { report, repaired, backupPath, dataResetSkipped? } 或 { error }
     */
    repairHealth: () => invokeValidated('models:repairHealth'),
    /** 导出备份（FEAT-3）：设置 + 当前库标注/封面 → zip，返回 { path, sizeBytes, library, models, covers } / { canceled } / { error } */
    exportBackup: () => invokeValidated('models:exportBackup'),
    /** 从备份恢复（FEAT-3）：zip → 设置 + 指定库，返回 { settingsRestored, libraryRestored? } / { canceled } / { error } */
    importBackup: () => invokeValidated('models:importBackup'),
    /** 删除模型文件（移入回收站并清理元数据），返回 { ok } 或 { error } */
    deleteModel: (id) => invokeValidated('models:deleteModel', { id }),
    /** 更新快捷标记（收藏/NSFW/评分，仅传需更新的字段），返回 { meta } 或 { error } */
    setMetaFlags: (payload) => invokeValidated('models:setMetaFlags', payload),
    /** 整体覆写模型自由标签（F-5，tags 为全量字符串数组），返回 { meta } 或 { error } */
    setModelTags: (id, tags) => invokeValidated('models:setModelTags', { id, tags }),
    /** 全库重命名自由标签（F4，to 已存在时合并），返回 { changed } 或 { error } */
    renameTag: (from, to) => invokeValidated('models:renameTag', { from, to }),
    /** 全库移除自由标签（F4），返回 { changed } 或 { error } */
    removeTag: (tag) => invokeValidated('models:removeTag', { tag }),
    /** 弹出模型右键菜单（原生菜单），动作经 onMenuAction 事件回传 */
    popupMenu: (id) => invokeValidated('models:popupMenu', { id }),
    /** 拖拽导入封面（sourcePath 为外部图片绝对路径），返回 { cover, coverUrl, covers, meta } 或 { error } */
    importCover: (id, sourcePath) => invokeValidated('models:importCover', { id, path: sourcePath }),
    /** 在资源管理器中显示文件 */
    reveal: (path) => invokeValidated('models:reveal', { path }),
    /** 订阅扫描进度，返回取消监听函数 */
    onScanProgress: (listener) => subscribe('models:scanProgress', listener),
    /** 订阅目录变更事件（E8：{ root }），返回取消监听函数 */
    onFsChanged: (listener) => subscribe('models:fsChanged', listener),
    /** 订阅元数据落盘失败事件（message: 错误信息），返回取消监听函数 */
    onStoreError: (listener) => subscribe('models:storeError', listener),
    /** 订阅后台缩略图生成完成事件（updates: [{ id, coverUrl?, coverThumb? }]，
     * coverThumb 为轮播封面条目缩略图更新 { path, thumbUrl }），返回取消监听函数 */
    onThumbsReady: (listener) => subscribe('models:thumbsReady', listener),
    /** 订阅后台哈希预热进度事件（快照: { active, id, percent, hashedBytes, totalBytes, done, remaining }） */
    onWarmupProgress: (listener) => subscribe('models:warmupProgress', listener),
    /** 订阅右键菜单动作事件，返回取消监听函数 */
    onMenuAction: (listener) => subscribe('models:menuAction', listener),
    /** 加/去 .disabled 后缀（F10），返回 { path } 或 { error } */
    toggleDisabled: (id, disabled) => invokeValidated('models:toggleDisabled', { id, disabled }),
    /** 库内移动模型（F11，目标目录经原生对话框选择），返回 { path } / { canceled } / { error } */
    moveModelTo: (id) => invokeValidated('models:moveModelTo', { id }),
    /**
     * 一键移动文件（自动标签整理）：moves 为 [{ id, subCategory }]，主进程在
     * 模型库根目录创建 7 个分类文件夹并移动已分配标签的模型（元数据键同步
     * 迁移），返回 { moved, failed: [{id, error}], skipped: [{id, reason}] } 或 { error }
     */
    organizeByTags: (moves) => invokeValidated('models:organizeByTags', { moves }),
    /**
     * Civitai 在线识别（按文件 SHA256 反查），返回
     * { found: true, url, info, meta } / { found: false } / { error }。
     * 大文件哈希计算可能耗时数十秒，调用方需提供忙碌提示
     */
    civitaiIdentify: (id) => invokeValidated('models:civitaiIdentify', { id }),
    /**
     * Civitai 一键分配标签（仅 LoRA 模型；按已保存链接查询模型分类并映射
     * 分类标签），返回 { found: true, subCategory, meta }
     * / { found: true, unmapped: true } / { skipped: true, reason? }
     * / { found: false } / { error }
     */
    civitaiCategory: (id) => invokeValidated('models:civitaiCategory', { id }),
    /**
     * Civitai 一键补全（仅填充空缺的触发词/备注），返回
     * { found: true, applied: string[], meta } / { found: false } / { error }
     */
    civitaiComplete: (id) => invokeValidated('models:civitaiComplete', { id }),
    /**
     * 导入 Civitai 示例图为模型封面（images: [{url}]，仅限 Civitai CDN，
     * 单次上限 20 张），返回 { added, failed, cover, coverUrl, covers, meta }
     * 或 { error }
     */
    civitaiImportImages: (id, images) =>
      invokeValidated('models:civitaiImportImages', { id, images }),
    /**
     * 预热模型哈希（Civitai 识别加速）：详情页打开时调用，后台计算该模型
     * 的 SHA256 并写入元数据缓存，入队即返回 { ok }，不等待计算完成
     */
    warmupHash: (id) => invokeValidated('models:warmupHash', { id })
  }
}

contextBridge.exposeInMainWorld('api', api)
