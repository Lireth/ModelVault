/** Civitai 域通道 schema（识别/补全/示例图导入/哈希预热） */

import { vArr, vBool, vObj, vStr } from './rules'
import { ID } from './constants'
import { MAX_IMPORT_IMAGES } from '../app-enums'

export const CIVITAI_SCHEMAS = {
  // FEAT-9：fillMissing=true 时识别成功后顺带补全空缺触发词/备注
  // （复用同一次反查结果，不再二次请求 Civitai）
  'models:civitaiIdentify': vObj({
    fields: { id: ID, fillMissing: vBool() },
  }),
  'models:civitaiCategory': vObj({ fields: { id: ID } }),
  'models:civitaiComplete': vObj({ fields: { id: ID } }),
  'models:civitaiImportImages': vObj({
    fields: {
      id: ID,
      // 数量上限与 handler 共用 shared 常量；URL 域名白名单在
      // downloadCivitaiImage 内校验，此处只查类型与长度
      images: vArr({
        max: MAX_IMPORT_IMAGES,
        items: vObj({ max: 4, fields: { url: vStr({ max: 2000 }) } }),
      }),
    },
  }),
  'models:warmupHash': vObj({ fields: { id: ID } }),
}
