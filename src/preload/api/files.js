import { invokeValidated } from '../core'

/** 文件操作域 api 切片（schema-files：删除/定位/禁用/整理/取消，models 命名空间） */
export const filesModelApi = {
  /**
   * 删除模型文件（移入回收站并清理元数据），返回 { ok } 或 { error }
   * @param {string} id 模型绝对路径
   */
  deleteModel: (id) => invokeValidated('models:deleteModel', { id }),
  /**
   * 中止一个在途可取消操作（OPT-18；opId 为发起该操作时附带的令牌）
   * @param {string} targetOpId 取消令牌
   */
  cancelOp: (targetOpId) => invokeValidated('models:cancelOp', { targetOpId }),
  /**
   * 在资源管理器中显示文件
   * @param {string} path 文件绝对路径
   */
  reveal: (path) => invokeValidated('models:reveal', { path }),
  /**
   * 加/去 .disabled 后缀（F10），返回 { path } 或 { error }
   * @param {string} id 模型绝对路径
   * @param {boolean} disabled 是否禁用
   */
  toggleDisabled: (id, disabled) =>
    invokeValidated('models:toggleDisabled', { id, disabled }),
  /**
   * 库内移动模型（F11，目标目录经原生对话框选择），同名 sidecar 一并移动
   * （目标同名跳过不覆盖，失败回传警告），
   * 返回 { path, targetRelDir, sidecarWarnings } / { canceled } / { error }
   * @param {string} id 模型绝对路径
   */
  moveModelTo: (id) => invokeValidated('models:moveModelTo', { id }),
  /**
   * 一键移动文件（自动标签整理）：payload 为 { moves: [{ id, subCategory }],
   * opId? }——opId 为 OPT-18 取消令牌（Esc 经 models:cancelOp 中止），整体
   * 透传（与 transferToLibrary 同一约定，由 wrapHandler 在顶层剥离 opId）。
   * 主进程在模型库根目录创建 7 个分类文件夹并移动已分配标签的模型（元数据
   * 键同步迁移，sidecar 目标同名跳过不覆盖、失败回传警告），
   * 返回 { moved, failed: [{id, error}], skipped: [{id, reason}],
   * sidecarWarnings } 或 { canceled } / { error }
   * @param {{ moves: Array<{ id: string, subCategory: string }>,
   *   opId?: string }} payload
   */
  organizeByTags: (payload) =>
    invokeValidated('models:organizeByTags', payload),
}
