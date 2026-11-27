import { ipcRenderer } from 'electron'
import { IPC_PAYLOAD_SCHEMAS, IPC_EVENT_CHANNELS } from '../shared/ipc-schema'
import { attachIpcErrorCode } from '../shared/error-codes'

/**
 * IPC 白名单校验原语（O5 自 index.js 拆出）：全部域 api 文件的 invoke/subscribe
 * 统一经本模块入口，新增通道必须先在 shared/ipc-schema/ 注册表登记。
 * O2 单一来源：invoke 白名单由 schema 注册表键集派生，事件白名单由
 * IPC_EVENT_CHANNELS 派生，均不再独立维护；与主进程注册点的一致性由
 * tests/ipcSchema.test.js 双向对账锁定。
 */

/** invoke 通道白名单：渲染进程只能经以下通道通信，防止任意通道调用 */
const VALID_INVOKE_CHANNELS = new Set(Object.keys(IPC_PAYLOAD_SCHEMAS))

/** 事件通道订阅白名单（O9 单一来源派生） */
const VALID_RECEIVE_CHANNELS = new Set(IPC_EVENT_CHANNELS)

/**
 * 带白名单校验的 invoke（所有便捷方法的统一入口）。
 * C3：返回结果在 preload 边界补齐稳定错误码（{ error } / { canceled }
 * 均带 code），error 文案与既有响应形状保持不变；渲染层可按 code 做
 * 离线/繁忙/冲突等分支，不再依赖文案匹配。
 * @param {string} channel IPC 通道
 * @param {any} [payload] 载荷
 * @returns {Promise<any>} 主进程结果（错误响应已附加 code）
 */
export function invokeValidated(channel, payload) {
  // 白名单外通道保持同步抛错（fail-closed 的调用点语义不变）
  if (!VALID_INVOKE_CHANNELS.has(channel)) {
    throw new Error(`不允许的 IPC 通道: ${channel}`)
  }
  return ipcRenderer
    .invoke(channel, payload)
    .then((result) => attachIpcErrorCode(result))
}

/**
 * 带白名单校验的事件订阅，返回取消监听函数
 * @param {string} channel 事件通道
 * @param {(payload: any) => void} listener 事件回调
 * @returns {() => void} 取消监听函数
 */
export function subscribe(channel, listener) {
  if (!VALID_RECEIVE_CHANNELS.has(channel)) {
    throw new Error(`不允许的 IPC 通道: ${channel}`)
  }
  /**
   * @param {import('electron').IpcRendererEvent} _event IPC 事件对象
   * @param {any} data 事件载荷
   */
  const handler = (_event, data) => listener(data)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}
