import { contextBridge, ipcRenderer, webUtils } from 'electron'

/**
 * IPC 通道白名单：渲染进程只能通过以下通道通信，防止任意通道调用。
 * 所有 invoke 均经过白名单校验（统一入口，新增通道必须先在此注册）。
 */
const VALID_INVOKE_CHANNELS = [
  'app:getInfo',
  'app:reportError',
  'app:checkUpdate',
  'app:openLogs',
  'window:setTheme',
  'settings:update',
  'models:loadStore',
  'models:chooseFolder',
  'models:scan',
  'models:partialScan',
  'models:cancelScan',
  'models:saveModelData',
  'models:uploadCover',
  'models:pasteCover',
  'models:setDefaultCover',
  'models:deleteCover',
  'models:deleteModel',
  'models:setMetaFlags',
  'models:popupMenu',
  'models:importCover',
  'models:reveal',
  'models:exportList',
  'models:computeHashBatch',
  'models:cancelHashBatch',
  'models:exportBackup',
  'models:importBackup',
  'models:listDirs',
  'models:createFolder',
  'models:renameFolder',
  'models:moveModels',
  'models:metaGaps',
  'models:bindMeta'
]

const VALID_RECEIVE_CHANNELS = [
  'models:scanProgress',
  'models:menuAction',
  'models:thumbsReady',
  'models:storeError',
  'models:hashProgress',
  'models:fsChanged'
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
    /** 应用内检查更新（E1）：返回 { current, latest?, hasUpdate, releaseUrl? } 或 { error } */
    checkUpdate: () => invokeValidated('app:checkUpdate'),
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
    /** 加载持久化数据（设置 + 模型元数据） */
    loadStore: () => invokeValidated('models:loadStore'),
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
    /** 导出模型列表（E2），rows 为当前列表行，返回 { path, count } / { canceled } / { error } */
    exportList: (payload) => invokeValidated('models:exportList', payload),
    /** 批量计算文件哈希（E5 重复检测），返回 { hashes: {id:hash} } / { canceled } / { error } */
    computeHashBatch: (payload) => invokeValidated('models:computeHashBatch', payload),
    /** 取消批量哈希计算（E5），返回 { ok } */
    cancelHashBatch: () => invokeValidated('models:cancelHashBatch'),
    /** 导出备份（FEAT-3）：设置 + 当前库标注/封面 → zip，返回 { path, sizeBytes, library, models, covers } / { canceled } / { error } */
    exportBackup: () => invokeValidated('models:exportBackup'),
    /** 从备份恢复（FEAT-3）：zip → 设置 + 指定库，返回 { settingsRestored, libraryRestored? } / { canceled } / { error } */
    importBackup: () => invokeValidated('models:importBackup'),
    /** 列举库内目录（B-06，含空目录），返回 { dirs: string[] }（POSIX 相对目录，'' 为根） */
    listDirs: () => invokeValidated('models:listDirs'),
    /** 库内新建文件夹（B-06），relDir 为 POSIX 相对目录，返回 { ok, dir, existed? } / { error } */
    createFolder: (relDir) => invokeValidated('models:createFolder', { relDir }),
    /** 重命名库内文件夹（B-06），返回 { ok, oldDir, newDir, moved } / { error } */
    renameFolder: (relDir, newName) =>
      invokeValidated('models:renameFolder', { relDir, newName }),
    /**
     * 移动模型文件到库内目标文件夹（B-06）：
     * payload { ids: 绝对路径数组, destDir: POSIX 相对目录（'' 为根） }
     * 返回 { moved: [{from,to,model}], failed: [{id,error}], destDir } / { error }
     */
    moveModels: (payload) => invokeValidated('models:moveModels', payload),
    /** 元数据缺口查询（B-06）：payload { ids: 当前模型绝对路径 }，返回 { orphans, newcomers } */
    metaGaps: (ids) => invokeValidated('models:metaGaps', { ids }),
    /** 手动绑定失联标注（B-06）：{ oldKey, newKey } 均为 POSIX 相对键，返回 { ok, model } / { error } */
    bindMeta: (oldKey, newKey) => invokeValidated('models:bindMeta', { oldKey, newKey }),
    /** 删除模型文件（移入回收站并清理元数据），返回 { ok } 或 { error } */
    deleteModel: (id) => invokeValidated('models:deleteModel', { id }),
    /** 更新快捷标记（收藏/NSFW/评分，仅传需更新的字段），返回 { meta } 或 { error } */
    setMetaFlags: (payload) => invokeValidated('models:setMetaFlags', payload),
    /** 弹出模型右键菜单（原生菜单），动作经 onMenuAction 事件回传 */
    popupMenu: (id) => invokeValidated('models:popupMenu', { id }),
    /** 拖拽导入封面（sourcePath 为外部图片绝对路径），返回 { cover, coverUrl, covers, meta } 或 { error } */
    importCover: (id, sourcePath) => invokeValidated('models:importCover', { id, path: sourcePath }),
    /** 在资源管理器中显示文件 */
    reveal: (path) => invokeValidated('models:reveal', { path }),
    /** 订阅扫描进度，返回取消监听函数 */
    onScanProgress: (listener) => subscribe('models:scanProgress', listener),
    /** 订阅批量哈希进度事件（E5：{ done, total, current }），返回取消监听函数 */
    onHashProgress: (listener) => subscribe('models:hashProgress', listener),
    /** 订阅目录变更事件（E8：{ root }），返回取消监听函数 */
    onFsChanged: (listener) => subscribe('models:fsChanged', listener),
    /** 订阅元数据落盘失败事件（message: 错误信息），返回取消监听函数 */
    onStoreError: (listener) => subscribe('models:storeError', listener),
    /** 订阅后台缩略图生成完成事件（updates: [{ id, coverUrl }]），返回取消监听函数 */
    onThumbsReady: (listener) => subscribe('models:thumbsReady', listener),
    /** 订阅右键菜单动作事件，返回取消监听函数 */
    onMenuAction: (listener) => subscribe('models:menuAction', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
