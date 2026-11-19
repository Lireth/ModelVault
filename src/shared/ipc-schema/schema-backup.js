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
  // 保存对话框决定，payload 不含路径。字符上限取 10M：UTF-8 编码最坏
  // 3 字节/字符，schema 放行的载荷字节量 ≤30MB，恒低于 handler 的 32MB
  // 字节兜底——「非法 payload 不进入业务代码」在此通道真正前置生效（#90），
  // 32~48MB 的超界载荷在结构门禁即被拒绝，不再空跑结构化克隆。
  'models:exportModelList': vObj({
    fields: {
      format: vStr({ required: true, max: 16 }),
      content: vStr({ required: true, max: 10 * 1024 * 1024 }),
    },
  }),
}
