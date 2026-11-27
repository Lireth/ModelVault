/**
 * Civitai 示例图片/视频获取：
 * 头部阶段超时 + 逐跳白名单重定向的图片/视频请求、大小与空闲超时受限
 * 的 body 读取、示例图下载与内容类型推断（落盘由封面保存层负责）。
 */

import logger from '../../logger'
import { cancelResponseBody, readResponseBytesLimited } from '../../utils'
import { fetchWithValidatedRedirects } from '../net-fetch'
import { errorMessage, errorName } from '../../../shared/error-text'
import { isAllowedCivitaiImageUrl, RANGE_HEADER_RE } from './hosts'

/**
 * 图片「头部阶段」超时（ms）：与视频链路同级——上游响应头到达前挂起
 * 超过此时限即中止（导入路径报错、协议层转 502）。OPT-17① 起不再覆盖
 * body：示例图普遍数 MB，总量计时在慢链路（1.5MB/s 下载 50MB）必然
 * 假性超时，协议代理的大图流也会被拦腰截断。
 */
const IMAGE_HEADER_TIMEOUT_MS = 30000
/** 图片 body 读取的空闲超时（ms）：导入与协议代理路径逐段计时，停滞即中止 */
export const IMAGE_BODY_IDLE_TIMEOUT_MS = 30000
/**
 * 示例视频「头部阶段」超时（ms）：与图片链路同级——上游响应头到达前
 * 挂起超过此时限即中止（协议层转 502，不再无限悬挂占住套接字）；
 * 头部到达后定时器解除，body 流式回传不受时限（视频可持续播放）。
 */
const VIDEO_HEADER_TIMEOUT_MS = 30000
/** 示例图下载大小上限（与封面导入同一量级） */
const MAX_IMAGE_BYTES = 50 * 1024 * 1024

/** 下载响应的 Content-Type → 封面文件扩展名 */
/** @type {Record<string, string>} */
const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
}

/**
 * 发起 Civitai 图片请求（协议代理与导入下载共用）：
 * 不自定义 UA（保持 Electron 的 Chromium 默认 UA，规避 CDN 反爬挑战），
 * 携带 Referer 与 Accept 提高直连成功率。
 * 重定向改为手动跟随并逐跳校验 CDN 白名单（V-06），返回最终响应。
 * OPT-17①：仅对「响应头到达」设总量超时（原实现为覆盖整个请求含 body
 * 读取的 AbortSignal.timeout，慢链路大图必然假性超时）——头部到达即解除，
 * body 由消费方接力：导入路径 readCivitaiImageBody 逐段空闲计时，协议
 * 代理与视频一致（renderer 背压驱动的流式回传不设总量时限）。
 * @param {string} url 已通过 isAllowedCivitaiImageUrl 校验的图片地址
 * @returns {Promise<Response>}
 */
