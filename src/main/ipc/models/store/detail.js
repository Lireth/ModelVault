/**
 * models:getDetail —— 单模型详情按需拉取（列表通道瘦身后的补全通道）。
 */

import { wrapHandler, checkModelIdInRoot } from '../../handler'
import { decorateCache } from '../model-state'
import { readFullModelFromIndex, buildDetailModel } from './list-view'

/** 注册详情拉取通道 */
export function registerDetailHandlers() {
  // OPT-PAYLOAD：单模型详情按需拉取（列表通道瘦身后的补全通道）。
  // 数据源优先装饰缓存（扫描后全库热），未命中回退本地索引全文；返回前以
  // 当前 store-meta 覆盖标注字段并按 meta 重建封面列表，保证与「封面/标注
  // 操作即时生效」的既有语义一致（装饰缓存快照要等下一次扫描才刷新）。
  wrapHandler(
    'models:getDetail',
    async (event, { id } = {}) => {
      const invalid = checkModelIdInRoot(id)
      if (invalid) return { error: invalid }
      const entry = decorateCache.get(id)
      const base =
        (entry && entry.decorated) || (await readFullModelFromIndex(id))
      if (!base) {
        return { error: '模型不在当前库索引中，请重新扫描后重试' }
      }
      return { model: buildDetailModel(base) }
    },
    { errorPrefix: '加载模型详情失败' },
  )
}
