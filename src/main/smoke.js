import { app, BrowserWindow, protocol } from 'electron'
import fs from 'node:fs/promises'
import logger from './logger'

/**
 * 启动冒烟检查（V-05，仅 MODELVAULT_SMOKE=1 时由 index.js 调用）：
 * 验证「产物能启动」这条最容易在打包后才暴露的链路——
 * 主窗口创建、生产页面加载、preload 桥接、IPC 往返、自定义图片协议注册。
 *
 * 结果写入 MODELVAULT_SMOKE_RESULT 指向的 JSON 文件（scripts/smoke.mjs 读取），
 * 成功后 app.exit(0)，任一检查失败 app.exit(1)。该模块不参与正常启动流程。
 */

/** 单项检查超时（页面加载/executeJavaScript 共用） */
const CHECK_TIMEOUT_MS = 20000
/** 整体兜底超时：任何卡死都必须让 CI 拿到明确失败而非挂起 */
const TOTAL_TIMEOUT_MS = 40000

/** 等待一个 Promise，超时 reject */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时`)), ms)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * 等待渲染页面加载完成（已加载时立即返回）。
 * @param {import('electron').BrowserWindow} win 主窗口
 * @returns {Promise<void>}
 */
function waitForRendererLoad(win) {
  const wc = win.webContents
  if (!wc.isLoadingMainFrame() && wc.getURL()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('渲染页面加载超时'))
    }, CHECK_TIMEOUT_MS)
    const onLoad = () => {
      cleanup()
      resolve()
    }
    const onFail = (_event, code, desc) => {
      cleanup()
      reject(new Error(`渲染页面加载失败 [${code}] ${desc}`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      wc.removeListener('did-finish-load', onLoad)
      wc.removeListener('did-fail-load', onFail)
    }
    wc.once('did-finish-load', onLoad)
    wc.once('did-fail-load', onFail)
  })
}

/**
 * 执行启动冒烟检查并退出进程。
 * @param {import('electron').BrowserWindow} win 主窗口
 */
export async function runStartupSmoke(win) {
  /** @type {Array<{name: string, ok: boolean, detail?: string}>} */
  const checks = []
  let finished = false

  const finish = async (error = null) => {
    if (finished) return
    finished = true
    const ok = !error && checks.every((c) => c.ok)
    const payload = {
      ok,
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      usedPackagedRenderer: app.isPackaged,
      checks,
      error: error ? String(error.stack || error.message || error) : ''
    }
    const resultPath = process.env.MODELVAULT_SMOKE_RESULT
    if (resultPath) {
      try {
        await fs.writeFile(resultPath, JSON.stringify(payload, null, 2), 'utf-8')
      } catch (writeErr) {
        logger.error(`冒烟结果写入失败: ${writeErr.message}`)
      }
    }
    if (ok) {
      logger.info(`启动冒烟通过: ${checks.map((c) => c.name).join(', ')}`)
      process.stdout.write('MODELVAULT_SMOKE_OK\n')
    } else {
      logger.error(`启动冒烟失败: ${error?.message || checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}`)
      process.stdout.write('MODELVAULT_SMOKE_FAIL\n')
    }
    // 冒烟使用独立 userData，直接退出即可（无需等待业务落盘）
    app.exit(ok ? 0 : 1)
  }

  const failsafe = setTimeout(() => {
    void finish(new Error('启动冒烟总超时'))
  }, TOTAL_TIMEOUT_MS)
  failsafe.unref?.()

  try {
    await waitForRendererLoad(win)

    checks.push({
      name: 'main-window',
      ok: !win.isDestroyed() && win.getTitle().length > 0,
      detail: `title=${win.isDestroyed() ? '<destroyed>' : win.getTitle()}`
    })

    const url = win.isDestroyed() ? '' : win.webContents.getURL()
    checks.push({
      name: 'renderer-loaded',
      ok: /[/\\]renderer[/\\]index\.html(?:[?#].*)?$/.test(url),
      detail: url
    })

    const protocolOk = protocol.isProtocolHandled('mvimg') && protocol.isProtocolHandled('civimg')
    checks.push({ name: 'image-protocol', ok: protocolOk })

    // 完整走一遍 contextBridge → preload 白名单 → IPC schema → handler
    const info = await withTimeout(
      win.webContents.executeJavaScript(
        `(async () => {
          if (!window.api || typeof window.api.app?.getInfo !== 'function') return null
          return window.api.app.getInfo()
        })()`,
        true
      ),
      CHECK_TIMEOUT_MS,
      'IPC 往返检查'
    )
    checks.push({
      name: 'preload-ipc',
      ok: Boolean(info && typeof info.version === 'string' && info.electron),
      detail: info ? `version=${info.version} electron=${info.electron}` : 'window.api 不可用'
    })

    const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    checks.push({
      name: 'window-count',
      ok: windows.length >= 1,
      detail: `windows=${windows.length}`
    })

    clearTimeout(failsafe)
    await finish()
  } catch (err) {
    clearTimeout(failsafe)
    await finish(err)
  }
}
