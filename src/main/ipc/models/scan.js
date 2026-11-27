/**
 * 扫描链路：全量扫描模型目录（进度推送、可取消）、局部增量扫描与取消入口。
 * 并发互斥由 services/maintenance-lock 统一提供（与切库、备份恢复共用一把锁）；
 * scanAbort 仅用于取消当前扫描。
 *
 * 内部按职责拆分（门面保持导入路径 `./scan` 与公共 API 不变）：
 * - scan/shared.js       跨子模块共享的取消控制器状态与共用助手
 * - scan/full-scan.js    models:scan 全量扫描完整 handler
 * - scan/partial-scan.js models:partialScan 局部增量扫描完整 handler
 * - scan/cancel.js       models:cancelScan 取消入口与监控停止广播
 */

import { registerFullScanHandler } from './scan/full-scan'
import { registerCancelHandlers } from './scan/cancel'
import { registerPartialScanHandler } from './scan/partial-scan'

export { resolveScanExtensions } from './scan/shared'
export { setupWatcherStoppedForwarding } from './scan/cancel'

/** 注册扫描链路的 IPC 处理器 */
export function registerScanHandlers() {
  registerFullScanHandler()
  registerCancelHandlers()
  registerPartialScanHandler()
}
