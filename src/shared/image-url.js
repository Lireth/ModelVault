/**
 * 本地图片 URL 构造器（单一来源，主/渲染两侧共用）：
 *
 * 此前 mvimg URL 仅主进程可构造（src/main/protocol.js），列表通道因此必须
 * 为每个封面条目下发 url/thumbUrl 两个「绝对路径的再编码副本」——万级库的
 * IPC 载荷中路径字符串占比最高的冗余。收敛到 shared 后，渲染进程可由
 * path/thumbPath 直接派生同一 URL，列表通道无需再携带这两个派生字段；
 * 主进程协议层与封面操作响应仍经同一实现构造（行为不变）。
 *
 * 零依赖纯函数模块：无 electron/node 导入，主进程与渲染进程均可直接导入。
 */

/** 本地图片自定义协议 scheme（与 protocol.js 的注册保持一致） */
export const IMAGE_URL_SCHEME = 'mvimg'

/**
 * 由本地图片绝对路径构造渲染进程可用的 mvimg URL。
 * 主进程（协议处理）与渲染进程（列表瘦身后的派生）共用同一实现，
 * 编码规则漂移即两侧行为同时变化，不存在双份手写。
 * @param {string} filePath 图片绝对路径（空值返回空串）
 * @returns {string} mvimg://local/<encodeURIComponent(path)>
 */
export function toImageUrl(filePath) {
  if (!filePath) return ''
  return `${IMAGE_URL_SCHEME}://local/${encodeURIComponent(filePath)}`
}
