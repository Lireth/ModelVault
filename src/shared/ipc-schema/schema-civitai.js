/** Civitai 域通道 schema（识别/补全/示例图导入/哈希预热） */

import { vArr, vObj, vStr } from './rules'
import { ID } from './constants'
import { MAX_IMPORT_IMAGES } from '../app-enums'

export const CIVITAI_SCHEMAS = {
  'models:civitaiIdentify': vObj({ fields: { id: ID } }),
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
