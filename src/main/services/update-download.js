import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { app, net } from 'electron'
import logger from '../logger'
import { isAllowedExternalUrl } from '../utils'

/**
 * 应用内更新下载与安装（F-6，portable 形态专用）：
 * electron-updater 对 portable 单文件分发无自动替换能力，采用
 * 「应用内下载 + SHA256 校验 + 延迟拉起新 EXE」的轻量方案：
 * - 下载目标为 Release 附加的 ModelVault-<version>.exe 与同名 .sha256
 *   （release.yml 产物，sha256sum 兼容格式）；
 * - 下载地址由主进程自己的 GitHub API 查询结果提供（模块态保存，渲染层
 *   不可注入 URL），且必须 https + github.com 白名单——被篡改的 API 响应
 *   无法把用户引向他站；
 * - 边下载边计算 SHA256，完成后与校验和文件比对，不匹配即删除重来；
 * - 写入临时 .part 文件，校验通过后原子改名，断电/崩溃不产生半成品误装；
 * - 安装 = 延迟 3s 拉起新 EXE 并退出当前实例：等待退出释放单实例锁，
 *   避免新实例因锁被占而闪退。
 * 缓存位置 %APPDATA%\modelvault\update\（机器本地，与 .modelvault 无关）。
 */

const UPDATE_DIR_NAME = 'update'
/** 校验和/元信息请求超时（ms） */
const REQUEST_TIMEOUT_MS = 15000
/** 更新包体积上限（B）：超限中止，防异常响应写满磁盘 */
const MAX_UPDATE_BYTES = 600 * 1024 * 1024
/** 进度推送节流间隔（ms） */
const PROGRESS_INTERVAL_MS = 200
/** 安装延迟（ms）：等待当前实例退出并释放单实例锁 */
const INSTALL_DELAY_MS = 3000

/**
 * 校验和文本 → 64 位十六进制哈希（纯函数，单测锁定）：
 * 兼容 sha256sum 格式（"<hash>  <文件名>"），取首个 64 位 hex token。
 * @param {unknown} text 校验和文件内容
 * @returns {string} 小写哈希，解析失败为空串
 */
export function parseChecksumHash(text) {
  if (typeof text !== 'string') return ''
  const m = /^\s*([0-9a-fA-F]{64})\b/im.exec(text)
  return m ? m[1].toLowerCase() : ''
}

/**
 * 从 GitHub API release 响应中提取更新包资产（纯函数，单测锁定）：
 * 仅接受与本版本命名约定完全一致的资产（ModelVault-<latest>.exe[.sha256]），
 * 下载地址必须命中外链白名单（B3：https + github.com）。
 * @param {object} data GitHub API releases/latest 响应
 * @param {string} latest 最新版本号（不含 v 前缀）
 * @returns {{downloadUrl: string, checksumUrl: string, size: number} | null}
 *   任一资产缺失或地址不合规返回 null（视为不可应用内更新，回退下载页引导）
 */
export function findUpdateAssets(data, latest) {
  if (!data || typeof latest !== 'string' || !latest) return null
  const assets = Array.isArray(data.assets) ? data.assets : []
  const exeName = `ModelVault-${latest}.exe`
  const sumName = `${exeName}.sha256`
  const exe = assets.find((a) => a && a.name === exeName)
  const sum = assets.find((a) => a && a.name === sumName)
  if (!exe || !sum) return null
  if (!isAllowedExternalUrl(exe.browser_download_url)) return null
  if (!isAllowedExternalUrl(sum.browser_download_url)) return null
  const size = Number(exe.size)
  return {
    downloadUrl: exe.browser_download_url,
    checksumUrl: sum.browser_download_url,
    size: Number.isFinite(size) && size > 0 ? size : 0
  }
}

/** 最近一次检查到的可用更新资产（含版本号）；渲染层不可注入 */
let pendingAssets = null
/** 已完成校验的更新包路径（安装入口的唯一合法来源） */
let downloadedFile = ''
/** 进行中下载的取消控制器（null 表示空闲） */
let downloadAbort = null

/**
 * 记录检查更新得到的可用资产（由 updater.checkForUpdate 调用）。
 * @param {{downloadUrl: string, checksumUrl: string, size: number}|null} assets
 * @param {string} latest 最新版本号
 */
export function setPendingUpdate(assets, latest) {
  pendingAssets = assets ? { ...assets, latest } : null
}

/** 是否存在可下载的更新资产（渲染层「下载更新」按钮的显示依据） */
export function hasPendingUpdate() {
  return pendingAssets !== null
}

/** 测试隔离用：清空模块态（pendingAssets / 已下载路径 / 进行中下载） */
export function resetUpdateStateForTest() {
  pendingAssets = null
  downloadedFile = ''
  downloadAbort?.abort()
  downloadAbort = null
}

/** 更新包缓存目录 */
function getUpdateDir() {
  return path.join(app.getPath('userData'), UPDATE_DIR_NAME)
}

/** 流式计算文件 SHA256（小写 hex） */
async function hashFile(filePath) {
  const hash = createHash('sha256')
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex').toLowerCase()
}

