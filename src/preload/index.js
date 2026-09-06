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
  'dialog:info'
]

const VALID_RECEIVE_CHANNELS = ['message:reply']

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
    close: () => ipcRenderer.invoke('window:close')
  },

  /** 原生对话框 */
  dialog: {
    info: (options) => ipcRenderer.invoke('dialog:info', options)
  }
}

contextBridge.exposeInMainWorld('api', api)
