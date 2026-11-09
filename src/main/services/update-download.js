import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import logger from '../logger'
import {
  isAllowedExternalUrl,
  raceIdleTimeout,
  readResponseTextLimited,
} from '../utils'
import {
  REQUEST_TIMEOUT_MS,
  fetchWithValidatedRedirects,
  isTransientNetworkError,
} from './net-fetch'
import { parseChecksumHash, verifyUpdateSignature } from './update-verify'
import { errorMessage } from '../../shared/error-text'

/**
 * 应用内更新下载（F-6，portable 形态专用；验签见 update-verify.js，安装见
 * update-install.js）：
 * electron-updater 对 portable 单文件分发无自动替换能力，采用
 * 「应用内下载 + SHA256 校验 + 延迟拉起新 EXE」的轻量方案：
 * - 下载目标为 Release 附加的 ModelVault-<version>.exe 与同名 .sha256
 *   （release.yml 产物，sha256sum 兼容格式）；
 * - 下载地址由主进程自己的 GitHub API 查询结果提供（模块态保存，渲染层
 *   不可注入 URL），且必须 https + github.com 白名单——被篡改的 API 响应
 *   无法把用户引向他站；
 * - 边下载边计算 SHA256，完成后与校验和文件比对，不匹配即删除重来；
 * - 写入稳定的 .download.part 文件，校验通过后原子改名；网络中断/取消时保留
 *   已下载部分，再次下载以 HTTP Range 续传（OP-06），最终仍以完整 SHA256
 *   与 Authenticode 校验为准，断电/崩溃不产生半成品误装；
 * - E1：发布包使用 Windows 代码签名；配置发布者证书指纹后，下载复用与
 *   安装前均强制 Authenticode 状态 Valid 且指纹一致（fail-closed）；
 * - 安装 = 拉起新 EXE（携带 --wait-for-pid 等待旧实例释放单实例锁）并退出：
 *   新实例不会因锁被占而闪退，且全程不经过 shell。
 * 缓存位置 %APPDATA%\modelvault\update\（机器本地，与 .modelvault 无关）。
 */

const UPDATE_DIR_NAME = 'update'
/** 更新包体积上限（B）：超限中止，防异常响应写满磁盘 */
const MAX_UPDATE_BYTES = 600 * 1024 * 1024
/** 校验和文件上限（V-06）：正常仅 65~100 字节 */
const MAX_CHECKSUM_BYTES = 64 * 1024
/** 更新下载允许的主机（V-06）：GitHub 页面与 Release 资产 CDN */
const ALLOWED_UPDATE_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
])
/** 版本号白名单（V-06）：只允许纯数字三段，杜绝路径分隔符/命令字符进入文件名 */
const VERSION_PATTERN = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/
/** 进度推送节流间隔（ms） */
const PROGRESS_INTERVAL_MS = 200
/**
 * 下载流的空闲超时（ms，OPT-17①）：600MB 更新包在慢链路下的合法耗时
 * 远超任何总量阈值，故不设总量限时；改为逐段空闲计时——每收到一段字节
 * 重置，TCP 停滞超过 60s 判死中止（.part 保留供 Range 续传）。
 */
const DOWNLOAD_IDLE_TIMEOUT_MS = 60 * 1000

/**
 * 版本号是否可用于拼接文件名（V-06）。
 * 更新包路径由 `ModelVault-${latest}.exe` 生成，latest 来自 API 响应，
 * 必须限定纯数字三段，避免 `../`、命令行分隔符等进入路径。
 * @param {unknown} version 版本号（不含 v 前缀）
 * @returns {boolean}
 */
export function isSafeUpdateVersion(version) {
  return typeof version === 'string' && VERSION_PATTERN.test(version)
}

/**
 * 更新链路 URL 白名单（V-06）：https + GitHub 页面/API/Release 资产 CDN。
 * @param {unknown} url 待校验 URL
 * @returns {boolean}
 */
