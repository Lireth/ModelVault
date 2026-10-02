import { setupStoreErrorForwarding, registerStoreHandlers } from './store'
import { registerScanHandlers } from './scan'
import { registerMetaHandlers } from './meta'
import { registerCoverHandlers } from './covers'
import { registerMiscHandlers } from './misc'

/**
 * models 域 IPC 处理器聚合入口（对外签名与行为不变）。
 * 通道命名统一使用 models: / settings: / window: 前缀，需与 preload 白名单保持一致。
 * 元数据与封面采用「关联存储」：保存在模型根目录的 .modelvault/ 下。
 */

/** 注册 models 域全部 IPC 处理器 */
export function registerModelIpcHandlers() {
  // 元数据落盘失败广播（B1）必须最先注册：任何 handler 触发保存前监听须已就位
  setupStoreErrorForwarding()
  registerStoreHandlers()
  registerScanHandlers()
  registerMetaHandlers()
  registerCoverHandlers()
  registerMiscHandlers()
}
