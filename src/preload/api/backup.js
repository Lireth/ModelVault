import { invokeValidated } from '../core'

/** 备份与导出域 api 切片（schema-backup：zip 备份、模型清单导出，models 命名空间） */
export const backupModelApi = {
  /**
   * 导出模型清单（FN-04）：渲染层按当前筛选结果生成 csv/markdown/json 文本，
   * 主进程弹保存对话框并原子写入；返回 { ok, path, sizeBytes } / { canceled } / { error }
   * @param {{ format: string, content: string }} payload 清单格式与文本内容
   */
  exportModelList: (payload) =>
    invokeValidated('models:exportModelList', payload),
  /**
   * 导出备份（FEAT-3/FN-08）：设置 + 当前库标注/封面 → zip。
   * options: { mode: 'full'|'selected'|'metadata', ids?: string[] }；
   * 返回 { path, sizeBytes, library, models, covers, mode, partial } / { canceled } / { error }
   * @param {{ mode: string, ids?: string[] }} options 导出选项
   */
  exportBackup: (options) => invokeValidated('models:exportBackup', options),
  /** 从备份恢复（FEAT-3）：zip → 设置 + 指定库，返回 { settingsRestored, libraryRestored? } / { canceled } / { error } */
  importBackup: () => invokeValidated('models:importBackup'),
}
