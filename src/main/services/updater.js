import { app, net } from 'electron'
import logger from '../logger'

/**
 * 应用内检查更新（E1）：
 * portable 单文件分发无 electron-updater 支持，采用轻量方案——
 * 查询 GitHub Releases 最新版本号并与当前版本比对，提示用户前往下载页。
 * 网络请求走 Electron net.fetch（Chromium 网络栈，继承系统代理，项目约定）。
 */

/** 更新检查的仓库标识（发布流水线以 v* 标签触发，tag 即版本号） */
const UPDATE_REPO = 'Lireth/ModelVault'

/** 请求超时（ms） */
const REQUEST_TIMEOUT_MS = 10000

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
 *    releaseNotes?: string}>}
 */
export async function checkForUpdate() {
  const current = app.getVersion()
  try {
    const response = await net.fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: {
        'User-Agent': `ModelVault/${current}`,
        Accept: 'application/vnd.github+json'
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (response.status === 404) {
      // 仓库尚无任何 release：视为已是最新
      return { current, hasUpdate: false }
    }
    if (!response.ok) {
      return { error: `更新检查失败（HTTP ${response.status}）`, current }
    }
    let data
    try {
      data = await response.json()
    } catch (err) {
      return { error: `更新信息解析失败: ${err.message}`, current }
    }
    const latest = typeof data?.tag_name === 'string' ? data.tag_name.replace(/^v/, '') : ''
    const releaseUrl = typeof data?.html_url === 'string' ? data.html_url : ''
    const releaseNotes =
      typeof data?.body === 'string' && data.body ? data.body.slice(0, 500) : ''
    if (!latest) {
      return { error: '更新信息格式异常（缺少版本号）', current }
    }
    const hasUpdate = compareVersions(latest, current) > 0
    logger.info(`更新检查完成: 当前 ${current} / 最新 ${latest}${hasUpdate ? '（有更新）' : ''}`)
    return { current, latest, hasUpdate, releaseUrl, releaseNotes }
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return { error: '更新检查超时，请检查网络后重试', current }
    }
    return { error: `更新检查失败: ${err.message}`, current }
  }
}
