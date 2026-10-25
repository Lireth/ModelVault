import { createHash } from 'node:crypto'
/* global __MODELVAULT_SIGNER_THUMBPRINT__ */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { app, net } from 'electron'
import logger from '../logger'
import { isAllowedExternalUrl, readResponseTextLimited } from '../utils'

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
/** 校验和/元信息请求超时（ms） */
const REQUEST_TIMEOUT_MS = 15000
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
  'github-releases.githubusercontent.com'
])
/** 重定向跟随上限（V-06：每一跳重新校验主机） */
const MAX_REDIRECTS = 5
/** 版本号白名单（V-06）：只允许纯数字三段，杜绝路径分隔符/命令字符进入文件名 */
const VERSION_PATTERN = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/
/** 进度推送节流间隔（ms） */
const PROGRESS_INTERVAL_MS = 200
/** 拉起新实例后退出当前实例的延迟（ms），给 spawn 完成进程创建留出时间 */
const QUIT_DELAY_MS = 500
/** Authenticode 验签子进程超时（ms）：PowerShell 冷启动 + 大 EXE 解析留足余量 */
const SIGNATURE_CHECK_TIMEOUT_MS = 20000
/**
 * 构建期注入的签名者证书 SHA1 指纹（E1）：
 * - release CI 设置 MODELVAULT_SIGNER_THUMBPRINT 后由 Vite define 注入；
 * - 未配置（本地开发/未签名发布）时为空串，验签策略退化为仅 SHA256；
 * - 配置后强制要求更新包 Authenticode 状态 Valid 且指纹一致。
 */
const BUILD_SIGNER_THUMBPRINT = /** @type {string} */ (
  // @ts-ignore 构建期常量：release CI 经 Vite define 注入该全局标识符，类型层面不声明
  typeof __MODELVAULT_SIGNER_THUMBPRINT__ === 'string' ? __MODELVAULT_SIGNER_THUMBPRINT__ : ''
)

/** 测试钩子：替换 PowerShell 查询结果（避免单测依赖真实证书/系统命令） */
let authenticodeQueryOverride = null
/** 测试钩子：覆盖预期签名指纹 */
let signerThumbprintOverride = null

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
 * 版本号是否可用于拼接文件名（V-06）。
 * 更新包路径由 `ModelVault-${latest}.exe` 生成，latest 来自 API 响应，
 * 必须限定纯数字三段，避免 `../`、命令行分隔符等进入路径。
 * @param {unknown} version 版本号（不含 v 前缀）
 * @returns {boolean}
 */
export function isSafeUpdateVersion(version) {
  return typeof version === 'string' && VERSION_PATTERN.test(version)
}

/** 是否为需要跟随的 HTTP 重定向状态 */
function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** Electron 网络栈对 fetch manual 重定向不支持时的特征错误 */
function isRedirectCancelledError(err) {
  return err instanceof Error && err.message.includes('Redirect was cancelled')
}

/**
 * 更新链路 URL 白名单（V-06）：https + GitHub 页面/API/Release 资产 CDN。
 * @param {unknown} url 待校验 URL
 * @returns {boolean}
 */
