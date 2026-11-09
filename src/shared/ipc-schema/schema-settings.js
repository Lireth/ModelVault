/** 设置域通道 schema（settings:update 字段白名单） */

import { vArr, vBool, vInt, vObj, vStr } from './rules'
import {
  MAX_SAVED_VIEWS,
  MAX_WARMUP_CONCURRENCY,
  MIN_WARMUP_CONCURRENCY,
} from '../app-enums'

export const SETTINGS_SCHEMAS = {
  // O9：字段白名单 + 严格未知字段拒绝（loose:false）。类型/长度在此 fail-fast，
  // 枚举与取值范围仍由 normalizeSettings/handler 负责（文案与既有测试锁定）。
  'settings:update': vObj({
    max: 40,
    loose: false,
    fields: {
      modelsFolder: vStr({ max: 1000 }),
      modelsFolders: vArr({ max: 20, items: vStr({ max: 1000 }) }),
      autoScan: vBool(),
      excludeDirs: vArr({ max: 100, items: vStr({ max: 100 }) }),
      theme: vStr({ max: 16 }),
      accentColor: vStr({ max: 32 }),
      cardSize: vStr({ max: 16 }),
      viewMode: vStr({ max: 16 }),
      sortBy: vStr({ max: 16 }),
      sortAsc: vBool(),
      scanExtensions: vArr({ max: 20, items: vStr({ max: 16 }) }),
      showSize: vBool(),
      showMtime: vBool(),
      showParams: vBool(),
      civitaiEnabled: vBool(),
      // NSFW 模糊样式：off/blur/heavy（枚举收口在 normalizeSettings）
      nsfwBlur: vStr({ max: 16 }),
      // 隐藏 NSFW 模型开关
      hideNsfwModels: vBool(),
      autoRescan: vBool(),
      autoCheckUpdate: vBool(),
      hashWarmup: vStr({ max: 16 }),
      // 哈希预热并发数（OPT-3）：整数区间单一来源 shared/app-enums
      hashWarmupConcurrency: vInt({
        min: MIN_WARMUP_CONCURRENCY,
        max: MAX_WARMUP_CONCURRENCY,
      }),
      autoBackup: vBool(),
      // 智能视图：字段与 store-settings.normalizeSavedViews 对齐；
      // 文案/枚举回退仍在 normalize（这里只挡类型与未知字段）
      savedViews: vArr({
        max: MAX_SAVED_VIEWS,
        items: vObj({
          max: 16,
          loose: false,
          fields: {
            id: vStr({ max: 40 }),
            name: vStr({ max: 30 }),
            search: vStr({ max: 1000 }),
            typeFilter: vStr({ max: 64 }),
            subFilter: vStr({ max: 128 }),
            baseFilter: vStr({ max: 64 }),
            // 自由标签筛选（FEAT-01）：数组（多标签 AND）；旧 tagFilter 单字符串
            // 字段保留兼容历史设置，主进程 normalize 会迁移为 tagFilters
            tagFilters: vArr({ max: 20, items: vStr({ max: 32 }) }),
            tagFilter: vStr({ max: 32 }),
            showFavoritesOnly: vBool(),
            showDuplicatesOnly: vBool(),
            showSuspectOnly: vBool(),
            sortBy: vStr({ max: 16 }),
            sortAsc: vBool(),
          },
        }),
      }),
    },
  }),
}
