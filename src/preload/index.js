import { contextBridge, ipcRenderer } from 'electron'

/**
 * IPC 通道白名单：渲染进程只能通过以下通道通信，防止任意通道调用。
 */
const VALID_SEND_CHANNELS = ['message:send']

const VALID_INVOKE_CHANNELS = [
  'app:getInfo',
  'window:minimize',
  'window:toggleMaximize',
  'window:close',
  'window:setTheme',
  'dialog:info',
  'settings:update',
  'models:loadStore',
  'models:chooseFolder',
  'models:scan',
  'models:saveModelData',
  'models:uploadCover',
  'models:reveal',
  'models:flushStore'
]

const VALID_RECEIVE_CHANNELS = ['message:reply', 'models:scanProgress']

/**
 * 通过 contextBridge 向渲染进程暴露安全的 API。
 * 渲染进程无 Node 能力，只能使用此处显式暴露的接口。
 */
const api = {
  /** invoke 型通信（带返回值） */
  invoke(channel, payload) {
    if (!VALID_INVOKE_CHANNELS.includes(channel)) {
      throw new Error(`不允许的 IPC 通道: ${channel}`)
    }
    return ipcRenderer.invoke(channel, payload)
  },

  /** 单向发送消息 */
  send(channel, payload) {
    if (!VALID_SEND_CHANNELS.includes(channel)) {
      throw new Error(`不允许的 IPC 通道: ${channel}`)
    }
    ipcRenderer.send(channel, payload)
  },

  /** 监听主进程消息，返回取消监听函数 */
  on(channel, listener) {
    if (!VALID_RECEIVE_CHANNELS.includes(channel)) {
      throw new Error(`不允许的 IPC 通道: ${channel}`)
    }
    const handler = (_event, data) => listener(data)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },

  /** 应用信息 */
  app: {
    getInfo: () => ipcRenderer.invoke('app:getInfo')
  },

  /** 窗口控制 */
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    /** 切换主题（同步原生标题栏颜色） */
    setTheme: (theme) => ipcRenderer.invoke('window:setTheme', { theme })
  },

  /** 应用设置 */
  settings: {
    /** 更新设置，返回 { settings }（规范化后的完整设置） */
    update: (patch) => ipcRenderer.invoke('settings:update', patch)
  },

  /** 原生对话框 */
  dialog: {
    info: (options) => ipcRenderer.invoke('dialog:info', options)
  },

  /** 模型管理 */
  models: {
    /** 加载持久化数据（设置 + 模型元数据） */
    loadStore: () => ipcRenderer.invoke('models:loadStore'),
    /** 弹出目录选择框，返回所选目录或 null */
    chooseFolder: () => ipcRenderer.invoke('models:chooseFolder'),
    /** 扫描模型目录，返回 { models, byType, errors } 或 { error } */
    scan: (folder) => ipcRenderer.invoke('models:scan', { folder }),
    /** 保存模型推荐参数与备注 */
    saveModelData: (payload) => ipcRenderer.invoke('models:saveModelData', payload),
    /** 上传模型封面，返回 { cover, coverUrl, meta } 或 { canceled } / { error } */
    uploadCover: (id) => ipcRenderer.invoke('models:uploadCover', { id }),
    /** 在资源管理器中显示文件 */
    reveal: (path) => ipcRenderer.invoke('models:reveal', { path }),
    /** 立即落盘 */
    flushStore: () => ipcRenderer.invoke('models:flushStore'),
    /** 订阅扫描进度，返回取消监听函数 */
    onScanProgress: (listener) => api.on('models:scanProgress', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
