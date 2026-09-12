import { contextBridge, ipcRenderer, webUtils } from 'electron'

/**
 * IPC 通道白名单：渲染进程只能通过以下通道通信，防止任意通道调用。
 * 所有 invoke 均经过白名单校验（统一入口，新增通道必须先在此注册）。
 */
const VALID_INVOKE_CHANNELS = [
  'app:getInfo',
  'app:reportError',
  'window:setTheme',
  'settings:update',
  'models:loadStore',
  'models:chooseFolder',
  'models:scan',
  'models:saveModelData',
  'models:uploadCover',
  'models:pasteCover',
  'models:setDefaultCover',
  'models:deleteCover',
  'models:civitaiMatch',
  'models:deleteModel',
  'models:renameModel',
  'models:setMetaFlags',
  'models:popupMenu',
  'models:importCover',
  'models:reveal',
  'models:flushStore'
]

const VALID_RECEIVE_CHANNELS = ['models:scanProgress', 'models:menuAction']

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
    reportError: (message, stack) => invokeValidated('app:reportError', { message, stack })
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
    /** 扫描模型目录，返回 { models, byType, errors } 或 { error } */
    scan: (folder) => invokeValidated('models:scan', { folder }),
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
    /** Civitai 匹配：返回 { matched, hash, info } 或 { error }（大文件哈希耗时较长） */
    civitaiMatch: (id) => invokeValidated('models:civitaiMatch', { id }),
    /** 删除模型文件（移入回收站并清理元数据），返回 { ok } 或 { error } */
    deleteModel: (id) => invokeValidated('models:deleteModel', { id }),
    /** 重命名模型文件（联动元数据与 sidecar），返回 { ok, id, name } 或 { error } */
    renameModel: (id, newName) => invokeValidated('models:renameModel', { id, newName }),
    /** 更新快捷标记（收藏/评分/标签，仅传需更新的字段），返回 { meta } 或 { error } */
    setMetaFlags: (payload) => invokeValidated('models:setMetaFlags', payload),
    /** 弹出模型右键菜单（原生菜单），动作经 onMenuAction 事件回传 */
    popupMenu: (id) => invokeValidated('models:popupMenu', { id }),
    /** 拖拽导入封面（sourcePath 为外部图片绝对路径），返回 { cover, coverUrl, covers, meta } 或 { error } */
    importCover: (id, sourcePath) => invokeValidated('models:importCover', { id, path: sourcePath }),
    /** 在资源管理器中显示文件 */
    reveal: (path) => invokeValidated('models:reveal', { path }),
    /** 立即落盘 */
    flushStore: () => invokeValidated('models:flushStore'),
    /** 订阅扫描进度，返回取消监听函数 */
    onScanProgress: (listener) => subscribe('models:scanProgress', listener),
    /** 订阅右键菜单动作事件，返回取消监听函数 */
    onMenuAction: (listener) => subscribe('models:menuAction', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
