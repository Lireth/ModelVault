/** 应用域通道 schema（ipc.js 经 wrapHandler 统一注册） */

import { vObj, vStr, vVoid } from './rules'

export const APP_SCHEMAS = {
  // 无 payload 通道：vVoid 门禁，渲染进程传参即拒绝
  'app:getInfo': vVoid(),
  // 渲染进程异常上报：handler 自带归一化截断，schema 仅宽松结构门禁
  // （字段可选；上限取 handler 截断点 2000/4000 的 2 倍，超限输入仍由
  // handler 截断落盘而非报错）
  'app:reportError': vObj({
    fields: {
      message: vStr({ max: 4000 }),
      stack: vStr({ max: 8000 }),
    },
  }),
  'app:checkUpdate': vVoid(),
  // F-6：URL 由主进程检查更新链路提供，渲染层不传任何参数
  'app:downloadUpdate': vVoid(),
  'app:cancelUpdateDownload': vVoid(),
  'app:installUpdate': vVoid(),
  'app:openLogs': vVoid(),
  // FN-05：诊断包导出（报告 + 最近日志 → zip），范围与内容固定，无渲染层入参
  'app:exportDiagnostics': vVoid(),
  'window:setTheme': vObj({
    fields: { theme: vStr({ required: true, max: 32 }) },
  }),
}
