/**
 * IPC 契约共享常量（O-2 自 ipc-schema.js 按域拆出）：
 * 事件通道清单、跨层业务上限与共用字段规则片段——域 schema 文件、
 * 聚合门面与主进程 handler 共用，保持单一来源。
 */

import { vStr } from './rules'

/**
 * 主进程 → 渲染进程事件通道（O9 单一来源）：
 * preload 的订阅白名单与主进程发送点共用此清单；新增事件通道只改这里，
 * 由 tests/ipcSchema.test.js 对账 preload 的 subscribe 调用点防止漂移。
 */
export const IPC_EVENT_CHANNELS = Object.freeze([
  'app:updateProgress',
  'app:updateAvailable',
  'models:scanProgress',
  'models:menuAction',
  'models:thumbsReady',
  'models:storeError',
  'models:fsChanged',
  'models:warmupProgress',
  'models:watcherStopped',
  'models:transferProgress',
  'models:importProgress',
])

/**
 * 业务上限常量（OPT-13 单一来源）：schema 声明与 handler 内语义校验共用，
 * 此前两侧各写一份魔数（500/10000），调限时只改一侧即出现
 * 「schema 拒绝但文案不同」或 handler 死代码。
 */
/** 跨库传输单批模型数上限 */
export const MAX_TRANSFER_IDS = 500
/** 按标签整理单批移动数上限 */
export const MAX_ORGANIZE_MOVES = 10000

/** 模型 id（绝对路径）：只查类型与长度上限；空串语义文案由 handler 产出 */
export const ID = vStr({ required: true, max: 2000 })
