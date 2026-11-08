/* global __MODELVAULT_SIGNER_THUMBPRINT__ */
import { spawn } from 'node:child_process'
import logger from '../logger'

/**
 * 更新包校验（自 update-download.js 拆出）：
 * - 校验和文件解析（sha256sum 兼容）；
 * - Authenticode 签名查询与策略评估（E1）；
 * - 验签失败一律 fail-closed（配置了指纹时不允许静默退化）。
 */

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
  typeof __MODELVAULT_SIGNER_THUMBPRINT__ === 'string'
    ? // @ts-ignore 同一构建期全局标识符的条件分支引用
      __MODELVAULT_SIGNER_THUMBPRINT__
    : ''
)

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

/** 证书指纹规范化：去分隔符并统一大写（Get-AuthenticodeSignature 输出带空格） */
export function normalizeThumbprint(value) {
  return String(value || '')
    .replace(/[^a-fA-F0-9]/g, '')
    .toUpperCase()
}

/** 当前签名者指纹原始值：运行期环境变量 > 构建期注入 */
function signerThumbprintSetting() {
  return String(
    process.env.MODELVAULT_SIGNER_THUMBPRINT || BUILD_SIGNER_THUMBPRINT || '',
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
    return {
      ok: false,
      required: true,
      error: '无法读取更新包数字签名（PowerShell 不可用或超时）',
    }
  }
  const status = String(info.status || 'Unknown')
  if (status !== 'Valid') {
    return {
      ok: false,
      required: true,
      error: `更新包数字签名无效（${status}）`,
    }
  }
  const thumbprint = normalizeThumbprint(info.thumbprint)
  if (!thumbprint || thumbprint !== expectedThumbprint) {
    return {
      ok: false,
      required: true,
      error: '更新包签名者与预期发布者不一致',
    }
  }
  return {
    ok: true,
    required: true,
    thumbprint,
    subject: typeof info.subject === 'string' ? info.subject : '',
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
          AUTHENTICODE_QUERY_SCRIPT,
        ],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, MODELVAULT_VERIFY_PATH: filePath },
        },
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
    const recentStderr = () =>
      stderrTail.trim().replace(/\s+/g, ' ').slice(0, 300)
    child.once('error', () => finish(null))
    child.once('exit', (code) => {
      if (code !== 0) {
        if (stderrTail) {
          logger.warn(
            `PowerShell 验签异常退出（code ${code}）: ${recentStderr()}`,
          )
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
    const info = await queryAuthenticode(filePath)
    return evaluateUpdateSignature(info, expected)
  } catch (err) {
    return {
      ok: false,
      required: true,
      error: `更新包验签失败: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
