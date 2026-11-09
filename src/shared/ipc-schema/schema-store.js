/** 存储域通道 schema（库切换/详情拉取/总览） */

import { vObj, vStr, vVoid } from './rules'
import { ID } from './constants'

export const STORE_SCHEMAS = {
  'models:loadStore': vVoid(),
  // F1：按路径打开已保存模型库（优先返回本地索引）
  'models:openLibrary': vObj({
    fields: { folder: vStr({ required: true, max: 1000 }) },
  }),
  // OPT-PAYLOAD：单模型详情按需拉取（列表通道瘦身后的补全通道）
  'models:getDetail': vObj({ fields: { id: ID } }),
  'models:chooseFolder': vVoid(),
  // FN-01：跨库存储总览（只读聚合，无渲染层入参）
  'models:crossLibraryOverview': vVoid(),
}