function isAllowedUpdateHost(url) {
  try {
    const parsed = new URL(String(url))
    return parsed.protocol === 'https:' && ALLOWED_UPDATE_HOSTS.has(parsed.hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * 探测一跳重定向目标（Electron 兼容层）：
 * net.fetch 的 redirect:'manual' 在 Electron 网络栈中不被支持——上游返回
 * 3xx 时直接以 "Redirect was cancelled"（ERR_REDIRECT_CANCELLED）抛错，
 * 而非规范语义的不透明响应（Location 不可读）。GitHub Release 资产
 * 必经 302 跳转 CDN，缺失该兜底时更新下载必然失败。这里改用 net.request
 * 的 manual 模式：redirect 事件读出跳转目标后立即取消请求，主传输仍走
 * net.fetch（流式 body / 超时/续传信号语义不变）。与 civitai.js 的同名
 * 兜底保持同构（后续网络工具收敛的合并候选）。
 * @param {string} url 当前跳点 URL（调用方已校验白名单）
 * @param {RequestInit} options 与主请求一致的选项（headers/signal）
 * @returns {Promise<{status: number, location: string, headers: Headers}>}
 */
function probeRedirectTarget(url, options) {
  return new Promise((resolve, reject) => {
    // HeadersInit → net.request 要求的普通头记录（Range 等简单值单值字符串
    // 化即可；探测请求不携带 body，无多值头语义）。不携带会话 Cookie——
    // 更新链路为公开资产下载，与 net.fetch 默认凭据语义保持一致
    const headersRecord = {}
    for (const [name, value] of new Headers(options.headers || {})) {
      headersRecord[name] = value
    }
    const request = net.request({
      method: 'GET',
      url,
      redirect: 'manual',
      useSessionCookies: false,
      headers: headersRecord
    })
    let settled = false
    const finish = (ok, value) => {
      if (settled) return
      settled = true
      ok ? resolve(value) : reject(value)
    }
    /** Electron 响应头对象（Record<string, string|string[]>）→ Headers */
    const headersOf = (record) => {
      const headers = new Headers()
      for (const [name, values] of Object.entries(record || {})) {
        for (const value of [].concat(values)) headers.append(name, value)
      }
      return headers
    }
    request.on('redirect', (statusCode, _method, redirectUrl, responseHeaders) => {
      const headers = headersOf(responseHeaders)
      // ClientRequest 的取消方法是 abort（无 cancel/destroy；用可选链防御
      // Electron 版本 API 差异，避免事件处理器内抛错演变成主进程致命错误）
      request.abort?.()
      finish(true, {
        status: statusCode,
        location: headers.get('location') || redirectUrl || '',
        headers
      })
    })
    request.on('response', (incoming) => {
      // 未发 redirect 事件直接拿到响应（3xx 且无跳转目标等）：按终态返回空体
      // （IncomingMessage 无 destroy 方法，经 request.abort 中止 body 传输）
      request.abort?.()
      finish(true, {
        status: incoming.statusCode || 0,
        location: '',
        headers: headersOf(incoming.headers)
      })
    })
    request.on('error', (err) => finish(false, err))
    const { signal } = options
    if (signal) {
      if (signal.aborted) {
        request.abort?.()
        finish(false, new DOMException('已终止', 'AbortError'))
        return
      }
      signal.addEventListener('abort', () => {
        request.abort?.()
        finish(false, new DOMException('已终止', 'AbortError'))
      }, { once: true })
    }
    request.end()
  })
}

/**
 * 发起更新相关请求并手动跟随重定向（V-06）：
 * net.fetch 默认跟随 302 时只校验初始 URL，白名单主机可把请求引向任意
 * 站点。此处每一跳都校验主机，超出次数上限即失败。Electron 网络栈对
 * manual 模式不支持（3xx 直接抛 "Redirect was cancelled"，Location 不可
 * 读），此时经 probeRedirectTarget 探测跳转目标后逐跳继续。
 * @param {string} url 初始 URL（调用方已校验）
 * @param {RequestInit} options fetch 选项
 * @returns {Promise<Response>} 最终响应
 */
export async function fetchAllowedUpdateUrl(url, options) {
  if (!isAllowedUpdateHost(url)) {
    throw new Error('更新下载地址不在 GitHub 白名单内，已拒绝')
  }
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response
    try {
      response = await net.fetch(current, { ...options, redirect: 'manual' })
    } catch (err) {
      if (!isRedirectCancelledError(err)) throw err
      const probe = await probeRedirectTarget(current, options)
      // 无跳转目标的 3xx 按终态响应处理（调用方按非 ok 分支报错，与
      // 规范的 manual 语义一致；body 恒为空——3xx 本就无有效载荷）
      response = new Response('', { status: probe.status, headers: probe.headers })
    }
    if (!isRedirectStatus(response.status)) return response
    const location = response.headers.get('location')
    if (!location) return response
    const next = new URL(location, current).toString()
    if (!isAllowedUpdateHost(next)) {
      throw new Error('更新下载重定向目标不在 GitHub 白名单内，已拒绝')
    }
    current = next
  }
  throw new Error('更新下载重定向次数过多，已拒绝')
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
  await updateHashFromFile(hash, filePath)
  return hash.digest('hex').toLowerCase()
}

/** 把文件内容流式喂入既有 hash（续传时先补齐已下载部分的哈希状态） */
async function updateHashFromFile(hash, filePath) {
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
}

/** 证书指纹规范化：去分隔符并统一大写（Get-AuthenticodeSignature 输出带空格） */
export function normalizeThumbprint(value) {
  return String(value || '').replace(/[^a-fA-F0-9]/g, '').toUpperCase()
}

/** 当前签名者指纹原始值：测试覆盖 > 运行期环境变量 > 构建期注入 */
function signerThumbprintSetting() {
  return String(
    signerThumbprintOverride ||
      process.env.MODELVAULT_SIGNER_THUMBPRINT ||
      BUILD_SIGNER_THUMBPRINT ||
      ''
  ).trim()
}

/**
 * 评估 Authenticode 查询结果（纯函数，便于单测）：
 * - Status 必须为 Valid（证书链可信、文件未篡改）；
 * - 指纹必须与预期发布者一致（配置了预期指纹时）。
 * @param {{status?: string, thumbprint?: string, subject?: string}|null} info
 * @param {string} expectedThumbprint 规范化后的预期指纹
 * @returns {{ok: true, required: true, thumbprint: string, subject: string} |
 *   {ok: false, required: true, error: string}}
 */
export function evaluateUpdateSignature(info, expectedThumbprint) {
  if (!info) {
    return { ok: false, required: true, error: '无法读取更新包数字签名（PowerShell 不可用或超时）' }
  }
  const status = String(info.status || 'Unknown')
  if (status !== 'Valid') {
    return { ok: false, required: true, error: `更新包数字签名无效（${status}）` }
  }
  const thumbprint = normalizeThumbprint(info.thumbprint)
  if (!thumbprint || thumbprint !== expectedThumbprint) {
    return { ok: false, required: true, error: '更新包签名者与预期发布者不一致' }
  }
  return {
    ok: true,
    required: true,
    thumbprint,
    subject: typeof info.subject === 'string' ? info.subject : ''
  }
}

/** PowerShell 查询脚本：路径经环境变量传入，避免命令拼接注入 */
const AUTHENTICODE_QUERY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$sig = Get-AuthenticodeSignature -LiteralPath $env:MODELVAULT_VERIFY_PATH
$cert = $sig.SignerCertificate
$thumb = ''
$subject = ''
if ($cert) {
  $thumb = [string]$cert.Thumbprint
  $subject = [string]$cert.Subject
}
[pscustomobject]@{
  status = [string]$sig.Status
  thumbprint = $thumb
  subject = $subject
} | ConvertTo-Json -Compress
`

/**
 * 调用 PowerShell Get-AuthenticodeSignature 查询签名信息。
 * @param {string} filePath 待校验 EXE
 * @returns {Promise<{status:string, thumbprint:string, subject:string}|null>}
 */
function queryAuthenticode(filePath) {
  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    let timer = null
    let child = null
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          AUTHENTICODE_QUERY_SCRIPT
        ],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, MODELVAULT_VERIFY_PATH: filePath }
        }
      )
    } catch {
      finish(null)
      return
    }
    timer = setTimeout(() => {
      try {
        child?.kill()
      } catch {
        /* 进程已退出 */
      }
      finish(null)
    }, SIGNATURE_CHECK_TIMEOUT_MS)
    timer.unref?.()
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
      if (stdout.length > 256 * 1024) {
        try {
          child.kill()
        } catch {
          /* 进程已退出 */
        }
        finish(null)
      }
    })
    // stderr 必须消费：$ErrorActionPreference='Stop' 下 cmdlet 抛错时
    // PowerShell 向 stderr 写错误流，stdio 两路 pipe 中仅消费 stdout 的
    // 话，stderr 管道缓冲写满会阻塞子进程——只能等 20s 超时返回 null
    // （被解读为「PowerShell 不可用」），且丢失真实错误现场。截尾保留
    // 最近输出，失败时写入日志辅助排查
    let stderrTail = ''
    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2048)
    })
    const recentStderr = () => stderrTail.trim().replace(/\s+/g, ' ').slice(0, 300)
    child.once('error', () => finish(null))
    child.once('exit', (code) => {
      if (code !== 0) {
        if (stderrTail) {
          logger.warn(`PowerShell 验签异常退出（code ${code}）: ${recentStderr()}`)
        }
        finish(null)
        return
      }
      try {
        // PowerShell 管道可能带 UTF-8 BOM，先剥离再解析
        const parsed = JSON.parse(stdout.replace(/^\uFEFF/, '').trim())
        finish(parsed && typeof parsed === 'object' ? parsed : null)
      } catch {
        if (stderrTail) {
          logger.warn(`PowerShell 验签输出解析失败: ${recentStderr()}`)
        }
        finish(null)
      }
    })
  })
}

/**
 * 校验更新包 Authenticode 签名（E1）：
 * 未配置预期签名指纹时退化为仅 SHA256（保持未签名发布可更新）；
 * 配置后强制 Valid + 指纹匹配，任何异常均 fail-closed。
 * @param {string} filePath 更新包路径
 * @returns {Promise<{ok: boolean, required: boolean, thumbprint?: string,
 *   subject?: string, error?: string}>}
 *   ok=false 时 error 必有值（fail-closed）
 */
export async function verifyUpdateSignature(filePath) {
  const rawExpected = signerThumbprintSetting()
  if (!rawExpected) return { ok: true, required: false }
  const expected = normalizeThumbprint(rawExpected)
  // 配置了值但不是合法 SHA1/SHA256 十六进制指纹：fail-closed，不能静默退化
  if (expected.length !== 40 && expected.length !== 64) {
    return { ok: false, required: true, error: '发布者签名指纹配置无效' }
  }
  if (process.platform !== 'win32') {
    return { ok: false, required: true, error: '更新包验签仅支持 Windows' }
  }
  if (!filePath || typeof filePath !== 'string') {
    return { ok: false, required: true, error: '更新包路径无效' }
  }
  try {
    const info = authenticodeQueryOverride
      ? await authenticodeQueryOverride(filePath)
      : await queryAuthenticode(filePath)
    return evaluateUpdateSignature(info, expected)
  } catch (err) {
    return {
      ok: false,
      required: true,
      error: `更新包验签失败: ${err instanceof Error ? err.message : String(err)}`
    }
  }
}

/* ---------------- 仅供单元测试使用 ---------------- */

/** 注入 Authenticode 查询结果（传 null 恢复真实 PowerShell 查询） */
export function setAuthenticodeQueryForTests(fn) {
  authenticodeQueryOverride = typeof fn === 'function' ? fn : null
}

/** 覆盖预期签名指纹（传空恢复构建期/环境配置） */
export function setSignerThumbprintForTests(value) {
  signerThumbprintOverride = typeof value === 'string' && value ? value : null
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
      return { error: `创建更新目录失败: ${err.message}` }
    }

    // 校验和：expected = sha256sum 兼容文件首 token。
    // 重定向逐跳校验 + 文本大小上限（V-06）
    let expected
    try {
      const res = await fetchAllowedUpdateUrl(checksumUrl, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      if (!res.ok) return { error: `校验和下载失败（HTTP ${res.status}）` }
      expected = parseChecksumHash(
        await readResponseTextLimited(res, MAX_CHECKSUM_BYTES, '校验和文件')
      )
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        return { error: '校验和下载超时，请检查网络后重试' }
      }
      return { error: `校验和下载失败: ${err.message}` }
    }
    if (!expected) return { error: '校验和文件格式异常' }

    // 本地已有完整包（上次下载完成但未安装）：哈希命中且验签通过才复用
    try {
      if ((await fsp.stat(target)).isFile() && (await hashFile(target)) === expected) {
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
    const response = await fetchAllowedUpdateUrl(downloadUrl, {
      signal: downloadAbort.signal,
      ...(resumeFrom > 0 ? { headers: { Range: `bytes=${resumeFrom}-` } } : {})
    })
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
    if (declared > MAX_UPDATE_BYTES || (Number.isFinite(total) && total > MAX_UPDATE_BYTES)) {
      await fsp.rm(partPath, { force: true }).catch(() => {})
      return { error: '更新包体积异常（超过 600MB），已中止下载' }
    }
    const reader = response.body.getReader()
    const fh = await fsp.open(partPath, writeFlag)
    try {
      for (;;) {
        const { done, value } = await reader.read()
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
 * 运行更新程序：拉起新 EXE 并退出当前实例。
 * 新实例携带 `--wait-for-pid=<当前 pid>`，启动时先等待旧实例退出并释放
 * 单实例锁，再正常启动（见 main/index.js 与 utils.waitForProcessExit）。
 *
 * 安全（V-06）：
 * - 不经过 cmd/start，路径作为 spawn 的参数直接传递，无命令拼接注入面；
 * - 仅接受本服务下载并校验通过、且位于 update 目录、文件名符合版本白名单的路径；
 * - E1：启动前再次校验 Authenticode（防止下载后文件被替换），配置了
 *   发布者指纹时失败即拒绝执行。
 * @returns {Promise<{ok: true} | {error: string}>}
 */
export async function installUpdatePackage() {
  const file = downloadedFile
  if (!file) return { error: '尚未下载更新包，请先下载更新' }
  const dir = getUpdateDir()
  const resolved = path.resolve(file)
  const inUpdateDir = resolved.toLowerCase().startsWith(`${dir.toLowerCase()}${path.sep}`)
  if (!inUpdateDir || !/^ModelVault-\d{1,5}\.\d{1,5}\.\d{1,5}\.exe$/.test(path.basename(resolved))) {
    logger.warn(`拒绝启动更新目录之外的更新包: ${resolved}`)
    return { error: '更新包路径异常，请重新下载更新' }
  }
  try {
    if (!fs.statSync(resolved).isFile()) {
      return { error: '更新包不存在，请重新下载更新' }
    }
  } catch {
    return { error: '更新包不存在，请重新下载更新' }
  }
  // 安装前复核签名：覆盖「下载后文件被替换」的窗口
  const signature = await verifyUpdateSignature(resolved)
  if (!signature.ok) {
    logger.warn(`拒绝启动验签失败的更新包: ${signature.error}`)
    return { error: signature.error }
  }
  try {
    const child = spawn(resolved, [`--wait-for-pid=${process.pid}`], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore'
    })
    child.once('error', (err) => {
      logger.warn(`更新程序启动失败: ${err.message}`)
    })
    child.unref()
  } catch (err) {
    logger.warn(`更新程序启动失败: ${err.message}`)
    return { error: `启动更新程序失败: ${err.message}` }
  }
  logger.info(`已拉起更新程序（等待当前实例退出）: ${resolved}`)
  setTimeout(() => app.quit(), QUIT_DELAY_MS)
  return { ok: true }
}