function isAllowedUpdateHost(url) {
  try {
    const parsed = new URL(String(url))
    return (
      parsed.protocol === 'https:' &&
      ALLOWED_UPDATE_HOSTS.has(parsed.hostname.toLowerCase())
    )
  } catch {
    return false
  }
}

// 重定向跟随（V-06 逐跳白名单）与 Electron "Redirect was cancelled"
// 兼容探测统一由 services/net-fetch.js 提供；更新链路为公开资产下载，
// 探测不携带会话 Cookie（与 net.fetch 默认凭据语义一致）

/**
 * 发起更新相关请求并手动跟随重定向（V-06，逐跳 GitHub 白名单）。
 * @param {string} url 初始 URL（调用方已校验）
 * @param {RequestInit} options fetch 选项
 * @returns {Promise<Response>} 最终响应
 */
export function fetchAllowedUpdateUrl(url, options) {
  return fetchWithValidatedRedirects(
    url,
    options,
    isAllowedUpdateHost,
    '更新下载',
    { useSessionCookies: false },
  )
}

/** 瞬时网络错误重试的退避间隔（ms） */
const TRANSIENT_RETRY_DELAY_MS = 500

/** 等待指定毫秒（重试退避） */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 带瞬时错误重试的更新请求（连接级失败重试 1 次）：
 * 此前更新链路对 ECONNRESET/ENOTFOUND 等连接级瞬时错误零重试，网络抖动
 * 即要求用户手动重点。仅对「请求未建立/被重置」类失败重试——fetch 拒绝
 * 发生在响应到达前，本次无任何字节落盘，重试幂等；options 经工厂按次
 * 重建，超时类 AbortSignal 不复用第一次已消耗的时间。超时中止与服务端
 * 4xx/5xx 不重试（等待会成倍拉长/非网络层失败，交回调用方既有语义）。
 * @param {string} url 初始 URL
 * @param {() => RequestInit} buildOptions 每次尝试的 fetch 选项工厂
 * @returns {Promise<Response>} 最终响应
 */
async function fetchUpdateUrlReliably(url, buildOptions) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchAllowedUpdateUrl(url, buildOptions())
    } catch (err) {
      if (attempt >= 1 || !isTransientNetworkError(err)) throw err
      logger.warn(
        `更新请求连接级失败，${TRANSIENT_RETRY_DELAY_MS}ms 后重试: ${errorMessage(err)}`,
      )
      await delay(TRANSIENT_RETRY_DELAY_MS)
    }
  }
}

/**
 * 从 GitHub API release 响应中提取更新包资产（纯函数，单测锁定）：
 * 仅接受与本版本命名约定完全一致的资产（ModelVault-<latest>.exe[.sha256]），
 * 下载地址必须命中外链白名单（B3：https + github.com）。
 * @param {Record<string, any>} data GitHub API releases/latest 响应（字段运行时校验）
 * @param {string} latest 最新版本号（不含 v 前缀）
 * @returns {{downloadUrl: string, checksumUrl: string, size: number} | null}
 *   任一资产缺失或地址不合规返回 null（视为不可应用内更新，回退下载页引导）
 */
