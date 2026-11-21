/** 文件操作域通道 schema（删除/定位/禁用/整理/取消） */

import { vArr, vBool, vObj, vStr } from './rules'
import { ID, MAX_ORGANIZE_MOVES } from './constants'

export const FILES_SCHEMAS = {
  'models:deleteModel': vObj({ fields: { id: ID } }),
  'models:reveal': vObj({
    fields: { path: vStr({ max: 2000 }) },
  }),
  // OPT-18 opId 取消机制：中止一个在途可取消操作（opId 为渲染层生成并随载荷附带的令牌）
  'models:cancelOp': vObj({
    // 字段名用 targetOpId：载荷内名为 opId 的字段会被 wrapHandler 的取消
    // 协议剥离（本通道的载荷本身就是令牌，须绕开剥离约定，零特判）
    fields: { targetOpId: vStr({ required: true, max: 128 }) },
  }),
  'models:toggleDisabled': vObj({
    fields: { id: ID, disabled: vBool() },
  }),
  'models:moveModelTo': vObj({ fields: { id: ID } }),
  'models:organizeByTags': vObj({
    fields: {
      moves: vArr({
        max: MAX_ORGANIZE_MOVES,
        // 条目宽松：缺 id/非法标签的条目由 handler 逐项跳过（批量语义）
        items: vObj({
          max: 8,
          fields: { id: vStr({ max: 2000 }), subCategory: vStr({ max: 64 }) },
        }),
      }),
    },
  }),
}
