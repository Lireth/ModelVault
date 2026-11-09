/** 元数据域通道 schema（标注/批量标记/跨库传输/标签管理） */

import { vArr, vBool, vInt, vObj, vStr } from './rules'
import { ID, MAX_TRANSFER_IDS } from './constants'
import { MAX_BATCH_META_IDS } from '../app-enums'

export const META_SCHEMAS = {
  'models:saveModelData': vObj({
    fields: {
      id: ID,
      // 上限与 normalizeModelMeta 截断点（100/2000/1000）对齐并留余量
      alias: vStr({ max: 200 }),
      note: vStr({ max: 20000 }),
      subCategory: vStr({ max: 64 }),
      triggerWords: vStr({ max: 4000 }),
      // params 允许显式 null（清空语义）；字段级数值/字符串规范化在 store-meta
      params: vObj({ max: 30, nullable: true }),
    },
  }),
  // O9：类型在 schema fail-fast；取值范围（rating 0-5）与空更新语义仍由
  // handler 产出专属文案（既有测试锁定）
  'models:setMetaFlags': vObj({
    fields: {
      id: ID,
      favorite: vBool(),
      nsfw: vBool(),
      rating: vInt(),
    },
  }),
  // C1：批量快捷标记（收藏/NSFW/评分）单次 IPC。ids 上限与渲染层分块共用
  // shared/app-enums.MAX_BATCH_META_IDS；字段语义与单模型通道一致，空更新
  // 由 handler 产出专属文案。
  'models:setMetaFlagsBulk': vObj({
    max: 8,
    fields: {
      ids: vArr({
        required: true,
        max: MAX_BATCH_META_IDS,
        items: vStr({ max: 2000 }),
      }),
      favorite: vBool(),
      nsfw: vBool(),
      rating: vInt(),
    },
  }),
  'models:popupMenu': vObj({ fields: { id: ID } }),
  // F-3 跨库传输：ids 为当前库内模型路径；targetRoot 必须是已保存的其他
  // 模型库（handler 校验 ∈ settings.modelsFolders 且 ≠ 当前根）；mode 枚举
  // 语义在 handler（copy/move）
  'models:transferToLibrary': vObj({
    max: 20,
    fields: {
      ids: vArr({
        required: true,
        max: MAX_TRANSFER_IDS,
        items: vStr({ max: 1000 }),
      }),
      targetRoot: vStr({ required: true, max: 1000 }),
      mode: vStr({ required: true, max: 8 }),
    },
  }),
  // 自由标签（F-5）：整体覆写语义；逐项去重/截断规范化在 store-meta
  'models:setModelTags': vObj({
    fields: {
      id: ID,
      tags: vArr({ required: true, max: 20, items: vStr({ max: 32 }) }),
    },
  }),
  // C1：批量自由标签整体覆写。items 由渲染层在执行时基于最新标签计算，
  // 主进程逐项做归属校验与规范化后单次落盘；上限与批量标记共用。
  'models:setModelTagsBulk': vObj({
    max: 4,
    fields: {
      items: vArr({
        required: true,
        max: MAX_BATCH_META_IDS,
        items: vObj({
          max: 4,
          fields: {
            id: ID,
            tags: vArr({
              required: true,
              max: 20,
              items: vStr({ max: 32 }),
            }),
          },
        }),
      }),
    },
  }),
  // 全库标签管理（F4）：重命名/合并与移除；长度上限与 normalizeTags 截断一致
  'models:renameTag': vObj({
    fields: {
      from: vStr({ required: true, max: 32 }),
      to: vStr({ required: true, max: 32 }),
    },
  }),
  'models:removeTag': vObj({
    fields: { tag: vStr({ required: true, max: 32 }) },
  }),
}
