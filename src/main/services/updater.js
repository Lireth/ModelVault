import { app, BrowserWindow } from 'electron'
import logger from '../logger'
import { isAllowedExternalUrl, readResponseTextLimited } from '../utils'
import { getSettings } from './store-settings'
import { REQUEST_TIMEOUT_MS } from './net-fetch'
import {
  fetchAllowedUpdateUrl,
  findUpdateAssets,
  isSafeUpdateVersion,
  setPendingUpdate,
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

// 请求超时统一走 net-fetch.js 的 REQUEST_TIMEOUT_MS（原本地 10s，随全网
// 络层收敛放宽为 15s，与 Civitai/更新下载链路一致）
/** GitHub Release JSON 上限（V-06）：正常响应远小于此值 */
const MAX_UPDATE_JSON_BYTES = 2 * 1024 * 1024
/** 启动自动检查延迟（ms，O-3）：避开启动初期的库加载/扫描/索引预热竞争 */
const STARTUP_CHECK_DELAY_MS = 15000

/**
 * 比较两个 semver 风格版本号（仅数字段，如 0.1.2）。
 * @param {string} a
 * @param {string} b
 * @returns {number} a > b 返回 1，a < b 返回 -1，相等返回 0
 */
export function compareVersions(a, b) {
  const pa = String(a)
    .split('.')
    .map((s) => Number.parseInt(s, 10) || 0)
  const pb = String(b)
    .split('.')
    .map((s) => Number.parseInt(s, 10) || 0)
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
          Accept: 'application/vnd.github+json',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
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
        await readResponseTextLimited(
          response,
          MAX_UPDATE_JSON_BYTES,
          '更新信息',
        ),
      )
    } catch (err) {
      return { error: `更新信息解析失败: ${err.message}`, current }
    }
    const latest =
      typeof data?.tag_name === 'string' ? data.tag_name.replace(/^v/, '') : ''
    if (!latest) {
      return { error: '更新信息格式异常（缺少版本号）', current }
    }
    // V-06：版本号参与更新包文件名，必须限定纯数字三段
    if (!isSafeUpdateVersion(latest)) {
      logger.warn(
        `更新信息版本号非法，已忽略: ${String(data?.tag_name).slice(0, 80)}`,
      )
      return { error: '更新信息格式异常（版本号非法）', current }
    }
    // 下载页地址必须命中外链白名单（B3）：API 响应不可信时不得把用户
    // 引向白名单外站点（渲染层据空串隐藏「前往下载」入口）
    let releaseUrl = ''
    if (isAllowedExternalUrl(data?.html_url)) {
      releaseUrl = data.html_url
    } else if (typeof data?.html_url === 'string' && data.html_url) {
      logger.warn(
        `更新检查返回的下载页地址不在白名单，已忽略: ${data.html_url.slice(0, 200)}`,
      )
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
        `${assets ? '，支持应用内下载' : ''}`,
    )
    return {
      current,
      latest,
      hasUpdate,
      releaseUrl,
      releaseNotes,
      canDownload: hasUpdate && assets !== null,
      downloadSize: assets ? assets.size : 0,
    }
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError')
    ) {
      return { error: '更新检查超时，请检查网络后重试', current }
    }
    return { error: `更新检查失败: ${err.message}`, current }
  }
}

/* ---------------- 启动自动检查更新（O-3） ---------------- */

/**
 * 执行一次启动静默检查（决策逻辑独立导出，便于单测）：
 * - 设置关闭：直接跳过，不发任何网络请求；
 * - 检查失败/无更新：静默结束（仅由 check 内部记日志），不打扰用户；
 * - 仅「有更新」时经 notify 推送渲染层（载荷为检查结果的渲染层所需子集）。
 * @param {{autoCheckUpdate: boolean}} settings 应用设置（getSettings 合并视图）
 * @param {() => Promise<{error?: string, hasUpdate?: boolean, current?: string,
 *   latest?: string, releaseUrl?: string, releaseNotes?: string,
 *   canDownload?: boolean, downloadSize?: number}>} check 检查函数（生产为 checkForUpdate）
 * @param {(payload: object) => void} notify 有更新时的推送回调
 * @returns {Promise<boolean>} 是否执行了推送
 */
export async function runStartupUpdateCheck(settings, check, notify) {
  if (settings?.autoCheckUpdate !== true) return false
  const result = await check()
  if (!result || result.error || result.hasUpdate !== true) return false
  notify({
    current: result.current,
    latest: result.latest,
    releaseUrl: result.releaseUrl || '',
    releaseNotes: result.releaseNotes || '',
    canDownload: result.canDownload === true,
    downloadSize: result.downloadSize || 0,
  })
  return true
}

/** 向所有窗口广播「发现新版本」（app:updateAvailable 事件） */
function broadcastUpdateAvailable(payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('app:updateAvailable', payload)
    }
  }
}

/** 已安排的启动检查定时器（幂等：重复调用覆盖未触发的前次） */
let startupCheckTimer = null

/**
 * 安排启动自动检查更新（应用启动完成后调用一次，O-3）：
 * - 延迟执行，避免与初始扫描/索引读取竞争网络与 CPU；
 * - 开发环境与冒烟模式跳过：dev 每次启动都请求 GitHub 既无意义也干扰测试确定性；
 * - 是否真正发起请求由触发时刻的设置值决定（用户在延迟窗口内关闭开关即时生效）。
 * @param {number} [delayMs] 延迟毫秒数（测试可注入小值）
 */
export function scheduleStartupUpdateCheck(delayMs = STARTUP_CHECK_DELAY_MS) {
  if (!app.isPackaged || process.env.MODELVAULT_SMOKE === '1') return
  if (startupCheckTimer) clearTimeout(startupCheckTimer)
  startupCheckTimer = setTimeout(() => {
    startupCheckTimer = null
    runStartupUpdateCheck(
      getSettings(),
      checkForUpdate,
      broadcastUpdateAvailable,
    ).catch((err) => logger.warn(`启动自动检查更新失败: ${err.message}`))
  }, delayMs)
  // 不阻止进程退出：延迟窗口内用户关窗时，flush 链完成后 app.quit 正常终止
  // （与其他后台定时器的 unref 规范一致，避免持有闭包拖延退出）
  startupCheckTimer.unref?.()
}
