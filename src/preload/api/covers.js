import { invokeValidated, subscribe } from '../core'

/** 封面域 api 切片（schema-covers：上传/粘贴/默认封面/清理/体检，models 命名空间） */
export const coversModelApi = {
  /**
   * 上传模型封面，返回 { cover, coverUrl, covers, meta } 或 { canceled } / { error }
   * @param {string} id 模型绝对路径
   */
  uploadCover: (id) => invokeValidated('models:uploadCover', { id }),
  /**
   * 将剪贴板图片添加为模型预览图，返回 { cover, coverUrl, covers, meta } 或 { error }
   * @param {string} id 模型绝对路径
   */
  pasteCover: (id) => invokeValidated('models:pasteCover', { id }),
  /**
   * 设置默认封面（cover 为封面相对路径），返回 { cover, coverUrl, covers, meta } 或 { error }
   * @param {string} id 模型绝对路径
   * @param {string} cover 封面相对路径
   */
  setDefaultCover: (id, cover) =>
    invokeValidated('models:setDefaultCover', { id, cover }),
  /**
   * 删除单张封面（cover 为封面相对路径），返回 { cover, coverUrl, covers, meta } 或 { error }
   * @param {string} id 模型绝对路径
   * @param {string} cover 封面相对路径
   */
  deleteCover: (id, cover) =>
    invokeValidated('models:deleteCover', { id, cover }),
  /**
   * 一键移除全部示例图（清空封面列表并删除物理文件），返回 { cover, coverUrl, covers, meta } 或 { error }
   * @param {string} id 模型绝对路径
   */
  clearCovers: (id) => invokeValidated('models:clearCovers', { id }),
  /** 一键清空当前库全部模型的示例图（设置页数据清理），返回 { cleared, images } 或 { error } */
  clearAllCovers: () => invokeValidated('models:clearAllCovers'),
  /**
   * 模型库体检（V-07）：检查缺失模型文件/失效封面引用/孤儿封面/重复哈希，
   * 返回 { report } 或 { error }；只读，不修改任何数据
   */
  checkHealth: () => invokeValidated('models:checkHealth'),
  /**
   * 一键修复（V-07）：移除缺失文件的元数据、清理失效封面引用、
   * 孤儿封面移入 .modelvault/trash；修复前备份 store.json。
   * 返回 { report, repaired, backupPath, dataResetSkipped? } 或 { error }
   */
  repairHealth: () => invokeValidated('models:repairHealth'),
  /**
   * 拖拽导入封面（sourcePath 为外部图片绝对路径），返回 { cover, coverUrl, covers, meta } 或 { error }
   * @param {string} id 模型绝对路径
   * @param {string} sourcePath 外部图片绝对路径
   */
  importCover: (id, sourcePath) =>
    invokeValidated('models:importCover', { id, path: sourcePath }),
  /** 订阅后台缩略图生成完成事件（updates: [{ id, coverUrl?, coverThumb? }]，
   * coverThumb 为轮播封面条目缩略图更新 { path, thumbUrl }），返回取消监听函数
   * @param {(payload: any) => void} listener 事件回调
   */
  onThumbsReady: (listener) => subscribe('models:thumbsReady', listener),
}
