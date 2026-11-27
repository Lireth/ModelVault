import { invokeValidated, subscribe } from '../core'

/** 存储域 api 切片（schema-store：库切换/详情拉取/总览，models 命名空间） */
export const storeModelApi = {
  /** 加载持久化数据（设置 + 本地索引缓存；模型元数据不出主进程） */
  loadStore: () => invokeValidated('models:loadStore'),
  /**
   * 打开已保存模型库（F1：优先返回本地索引，实现秒切库）
   * @param {string} folder 模型库根目录
   * @returns {Promise<{root:string, settings:object, cached:boolean,
   *   models?:object[], savedAt?:number, durationMs?:number} | {error:string}>}
   */
  openLibrary: (folder) => invokeValidated('models:openLibrary', { folder }),
  /**
   * 单模型详情按需拉取（OPT-PAYLOAD）：列表通道下发的瘦身模型不含详情
   * 消费面字段（autoInfo 详情字段、封面完整 URL 形状），打开详情时经本
   * 通道补全。
   * @param {string} id 模型绝对路径
   * @returns {Promise<{model: object} | {error: string}>}
   */
  getDetail: (id) => invokeValidated('models:getDetail', { id }),
  /** 弹出目录选择框，返回所选目录或 null */
  chooseFolder: () => invokeValidated('models:chooseFolder'),
  /**
   * 跨库存储总览（FN-01）：只读汇总各库索引/元数据，
   * 返回 { overview, warnings } 或 { error }
   */
  crossLibraryOverview: () => invokeValidated('models:crossLibraryOverview'),
  /**
   * 订阅元数据落盘失败事件（message: 错误信息），返回取消监听函数
   * @param {(payload: any) => void} listener 事件回调
   */
  onStoreError: (listener) => subscribe('models:storeError', listener),
}