export async function fetchCivitaiImage(url) {
  // 头部阶段超时：与 fetchCivitaiVideo 同一模型，CDN 连接挂死时中止而非无限悬挂
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), IMAGE_HEADER_TIMEOUT_MS)
  try {
    return await fetchWithValidatedRedirects(
      url,
      {
        headers: {
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          Referer: 'https://civitai.red/',
        },
        signal: controller.signal,
      },
      isAllowedCivitaiImageUrl,
      'Civitai 图片请求',
      { useSessionCookies: true },
    )
  } catch (err) {
    if (controller.signal.aborted && errorName(err) === 'AbortError') {
      throw new Error(
        `图片上游 ${IMAGE_HEADER_TIMEOUT_MS / 1000}s 内未响应（连接挂起），已中止`,
        { cause: err },
      )
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 发起 Civitai 示例视频请求（FN-02）：透传 Range 以支持拖动播放，
 * 仅对「响应头到达」设置超时（上游连接挂死时中止，协议层转 502）；
 * body 流式回传不设整体超时（视频较大且可持续播放，播放中停滞由
 * 播放器重发 Range 自行恢复），域名白名单与图片一致。
 * @param {string} url 已通过 isAllowedCivitaiImageUrl 校验的视频地址
 * @param {string} [range] 原始 Range 请求头（须过白名单格式校验才透传）
 * @returns {Promise<Response>}
 */
export async function fetchCivitaiVideo(url, range = '') {
  /** @type {Record<string, string>} */
  const headers = {
    Accept: 'video/mp4,video/webm,video/*;q=0.9,*/*;q=0.5',
    Referer: 'https://civitai.red/',
  }
  if (typeof range === 'string' && range.trim()) {
    const value = range.trim()
    // Range 值完全来自渲染进程请求头，须过白名单格式校验后再透传上游，
    // 不依赖网络栈对非法头字符的兜底拦截（与重定向逐跳校验同一原则）；
    // 非法值按无 Range 处理（上游返回完整内容，播放仍可用）
    if (RANGE_HEADER_RE.test(value)) {
      headers.Range = value
    } else {
      logger.warn(
        `已丢弃非法 Range 请求头（按无 Range 回源）: ${value.slice(0, 60)}`,
      )
    }
  }
  // 头部阶段超时：此前完全无 signal——CDN 连接挂死时协议请求无限悬挂、
  // 套接字泄漏且 UI 无反馈。响应头到达即解除定时器，body 保持无界流式
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), VIDEO_HEADER_TIMEOUT_MS)
  try {
    return await fetchWithValidatedRedirects(
      url,
      { headers, signal: controller.signal },
      isAllowedCivitaiImageUrl,
      'Civitai 视频请求',
      { useSessionCookies: true },
    )
  } catch (err) {
    if (controller.signal.aborted && errorName(err) === 'AbortError') {
      throw new Error(
        `视频上游 ${VIDEO_HEADER_TIMEOUT_MS / 1000}s 内未响应（连接挂起），已中止`,
        {
          cause: err,
        },
      )
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 读取 Civitai 图片响应体并强制大小上限（V-06）。
 * 协议代理与图片导入共用，避免任意大小响应进入主进程堆。
 * OPT-17①：导入路径启用逐段空闲计时（每收到一段字节重置）——持续传输
 * 的慢速大图不再受总量限制，TCP 停滞超过 30s 判死中止。协议代理的图片
 * 整体读取同理（#46）：body 停滞的半开连接须及时中止让出并发槽。
 * @param {Response} response fetch 响应
 * @param {{idleTimeoutMs?: number}} [options] 空闲超时；不传则不启用
 * @returns {Promise<Buffer>} 图片字节
 */
export function readCivitaiImageBody(response, { idleTimeoutMs = 0 } = {}) {
  return readResponseBytesLimited(response, MAX_IMAGE_BYTES, '图片内容', {
    idleTimeoutMs,
  })
}

/**
 * 下载 Civitai 示例图并做内容校验（仅下载白名单 CDN 的图片）。
 * 返回图片字节与按 Content-Type 推断的扩展名，落盘由封面保存层负责。
 * @param {string} url 图片 URL（必须命中 isAllowedCivitaiImageUrl）
 * @returns {Promise<any>} 成功 {buf, ext}；失败 {error}
 */
export async function downloadCivitaiImage(url) {
  if (!isAllowedCivitaiImageUrl(url)) {
    return { error: '图片地址不在 Civitai CDN 白名单内，已拒绝下载' }
  }
  /** @type {Response} */
  let response
  try {
    response = await fetchCivitaiImage(url)
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError')
    ) {
      return { error: '图片下载超时' }
    }
    return { error: `图片下载失败: ${errorMessage(err)}` }
  }
  if (!response.ok) {
    cancelResponseBody(response)
    return { error: `图片下载失败（HTTP ${response.status}）` }
  }
  let buf
  try {
    buf = await readCivitaiImageBody(response, {
      idleTimeoutMs: IMAGE_BODY_IDLE_TIMEOUT_MS,
    })
  } catch (err) {
    return { error: `图片内容读取失败: ${errorMessage(err)}` }
  }
  if (buf.length === 0) {
    return { error: '图片内容为空' }
  }
  // 内容校验：按响应 Content-Type 推断扩展名，URL 路径扩展名兜底
  // split 恒返回至少 1 项，?? '' 仅为索引访问的类型兜底（运行时不触发）
  const mime = (
    String(response.headers.get('content-type') || '').split(';')[0] ?? ''
  )
    .trim()
    .toLowerCase()
  let ext = MIME_EXT[mime] || ''
  if (!ext) {
    const m = new URL(url).pathname.match(/\.(jpe?g|png|webp|gif|bmp)$/i)
    ext = m
      ? `.${/** @type {string} */ (m[1]).toLowerCase().replace('jpeg', 'jpg')}`
      : '.jpg'
  }
  return { buf, ext }
}
