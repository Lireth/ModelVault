/** 扫描域通道 schema（全量/局部扫描、取消、导入入台） */

import { vArr, vObj, vStr, vVoid } from './rules'
import { MAX_IMPORT_PATHS } from '../app-enums'
import { MAX_PARTIAL_SCAN_DIRS_INPUT } from '../scan-dirs'

export const SCAN_SCHEMAS = {
  'models:scan': vObj({
    fields: { folder: vStr({ max: 1000 }) },
  }),
  'models:partialScan': vObj({
    fields: {
      folder: vStr({ max: 1000 }),
      // 子树语义校验（逃逸段/反斜杠）与超限收敛在 handler（shared/scan-dirs）；
      // 此处只设防御性硬上限，避免超大 payload 进入结构化克隆
      dirs: vArr({
        max: MAX_PARTIAL_SCAN_DIRS_INPUT,
        items: vStr({ max: 1000 }),
      }),
    },
  }),
  'models:cancelScan': vVoid(),
  // F2：外部模型导入（复制/移动入台），mode 枚举语义在 handler
  // F-4：paths 为拖拽导入的来源文件路径——提供时跳过原生来源选择框，
  // 仍由 handler 做扩展名/普通文件/库内路径等语义校验
  'models:importModels': vObj({
    fields: {
      mode: vStr({ required: true, max: 16 }),
      paths: vArr({ max: MAX_IMPORT_PATHS, items: vStr({ max: 4096 }) }),
    },
  }),
}
