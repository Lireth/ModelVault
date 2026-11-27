import { invokeValidated, subscribe } from '../core'

/** Civitai 域 api 切片（schema-civitai：识别/补全/示例图导入/哈希预热，models 命名空间） */
export const civitaiModelApi = {
  /**
   * Civitai 在线识别（按文件 SHA256 反查），返回
   * { found: true, url, info, meta } / { found: false } / { error }。
   * 大文件哈希计算可能耗时数十秒，调用方需提供忙碌提示。
   * FEAT-9：fillMissing=true 时识别成功后顺带补全空缺触发词/备注
   * （复用同一次反查结果，响应附带 applied 字段列表；批量队列专用，
   * 单模型链路不传保持原行为）
   * OP-D：force=true 绕过未收录负缓存（详情页手动识别取最新结果）；
   * 批量链路不传——已确认未收录的模型零网络快速返回（响应带 cachedMiss）
   * @param {string} id 模型绝对路径
   * @param {boolean} [fillMissing=false] 识别成功后顺带补全空缺字段
   * @param {boolean} [force=false] 绕过未收录负缓存
   */
  civitaiIdentify: (id, fillMissing = false, force = false) =>
    invokeValidated('models:civitaiIdentify', {
      id,
      ...(fillMissing ? { fillMissing: true } : null),
      ...(force ? { force: true } : null),
    }),
  /**
   * Civitai 一键分配标签（仅 LoRA 模型；按已保存链接查询模型分类并映射
   * 分类标签），返回 { found: true, subCategory, meta }
   * / { found: true, unmapped: true } / { skipped: true, reason? }
   * / { found: false } / { error }
   * @param {string} id 模型绝对路径
   */
  civitaiCategory: (id) => invokeValidated('models:civitaiCategory', { id }),
  /**
   * Civitai 一键补全（仅填充空缺的触发词/备注），返回
   * { found: true, applied: string[], meta } / { found: false } / { error }
   * @param {string} id 模型绝对路径
   */
  civitaiComplete: (id) => invokeValidated('models:civitaiComplete', { id }),
  /**
   * 导入 Civitai 示例图为模型封面（images: [{url}]，仅限 Civitai CDN，
   * 单次上限 20 张），返回 { added, failed, cover, coverUrl, covers, meta }
   * 或 { error }
   * @param {string} id 模型绝对路径
   * @param {Array<{ url: string }>} images 示例图列表
   */
  civitaiImportImages: (id, images) =>
    invokeValidated('models:civitaiImportImages', { id, images }),
  /**
   * 预热模型哈希（Civitai 识别加速）：详情页打开时调用，后台计算该模型
   * 的 SHA256 并写入元数据缓存，入队即返回 { ok }，不等待计算完成
   * @param {string} id 模型绝对路径
   */
  warmupHash: (id) => invokeValidated('models:warmupHash', { id }),
  /** 订阅后台哈希预热进度事件（快照: { active, id, percent, hashedBytes, totalBytes, done, remaining }）
   * @param {(payload: any) => void} listener 事件回调
   */
  onWarmupProgress: (listener) => subscribe('models:warmupProgress', listener),
}
