/** 封面域通道 schema（上传/粘贴/默认封面/清理/体检） */

import { vObj, vStr, vVoid } from './rules'
import { ID } from './constants'

export const COVER_SCHEMAS = {
  'models:uploadCover': vObj({ fields: { id: ID } }),
  'models:pasteCover': vObj({ fields: { id: ID } }),
  'models:setDefaultCover': vObj({
    fields: { id: ID, cover: vStr({ max: 1000 }) },
  }),
  'models:deleteCover': vObj({
    fields: { id: ID, cover: vStr({ max: 1000 }) },
  }),
  'models:clearCovers': vObj({ fields: { id: ID } }),
  'models:clearAllCovers': vVoid(), // 无 payload，清空范围以当前库为界
  // 模型库体检与一键修复（V-07）：范围固定为当前库，无渲染层入参
  'models:checkHealth': vVoid(),
  'models:repairHealth': vVoid(),
  'models:importCover': vObj({
    fields: { id: ID, path: vStr({ max: 2000 }) },
  }),
}
