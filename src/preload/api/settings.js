import { invokeValidated } from '../core'

/** 设置域 api 切片（schema-settings：settings:update 字段白名单） */
export const settingsApi = {
  /**
   * 更新设置，返回 { settings }（规范化后的完整设置）
   * @param {Record<string, any>} patch 设置增量（字段白名单见 schema）
   */
  update: (patch) => invokeValidated('settings:update', patch),
}
