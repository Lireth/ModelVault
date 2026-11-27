/**
 * Civitai 在线识别服务（门面）：分层后保持导入路径 `services/civitai` 与全部公共 API 不变。
 *
 * Civitai 在线识别服务：
 * - 由模型文件流式计算 SHA256（复用元数据层的 hash/hashMtime 缓存字段），
 *   经 Civitai API 按哈希反查模型版本（by-hash 端点，社区通行做法）；
 * - 识别成功时生成 Civitai 页面 URL 与「一键补全」元数据补丁（纯函数）。
 * 网络请求走 Electron net.fetch（Chromium 网络栈，直连目标站点：不配置
 * 也不回退任何代理逻辑，网络不可达按既有错误链路返回失败）。本服务不做
 * 任何用户数据覆盖判断之外的写盘。
 *
 * 内部按职责拆分（依赖单向：hosts ← throttle ← api；hosts ← media；
 * meta 仅类型依赖 api 的 CivitaiVersionInfo，hash 独立）：
 * - civitai/throttle.js API 节流与开关（全局限流可变状态、429/瞬时错误退避）
 * - civitai/hosts.js    域名白名单与 Range 头格式校验（纯函数）
 * - civitai/hash.js     文件 SHA256 计算（线程池委托入口）
 * - civitai/api.js      by-hash 反查与模型查询、响应规范化
 * - civitai/media.js    示例图片/视频获取与下载校验
 * - civitai/meta.js     描述纯文本化与「一键补全」补丁（纯函数）
 */

export {
  CIVITAI_DISABLED_ERROR,
  setCivitaiApiInterval,
  setCivitaiTransientRetryDelayForTests,
} from './civitai/throttle'

export { isAllowedCivitaiImageUrl } from './civitai/hosts'

export { computeFileHash } from './civitai/hash'

export {
  fetchCivitaiVersionByHash,
  normalizeVersionInfo,
  parseCivitaiModelId,
  fetchCivitaiModelType,
} from './civitai/api'

export {
  IMAGE_BODY_IDLE_TIMEOUT_MS,
  fetchCivitaiImage,
  fetchCivitaiVideo,
  readCivitaiImageBody,
  downloadCivitaiImage,
} from './civitai/media'

export { stripHtml, civitaiCompletePatch } from './civitai/meta'
