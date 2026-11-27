import { contextBridge } from 'electron'
import { appApi } from './api/app'
import { settingsApi } from './api/settings'
import { storeModelApi } from './api/store'
import { scanModelApi } from './api/scan'
import { metaModelApi } from './api/meta'
import { coversModelApi } from './api/covers'
import { filesModelApi } from './api/files'
import { backupModelApi } from './api/backup'
import { civitaiModelApi } from './api/civitai'

/**
 * 预加载入口（O5 按域拆分，对齐 shared/ipc-schema/ 的域边界）：
 * 白名单校验原语在 core.js，各域便捷方法在 api/ 下按域文件维护，
 * 本文件仅装配 api 面并经 contextBridge 暴露——渲染进程对外形状
 * （window.api.app / window / settings / models）保持不变。
 * 新增通道：先在 shared/ipc-schema/ 对应域文件登记，再到 api/ 同名
 * 域文件补方法；invoke/subscribe 调用点与注册表的双向对账由
 * tests/ipcSchema.test.js（递归扫描本目录）与 tests/preload.test.js
 * （活体逐方法）锁定。
 */
const api = {
  ...appApi,
  settings: settingsApi,
  models: {
    ...storeModelApi,
    ...scanModelApi,
    ...metaModelApi,
    ...coversModelApi,
    ...filesModelApi,
    ...backupModelApi,
    ...civitaiModelApi,
  },
}

/** 通过 contextBridge 向渲染进程暴露安全的 API。 */
contextBridge.exposeInMainWorld('api', api)

// 导出 api 供类型层引用（OPT-08）：src/renderer/src/store/api.d.ts 经
// typeof import 结构性派生 window.api 类型——方法增删即同步反映到渲染层
// 调用点的类型检查。不改变运行时行为（bundle 仍仅经 contextBridge 暴露）。
export { api }
