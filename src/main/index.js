import { app, Menu, dialog, shell } from 'electron'
import { createMainWindow, getMainWindow, loadWindowState } from './windows/mainWindow'
import { registerWindowShortcuts } from './menu'
import { registerIpcHandlers } from './ipc'
import { registerImageScheme, registerImageProtocolHandler } from './protocol'
import { loadSettings } from './services/store'
import { quitAfterFlush } from './quit'
import { handleUncaughtException } from './fatal-error'
import { runStartupSmoke } from './smoke'
import { isAllowedExternalUrl, parseWaitForPid, waitForProcessExit } from './utils'
import logger from './logger'

// 启动冒烟使用独立 userData，避免污染真实用户配置与单实例锁
if (process.env.MODELVAULT_SMOKE === '1' && process.env.MODELVAULT_SMOKE_USER_DATA) {
  app.setPath('userData', process.env.MODELVAULT_SMOKE_USER_DATA)
}

// 自定义协议必须在 app ready 之前注册
registerImageScheme()

// Windows 任务栏分组/跳转列表标识（与 electron-builder.yml 的 appId 一致）
app.setAppUserModelId('com.modelvault.app')

/**
 * 全局错误处理分级策略（A3）：
 * - uncaughtException：异常后进程状态（防抖落盘链/目录监控/扫描任务）已不可信，
 *   带病续跑有元数据丢失风险——记录日志 -> 尽力落盘 -> 提示用户 -> 重启；
 *   处理函数自身异常时兜底直接重启，保证流程必然完成
 * - unhandledRejection：维持仅记录（多数为可恢复的异步业务错误，
 *   渲染进程异常另有 app:reportError 通道上报）
 */
process.on('uncaughtException', (error) => {
  handleUncaughtException(error).catch((err) => {
    logger.error(`致命错误处理失败: ${err.stack || err.message}`)
    app.relaunch()
    app.exit(1)
  })
})

process.on('unhandledRejection', (reason) => {
  logger.error(`未处理的 Promise 拒绝: ${reason instanceof Error ? reason.stack : String(reason)}`)
})

/**
 * 单实例锁：确保 Windows 下同一时刻只运行一个应用实例。
 * 更新安装拉起的新实例带 --wait-for-pid=<旧 pid>（V-06）：先等待旧实例
 * 退出释放锁，再申请单实例锁，避免“更新后新版本闪退”。
 */
async function startApp() {
  const waitPid = parseWaitForPid(process.argv)
  if (waitPid) {
    logger.info(`更新启动：等待上一实例退出（pid=${waitPid}）`)
    const exited = await waitForProcessExit(waitPid, { timeoutMs: 15000 })
    if (!exited) logger.warn(`等待上一实例超时，继续尝试启动（pid=${waitPid}）`)
  }

  const gotSingleInstanceLock = app.requestSingleInstanceLock()
  if (!gotSingleInstanceLock) {
    logger.warn('检测到已有实例在运行，当前实例即将退出')
    app.quit()
    return
  }

  // 第二实例启动时，聚焦已有窗口
  app.on('second-instance', () => {
    const win = getMainWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    // 移除原生菜单栏（不设置则 Electron 会启用默认英文菜单）
    Menu.setApplicationMenu(null)
    // 仅注册窗口级快捷键
    registerImageProtocolHandler()
    registerIpcHandlers()

    // 启动链路并行化（OP-01）：设置与窗口状态互不依赖，并行读取后再一次性
    // 创建窗口，缩短首屏前的串行 IO 等待。
    const [, windowState] = await Promise.all([loadSettings(), loadWindowState()])

    const win = await createMainWindow(windowState)
    registerWindowShortcuts(win)

    // 阻止在应用内打开新窗口：http(s) 外链交给系统默认浏览器；
    // 其余协议（file:/smb:/自定义协议等）一律拒绝并记日志，防止渲染进程
    // 被注入后构造任意协议 URL 唤起系统处理程序
    win.webContents.setWindowOpenHandler(({ url }) => {
      // 外链拉起收敛到域名白名单（B3）：渲染进程可控的 window.open
      // 不得打开任意 https 站点；URL 来自渲染进程，日志截断防止
      // 不可信长串写入
      if (isAllowedExternalUrl(url)) {
        shell.openExternal(url)
      } else {
        logger.warn(`已拦截非白名单外链打开请求: ${String(url).slice(0, 200)}`)
      }
      return { action: 'deny' }
    })

    logger.info(`应用启动完成 (Electron ${process.versions.electron} / Node ${process.versions.node})`)

    // 冒烟模式：完成启动链路检查后自行退出（仅 CI/手工 smoke 设置该环境变量）
    if (process.env.MODELVAULT_SMOKE === '1') {
      void runStartupSmoke(win)
    }
  }).catch((error) => {
    logger.error(`应用初始化失败: ${error.stack || error.message}`)
    // 冒烟模式不弹模态框：CI 无人工关闭，会表现为挂起而非明确失败
    if (process.env.MODELVAULT_SMOKE !== '1') {
      dialog.showErrorBox('模匣 启动失败', String(error?.message || error))
    }
    app.quit()
  })
}

void startApp()

// Windows 平台惯例：所有窗口关闭后退出应用（退出编排见 quit.js：
// 停监控 -> 等两路落盘 -> quit，落盘超时强制退出，A4）
app.on('window-all-closed', () => {
  quitAfterFlush()
})