export function findUpdateAssets(data, latest) {
  if (!data || !isSafeUpdateVersion(latest)) return null
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
    size: Number.isFinite(size) && size > 0 ? size : 0,
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

/** 更新包缓存目录（安装模块共用） */
export function getUpdateDir() {
  return path.join(app.getPath('userData'), UPDATE_DIR_NAME)
}

/** 已完成校验的更新包路径（安装入口的唯一合法来源；仅本模块写入） */
export function getDownloadedFile() {
  return downloadedFile
}

/** 流式计算文件 SHA256（小写 hex） */
async function hashFile(filePath) {
  const hash = createHash('sha256')
  await updateHashFromFile(hash, filePath)
  return hash.digest('hex').toLowerCase()
}

/** 把文件内容流式喂入既有 hash（续传时先补齐已下载部分的哈希状态） */
async function updateHashFromFile(hash, filePath) {
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
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
  // V-06：latest 参与文件名拼接，必须先通过纯数字三段白名单
  if (!isSafeUpdateVersion(latest)) {
    return { error: '更新信息格式异常（版本号非法），请前往下载页手动更新' }
  }
  const dir = getUpdateDir()
  const target = path.join(dir, `ModelVault-${latest}.exe`)
  // OP-06：稳定的 .part 名称（跨进程保留），用于中断后续传；
  // 版本号已通过白名单校验，不同版本互不冲突
  const partPath = `${target}.download.part`
  // 并发闸同步置位（见函数注释）
  downloadAbort = new AbortController()
  try {
    try {
      await fsp.mkdir(dir, { recursive: true })
    } catch (err) {
      return { error: `创建更新目录失败: ${errorMessage(err)}` }
    }

    // 校验和：expected = sha256sum 兼容文件首 token。
    // 重定向逐跳校验 + 文本大小上限（V-06）
    let expected
    try {
      const res = await fetchUpdateUrlReliably(checksumUrl, () => ({
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }))
      if (!res.ok) return { error: `校验和下载失败（HTTP ${res.status}）` }
      expected = parseChecksumHash(
        await readResponseTextLimited(res, MAX_CHECKSUM_BYTES, '校验和文件'),
      )
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === 'TimeoutError' || err.name === 'AbortError')
      ) {
        return { error: '校验和下载超时，请检查网络后重试' }
      }
      return { error: `校验和下载失败: ${errorMessage(err)}` }
    }
    if (!expected) return { error: '校验和文件格式异常' }

    // 本地已有完整包（上次下载完成但未安装）：哈希命中且验签通过才复用
    try {
      if (
        (await fsp.stat(target)).isFile() &&
        (await hashFile(target)) === expected
      ) {
        const signature = await verifyUpdateSignature(target)
        if (signature.ok) {
          downloadedFile = target
          logger.info(`更新包已存在且校验通过，直接复用: ${target}`)
          return { path: target, size: size || 0, reused: true }
        }
        logger.warn(`本地更新包验签失败，删除后重新下载: ${signature.error}`)
        await fsp.rm(target, { force: true }).catch(() => {})
      }
    } catch {
      /* 不存在，走下载 */
    }

    // OP-06：探测可续传的已下载部分。只有体积小于目标（已知时）才续传；
    // 否则视为陈旧/越界残留，清理后从头下载。
    let resumeFrom = 0
    const partStat = await fsp.stat(partPath).catch(() => null)
    if (
      partStat?.isFile() &&
      partStat.size > 0 &&
      (!Number.isFinite(size) || !size || partStat.size < size)
    ) {
      resumeFrom = partStat.size
    } else if (partStat) {
      await fsp.rm(partPath, { force: true }).catch(() => {})
    }

    // 流式下载：边写临时文件边计算哈希（免二次读盘），进度节流推送。
    // 续传时先把已下载部分流式喂入哈希，保证最终校验覆盖完整包。
    let hash = createHash('sha256')
    let received = 0
    let lastSent = 0
    if (resumeFrom > 0) {
      try {
        await updateHashFromFile(hash, partPath)
        received = resumeFrom
      } catch {
        // 已下载部分不可读：丢弃后从头开始
        resumeFrom = 0
        await fsp.rm(partPath, { force: true }).catch(() => {})
      }
    }
    let writeFlag = resumeFrom > 0 ? 'a' : 'w'
    const response = await fetchUpdateUrlReliably(downloadUrl, () => ({
      signal: downloadAbort.signal,
      ...(resumeFrom > 0 ? { headers: { Range: `bytes=${resumeFrom}-` } } : {}),
    }))
    if (resumeFrom > 0 && response.status === 416) {
      await fsp.rm(partPath, { force: true }).catch(() => {})
      return { error: '断点续传位置无效，临时文件已清理，请重试下载' }
    }
    if (resumeFrom > 0 && response.status !== 206) {
      // 服务端忽略 Range（返回 200 全量）：丢弃旧分片，从头覆盖
      logger.info('更新服务端不支持断点续传，改为从头下载')
      resumeFrom = 0
      received = 0
      writeFlag = 'w'
      hash = createHash('sha256')
    }
    if (!response.ok || !response.body) {
      return { error: `更新包下载失败（HTTP ${response.status}）` }
    }
    // 206 的 content-length 为剩余字节；200 为完整包大小。
    // 总大小优先取 Release 声明值，但响应头本身超限也必须拒绝（V-06）。
    const declared = Number(response.headers.get('content-length')) || 0
    const total =
      response.status === 206
        ? size && size > 0
          ? size
          : resumeFrom + declared
        : declared || size
    if (
      declared > MAX_UPDATE_BYTES ||
      (Number.isFinite(total) && total > MAX_UPDATE_BYTES)
    ) {
      await fsp.rm(partPath, { force: true }).catch(() => {})
      return { error: '更新包体积异常（超过 600MB），已中止下载' }
    }
    const reader = response.body.getReader()
    const fh = await fsp.open(partPath, writeFlag)
    try {
      for (;;) {
        // OPT-17①：逐段空闲计时——持续到达的数据不断重置计时器，TCP 停滞
        // 超过 DOWNLOAD_IDLE_TIMEOUT_MS 判死中止（取消底层读取并保留 .part
        // 供续传）。总量不设限：慢链路的合法下载耗时不可预估
        const { done, value } = await raceIdleTimeout(
          reader.read(),
          DOWNLOAD_IDLE_TIMEOUT_MS,
          `更新包下载停滞超过 ${DOWNLOAD_IDLE_TIMEOUT_MS / 1000}s 无数据，已中止（已下载部分保留，可续传）`,
          () => {
            reader.cancel().catch(() => {})
          },
        )
        if (done) break
        received += value.byteLength
        if (received > MAX_UPDATE_BYTES) {
          await fsp.rm(partPath, { force: true }).catch(() => {})
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
      await fsp.rm(partPath, { force: true }).catch(() => {})
      logger.warn(`更新包校验和不匹配: 期望 ${expected} 实际 ${actual}`)
      return { error: '校验和不匹配，下载可能损坏或被篡改，已放弃本次下载' }
    }
    // E1：哈希通过后再验 Authenticode（配置了发布者指纹时强制有效且指纹一致）
    const signature = await verifyUpdateSignature(partPath)
    if (!signature.ok) {
      await fsp.rm(partPath, { force: true }).catch(() => {})
      logger.warn(`更新包验签失败: ${signature.error}`)
      return { error: signature.error }
    }
    if (signature.required) {
      logger.info(`更新包验签通过（${signature.thumbprint}）`)
    }
    // 原子落盘：先移除旧包再改名（Windows rename 对已存在目标不可靠）
    await fsp.rm(target, { force: true }).catch(() => {})
    await fsp.rename(partPath, target)
    downloadedFile = target
    logger.info(`更新包下载完成并通过校验: ${target}（${received} 字节）`)
    return { path: target, size: received }
  } catch (err) {
    // OP-06：网络中断/用户取消时保留 .part 供下次续传；校验失败/体积异常
    // 已在对应分支显式删除，不会留下不可信分片。
    if (err instanceof Error && err.name === 'AbortError') {
      logger.info('更新包下载已取消（已下载部分保留，可续传）')
      return { canceled: true }
    }
    // OPT-17①：空闲超时判死——.part 同样保留供续传，错误文案已自带
    // 「已下载部分保留」说明，不再叠加「更新包下载失败」前缀
    if (err instanceof Error && err.name === 'TimeoutError') {
      logger.warn(`更新包下载停滞中止: ${err.message}`)
      return { error: err.message }
    }
    logger.warn(`更新包下载失败: ${errorMessage(err) || err}`)
    return { error: `更新包下载失败: ${errorMessage(err) || err}` }
  } finally {
    downloadAbort = null
  }
}

/** 取消进行中的下载（空闲时为 no-op） */
export function cancelUpdateDownload() {
  downloadAbort?.abort()
  return { ok: true }
}
