import { invokeValidated, subscribe } from '../core'

/** 元数据域 api 切片（schema-meta：标注/批量标记/跨库传输/标签管理，models 命名空间） */
export const metaModelApi = {
  /**
   * 保存模型推荐参数与备注
   * @param {{ id: string, alias?: string, note?: string, subCategory?: string,
   *   triggerWords?: string, params?: Object<string, any>|null }} payload
   */
  saveModelData: (payload) => invokeValidated('models:saveModelData', payload),
  /**
   * 记录一次模型打开（F3 使用轨迹）：主进程累加打开次数并写入最近打开
   * 时间，返回 { meta: { lastOpenedAt, openCount } } 或 { error }。
   * @param {string} id 模型绝对路径
   */
  recordModelOpen: (id) => invokeValidated('models:recordModelOpen', { id }),
  /**
   * 更新快捷标记（收藏/NSFW/评分，仅传需更新的字段），返回 { meta } 或 { error }
   * @param {{ id: string, favorite?: boolean, nsfw?: boolean,
   *   rating?: number }} payload
   */
  setMetaFlags: (payload) => invokeValidated('models:setMetaFlags', payload),
  /**
   * 批量更新快捷标记（C1，单次 IPC）：payload 为 { ids, favorite?, nsfw?,
   * rating? }。返回 { updated: [{ id, favorite, nsfw, rating }],
   * failed: [{ id, error }] }，渲染层据此单趟写标注覆盖层并汇总失败项。
   * @param {{ ids: string[], favorite?: boolean, nsfw?: boolean,
   *   rating?: number }} payload
   */
  setMetaFlagsBulk: (payload) =>
    invokeValidated('models:setMetaFlagsBulk', payload),
  /**
   * 整体覆写模型自由标签（F-5，tags 为全量字符串数组），返回 { meta } 或 { error }
   * @param {string} id 模型绝对路径
   * @param {string[]} tags 全量标签数组
   */
  setModelTags: (id, tags) =>
    invokeValidated('models:setModelTags', { id, tags }),
  /**
   * 批量整体覆写自由标签（C1，单次 IPC）：items 为 [{ id, tags }]。
   * 返回 { updated: [{ id, tags }], failed: [{ id, error }] }。
   * @param {Array<{ id: string, tags: string[] }>} items 批量条目
   */
  setModelTagsBulk: (items) =>
    invokeValidated('models:setModelTagsBulk', {
      items,
    }),
  /**
   * 批量推荐参数（F5）：items 为 [{ id, params }]，params 只含需更新的
   * 字段，主进程与各模型已有参数合并；返回 { updated: [{ id, params }],
   * failed: [{ id, error }] }。
   * @param {Array<{ id: string, params: Object<string, any> }>} items 批量条目
   */
  setModelParamsBulk: (items) =>
    invokeValidated('models:setModelParamsBulk', { items }),
  /**
   * 全库重命名自由标签（F4，to 已存在时合并），返回 { changed } 或 { error }
   * @param {string} from 原标签
   * @param {string} to 新标签
   */
  renameTag: (from, to) => invokeValidated('models:renameTag', { from, to }),
  /**
   * 全库移除自由标签（F4），返回 { changed } 或 { error }
   * @param {string} tag 待移除标签
   */
  removeTag: (tag) => invokeValidated('models:removeTag', { tag }),
  /**
   * 弹出模型右键菜单（原生菜单），动作经 onMenuAction 事件回传
   * @param {string} id 模型绝对路径
   */
  popupMenu: (id) => invokeValidated('models:popupMenu', { id }),
  /**
   * 跨库移动/复制模型（F-3）：ids 为当前库内模型路径，targetRoot 为已保存的
   * 其他模型库，mode 为 'copy'|'move'；保持相对路径与元数据关联（封面/标注
   * 随条目迁移），返回 { transferred, mode, targetRoot, failed, skipped }
   * 或 { error }
   * @param {{ ids: string[], targetRoot: string, mode: string,
   *   opId?: string }} payload
   */
  transferToLibrary: (payload) =>
    invokeValidated('models:transferToLibrary', payload),
  /**
   * 订阅右键菜单动作事件，返回取消监听函数
   * @param {(payload: any) => void} listener 事件回调
   */
  onMenuAction: (listener) => subscribe('models:menuAction', listener),
  /**
   * 订阅跨库传输进度事件（OPT-18：{ done, total, bytes, totalBytes, canceled? }）
   * @param {(payload: any) => void} listener 事件回调
   */
  onTransferProgress: (listener) =>
    subscribe('models:transferProgress', listener),
}
