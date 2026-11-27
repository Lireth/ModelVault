/**
 * 扫描链路取消入口与目录监控停止广播。
 * - models:cancelScan        取消进行中的扫描（经 AbortController 中止）
 * - setupWatcherStoppedForwarding  OPT-16 目录监控停止跨窗口广播
 */

import { BrowserWindow } from 'electron'
import logger from '../../../logger'
import { getMaintenanceState } from '../../../services/maintenance-lock'
import { setWatcherStoppedListener } from '../../../services/watcher'
import { wrapHandler } from '../../handler'
import { scanState } from './shared'

/**
 * 注册目录监控停止的跨窗口广播（OPT-16 状态可见化，副作用注册模式与
 * setupStoreErrorForwarding 一致）：连续巡检异常超限后监控停止——此前
 * autoRescan 静默失效、用户完全无感知（「功能悄悄坏了」类缺陷），现经
 * models:watcherStopped 事件告知渲染层（toast 提示，恢复后可手动扫描
 * 重新启用）。
 * 副作用注册：仅可由 registerModelIpcHandlers 调用时触发，严禁漂移到模块 import 时。
 */
export function setupWatcherStoppedForwarding() {
  setWatcherStoppedListener(({ root, reason }) => {
    logger.warn(`目录监控已停止并通知渲染层: ${root}（${reason}）`)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('models:watcherStopped', { root, reason })
      }
    }
  })
}

/** 注册扫描取消通道的 IPC 处理器 */
export function registerCancelHandlers() {
  // 取消进行中的扫描（经 AbortController 中止，扫描返回 { canceled: true }）
  wrapHandler('models:cancelScan', () => {
    const maintenance = getMaintenanceState()
    const cancelable =
      maintenance &&
      (maintenance.kind === 'scan' || maintenance.kind === 'partial-scan')
    if (cancelable && scanState.controller) {
      scanState.controller.abort()
      return { ok: true }
    }
    return { ok: false }
  })
}
