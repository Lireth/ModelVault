/** 备份与导出域通道 schema（zip 备份、模型清单导出） */

import { vArr, vObj, vStr, vVoid } from './rules'

export const BACKUP_SCHEMAS = {
  // FN-08：备份模式 full/selected/metadata；selected 携带当前筛选的模型 id
  'models:exportBackup': vObj({
    fields: {
      mode: vStr({ max: 16 }),
      ids: vArr({ max: 20000, items: vStr({ max: 2000 }) }),
    },
  }),
  'models:importBackup': vVoid(),
  // FN-04：当前筛选结果的清单文本（csv/markdown/json）；路径由主进程
  // 保存对话框决定，payload 不含路径。字符上限按最大 16M 控制克隆开销。
  'models:exportModelList': vObj({
    fields: {
      format: vStr({ required: true, max: 16 }),
      content: vStr({ required: true, max: 16 * 1024 * 1024 }),
    },
  }),
}