/**
 * 下载更新包（IPC 入口）：命中本地完整包直接复用；否则流式下载 +
 * 边下边哈希 + 校验和比对 + 原子落盘。
 * 并发闸在函数入口同步置位（首个 await 之前）——check+set 在同一同步
 * 段内完成，任一 await 间隙到达的并发请求都会被立即拒绝；若在 checksum
 * 等待后才置位，多个调用可穿透闸门堆积在同一挂起点（竞态修复，F-6）。
 * @param {(p: {received: number, total: number}) => void} [onProgress] 进度回调（已节流）
 * @returns {Promise<{path: string, size: number, reused?: boolean} | {canceled: true} | {error: string}>}
 */
export async function downloadUpdatePackage(onProgress) {
  if (downloadAbort) return { error: '更新包正在下载中，请稍候' }
  if (!pendingAssets) return { error: '没有可用的更新信息，请先检查更新' }
  const { downloadUrl, checksumUrl, size, latest } = pendingAssets
  const dir = getUpdateDir()
  const target = path.join(dir, `ModelVault-${latest}.exe`)
  const tmp = `${target}.${process.pid}.part`
  // 并发闸同步置位（见函数注释）
  downloadAbort = new AbortController()
  try {
    try {
      await fsp.mkdir(dir, { recursive: true })
    } catch (err) {
      return { error: `创建更新目录失败: ${err.message}` }
    }

    // 校验和：expected = sha256sum 兼容文件首 token
    let expected
    try {
      const res = await net.fetch(checksumUrl, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (!res.ok) return { error: `校验和下载失败（HTTP ${res.status}）` }
      expected = parseChecksumHash(await res.text())
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        return { error: '校验和下载超时，请检查网络后重试' }
      }
      return { error: `校验和下载失败: ${err.message}` }
    }
    if (!expected) return { error: '校验和文件格式异常' }

    // 本地已有完整包（上次下载完成但未安装）：哈希命中直接复用
    try {
      if ((await fsp.stat(target)).isFile() && (await hashFile(target)) === expected) {
        downloadedFile = target
        logger.info(`更新包已存在且校验通过，直接复用: ${target}`)
        return { path: target, size: size || 0, reused: true }
      }
    } catch {
      /* 不存在，走下载 */
    }

    // 流式下载：边写临时文件边计算哈希（免二次读盘），进度节流推送
    const hash = createHash('sha256')
    let received = 0
    let lastSent = 0
    const response = await net.fetch(downloadUrl, { signal: downloadAbort.signal })
    if (!response.ok || !response.body) {
      return { error: `更新包下载失败（HTTP ${response.status}）` }
    }
    const total = Number(response.headers.get('content-length')) || size
    const reader = response.body.getReader()
    const fh = await fsp.open(tmp, 'w')
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > MAX_UPDATE_BYTES) {
          throw new Error('更新包体积异常，已中止下载')
        }
        hash.update(value)
        await fh.write(value)
        const now = Date.now()
        if (now - lastSent >= PROGRESS_INTERVAL_MS) {
          lastSent = now
          onProgress?.({ received, total })
        }
      }
    } finally {
      await fh.close()
    }
    onProgress?.({ received, total })

    // 校验和比对：不匹配视为损坏/被篡改，删除临时文件
    const actual = hash.digest('hex').toLowerCase()
    if (actual !== expected) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      logger.warn(`更新包校验和不匹配: 期望 ${expected} 实际 ${actual}`)
      return { error: '校验和不匹配，下载可能损坏或被篡改，已放弃本次下载' }
    }
    // 原子落盘：先移除旧包再改名（Windows rename 对已存在目标不可靠）
    await fsp.rm(target, { force: true }).catch(() => {})
    await fsp.rename(tmp, target)
    downloadedFile = target
    logger.info(`更新包下载完成并通过校验: ${target}（${received} 字节）`)
    return { path: target, size: received }
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    if (err instanceof Error && err.name === 'AbortError') {
      logger.info('更新包下载已取消')
      return { canceled: true }
    }
    logger.warn(`更新包下载失败: ${err?.message || err}`)
    return { error: `更新包下载失败: ${err?.message || err}` }
  } finally {
    downloadAbort = null
  }
}

/** 取消进行中的下载（空闲时为 no-op） */
export function cancelUpdateDownload() {
  downloadAbort?.abort()
  return { ok: true }
}

/**
 * 运行更新程序：延迟拉起新 EXE（等待当前实例退出并释放单实例锁）后退出。
 * 仅接受本服务下载并校验通过的文件路径——渲染层不传路径。
 * @returns {{ok: true} | {error: string}}
 */
export function installUpdatePackage() {
  const file = downloadedFile
  if (!file) return { error: '尚未下载更新包，请先下载更新' }
  try {
    // cmd 延迟启动：timeout 3s 后 start 新实例（路径经引号包裹，来源为本
    // 服务生成的 userData 路径，无注入面）
    spawn(
      'cmd.exe',
      ['/d', '/s', '/c', `timeout /t ${INSTALL_DELAY_MS / 1000} /nobreak >nul & start "" "${file}"`],
      { windowsHide: true, detached: true, stdio: 'ignore' }
    ).unref()
  } catch (err) {
    logger.warn(`更新程序启动失败: ${err.message}`)
    return { error: `启动更新程序失败: ${err.message}` }
  }
  logger.info(`已计划启动更新程序（${INSTALL_DELAY_MS}ms 后）: ${file}`)
  setTimeout(() => app.quit(), 500)
  return { ok: true }
}
