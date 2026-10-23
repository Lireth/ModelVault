import { app } from 'electron'
import logger from '../logger'
import { isAllowedExternalUrl, readResponseTextLimited } from '../utils'
import {
  fetchAllowedUpdateUrl,
  findUpdateAssets,
  isSafeUpdateVersion,
  setPendingUpdate
} from './update-download'

/**
 * 应用内检查更新（E1，F-6 扩展下载链路）：
 * portable 单文件分发无 electron-updater 支持，采用轻量方案——
 * 查询 GitHub Releases 最新版本号并与当前版本比对；同时解析 Release
 * 附加的 ModelVault-<version>.exe 与 .sha256 资产（命名约定精确匹配 +
 * github.com 白名单），供「下载更新 → 运行更新程序」闭环使用（资产信息
 * 保存于 update-download 模块态，渲染层不可注入 URL）。
 * 网络请求走 Electron net.fetch（Chromium 网络栈，继承系统代理，项目约定）。
 */

/** 更新检查的仓库标识（发布流水线以 v* 标签触发，tag 即版本号） */
const UPDATE_REPO = 'Lireth/ModelVault'

/** 请求超时（ms） */
const REQUEST_TIMEOUT_MS = 10000
/** GitHub Release JSON 上限（V-06）：正常响应远小于此值 */
const MAX_UPDATE_JSON_BYTES = 2 * 1024 * 1024

/**
 * 比较两个 semver 风格版本号（仅数字段，如 0.1.2）。
 * @param {string} a
 * @param {string} b
 * @returns {number} a > b 返回 1，a < b 返回 -1，相等返回 0
 */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((s) => Number.parseInt(s, 10) || 0)
  const pb = String(b).split('.').map((s) => Number.parseInt(s, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const va = pa[i] || 0
    const vb = pb[i] || 0
    if (va > vb) return 1
    if (va < vb) return -1
  }
  return 0
}

/**
 * 检查更新。任何失败都以 { error } 返回（不抛出），调用方直接展示。
 * @returns {Promise<{error: string} |
 *   {current: string, latest?: string, hasUpdate: boolean, releaseUrl?: string,
 *    releaseNotes?: string, canDownload?: boolean, downloadSize?: number}>}
 */
export async function checkForUpdate() {
  const current = app.getVersion()
  try {
    const response = await fetchAllowedUpdateUrl(
      `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`,
      {
        headers: {
          'User-Agent': `ModelVault/${current}`,
          Accept: 'application/vnd.github+json'
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      }
    )
    if (response.status === 404) {
      // 仓库尚无任何 release：视为已是最新
      return { current, hasUpdate: false }
    }
    if (!response.ok) {
      return { error: `更新检查失败（HTTP ${response.status}）`, current }
    }
    let data
    try {
      data = JSON.parse(
        await readResponseTextLimited(response, MAX_UPDATE_JSON_BYTES, '更新信息')
      )
    } catch (err) {
      return { error: `更新信息解析失败: ${err.message}`, current }
    }
    const latest = typeof data?.tag_name === 'string' ? data.tag_name.replace(/^v/, '') : ''
    if (!latest) {
      return { error: '更新信息格式异常（缺少版本号）', current }
    }
    // V-06：版本号参与更新包文件名，必须限定纯数字三段
    if (!isSafeUpdateVersion(latest)) {
      logger.warn(`更新信息版本号非法，已忽略: ${String(data?.tag_name).slice(0, 80)}`)
      return { error: '更新信息格式异常（版本号非法）', current }
    }
    // 下载页地址必须命中外链白名单（B3）：API 响应不可信时不得把用户
    // 引向白名单外站点（渲染层据空串隐藏「前往下载」入口）
    let releaseUrl = ''
    if (isAllowedExternalUrl(data?.html_url)) {
      releaseUrl = data.html_url
    } else if (typeof data?.html_url === 'string' && data.html_url) {
      logger.warn(`更新检查返回的下载页地址不在白名单，已忽略: ${data.html_url.slice(0, 200)}`)
    }
    const releaseNotes =
      typeof data?.body === 'string' && data.body ? data.body.slice(0, 500) : ''
    const hasUpdate = compareVersions(latest, current) > 0
    // 应用内下载资产（F-6）：命名约定 + 白名单双校验通过才可用；
    // 结果保存模块态（下载入口的唯一合法 URL 来源），渲染层仅得可用性标志
    const assets = findUpdateAssets(data, latest)
    setPendingUpdate(hasUpdate ? assets : null, latest)
    logger.info(
      `更新检查完成: 当前 ${current} / 最新 ${latest}${hasUpdate ? '（有更新）' : ''}` +
        `${assets ? '，支持应用内下载' : ''}`
    )
    return {
      current,
      latest,
      hasUpdate,
      releaseUrl,
      releaseNotes,
      canDownload: hasUpdate && assets !== null,
      downloadSize: assets ? assets.size : 0
    }
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { error: '更新检查超时，请检查网络后重试', current }
    }
    return { error: `更新检查失败: ${err.message}`, current }
  }
}
