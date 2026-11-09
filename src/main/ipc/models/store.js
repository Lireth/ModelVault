/**
 * 存储与设置链路（门面）：分层后保持导入路径 `./store` 与公共 API 不变。
 *
 * 内部按职责拆分（依赖单向，session/list-view 不注册通道）：
 * - store/session.js   库会话编排：ensureRootStore 切换关联存储，库根存在性快照
 * - store/list-view.js 列表展示字段覆盖与详情按需组装
 * - store/load.js      models:loadStore（设置 + 本地索引 + 预热/监控联动）
 * - store/library.js   models:openLibrary / chooseFolder / crossLibraryOverview
 * - store/detail.js    models:getDetail
 * - store/settings.js  settings:update（库根白名单校验）
 */

import { BrowserWindow } from 'electron'
import { errorMessage } from '../../../shared/error-text'
import { setStoreSaveErrorListener } from '../../services/store'
import { registerLoadHandlers } from './store/load'
import { registerLibraryHandlers } from './store/library'
import { registerDetailHandlers } from './store/detail'
import { registerSettingsHandlers } from './store/settings'

export { ensureRootStore } from './store/session'

/**
 * 注册元数据落盘失败的跨窗口广播（B1）。
 * 防抖落盘在 IPC 响应之后异步发生，渲染进程已收到成功返回，
 * 必须经事件通知，否则用户标注会静默丢失。
 * 副作用注册：仅可由 registerModelIpcHandlers 调用时触发，严禁漂移到模块 import 时。
 */
export function setupStoreErrorForwarding() {
  setStoreSaveErrorListener((err) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('models:storeError', {
          message: errorMessage(err),
        })
      }
    }
  })
}

/** 注册存储与设置链路的 IPC 处理器 */
export function registerStoreHandlers() {
  registerLoadHandlers()
  registerLibraryHandlers()
  registerDetailHandlers()
  registerSettingsHandlers()
}
