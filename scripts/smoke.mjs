import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

/**
 * 启动冒烟/E2E 运行器（V-05）：
 * - 默认目标：`npm run build` 生成的 out/ 三端产物（electron + 仓库根路径）；
 * - `--packaged`：`electron-builder --dir` 生成的 win-unpacked 可执行文件；
 * - 以独立 userData 启动应用，等待 main 进程写入检查结果 JSON 后判定成败。
 *
 * 检查项见 src/main/smoke.js：主窗口、生产页面加载、窗口可见、自定义图片协议、
 * preload → IPC 往返。任一失败或超时均以非零码退出，可直接作为 CI 门禁。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packaged = process.argv.includes('--packaged') || process.env.SMOKE_PACKAGED === '1'
const LAUNCH_TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 90000)
const MAX_LOG_CHARS = 120000

/** 读取 package.json（打包产物路径需要版本号） */
async function readPackage() {
  return JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf-8'))
}

/** 判断文件是否存在 */
async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** 解析启动命令与参数 */
async function resolveTarget() {
  if (!packaged) {
    const mainEntry = path.join(root, 'out', 'main', 'index.js')
    if (!(await exists(mainEntry))) {
      throw new Error(`未找到 ${mainEntry}，请先运行 npm run build`)
    }
    return { command: electronPath, args: ['--disable-gpu', root], label: 'out/ 编译产物' }
  }

  const pkg = await readPackage()
  // SMOKE_APP_DIR 便于本地用自定义 output 目录验证（CI 使用默认 dist/<version>/win-unpacked）
  const dir = process.env.SMOKE_APP_DIR
    ? path.resolve(root, process.env.SMOKE_APP_DIR)
    : path.join(root, 'dist', pkg.version, 'win-unpacked')
  const candidates = [
    path.join(dir, `${pkg.productName || 'ModelVault'}.exe`),
    path.join(dir, 'ModelVault.exe')
  ]
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return { command: candidate, args: ['--disable-gpu'], label: candidate }
    }
  }
  throw new Error(
    `未找到打包产物（${candidates.join(' 或 ')}），请先运行 npx electron-builder --dir`
  )
}

/** 终端输出裁剪：完整日志可能包含大量 Chromium 噪声 */
function tail(text) {
  return text.length > MAX_LOG_CHARS ? `…（前文已截断）\n${text.slice(-MAX_LOG_CHARS)}` : text
}

async function main() {
  const target = await resolveTarget()
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-smoke-'))
  const userData = path.join(tempRoot, 'userData')
  const resultPath = path.join(tempRoot, 'result.json')
  await fs.mkdir(userData, { recursive: true })

  const env = {
    ...process.env,
    MODELVAULT_SMOKE: '1',
    MODELVAULT_SMOKE_USER_DATA: userData,
    MODELVAULT_SMOKE_RESULT: resultPath,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
  }

  console.log(`[smoke] 启动目标: ${target.label}`)
  const child = spawn(target.command, target.args, {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString()
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, LAUNCH_TIMEOUT_MS)

  const exitCode = await new Promise((resolve) => {
    child.once('error', (err) => {
      stderr += `\n启动失败: ${err.message}`
      resolve(-1)
    })
    child.once('close', (code) => resolve(code ?? -1))
  })
  clearTimeout(timer)

  if (stdout.trim()) console.log(tail(stdout.trim()))
  if (stderr.trim()) console.error(tail(stderr.trim()))

  let result = null
  try {
    result = JSON.parse(await fs.readFile(resultPath, 'utf-8'))
  } catch {
    /* 结果文件缺失：下方统一按失败处理 */
  }

  await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})

  if (!result) {
    console.error(
      timedOut
        ? `[smoke] 启动超时（${LAUNCH_TIMEOUT_MS}ms），未生成检查结果`
        : `[smoke] 应用退出（code=${exitCode}）但未生成检查结果，请查看上方日志`
    )
    process.exit(1)
  }

  console.log('[smoke] 检查结果:')
  for (const check of result.checks || []) {
    console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name}${check.detail ? `  (${check.detail})` : ''}`)
  }
  if (result.error) {
    console.error(`[smoke] ${result.error}`)
  }

  if (!result.ok || exitCode !== 0) {
    console.error(`[smoke] 失败（exitCode=${exitCode}，packaged=${result.usedPackagedRenderer}）`)
    process.exit(1)
  }
  console.log(
    `[smoke] 通过（${target.label}，Electron ${result.electron}，app ${result.appVersion}）`
  )
}

main().catch((err) => {
  console.error(`[smoke] ${err.message}`)
  process.exit(1)
})
