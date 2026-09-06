import { BrowserWindow } from 'electron'
import logger from './logger'

/**
 * 应用不显示原生菜单栏（如需恢复，可用 Menu.setApplicationMenu 构建菜单）。
 * 为避免移除菜单后快捷键失效，此处通过 before-input-event
 * 在窗口级别注册常用快捷键。
 */

/**
 * 为窗口注册快捷键（替代原生菜单的 accelerator）。
 * @param {BrowserWindow} win 目标窗口
 */
export function registerWindowShortcuts(win) {
  if (!win) return

  win.webContents.on('before-input-event', (event, input) => {
    // 仅处理按键按下，忽略带鼠标修饰的事件
    if (input.type !== 'keyDown') return

    const ctrl = input.control
    const shift = input.shift
    const key = input.key.toLowerCase()

    // Ctrl+Shift+I 开发者工具
    if (ctrl && shift && key === 'i') {
      win.webContents.toggleDevTools()
      event.preventDefault()
      return
    }
    // Ctrl+R 重新加载
    if (ctrl && !shift && key === 'r') {
      win.webContents.reload()
      event.preventDefault()
      return
    }
    // Ctrl+Shift+R 强制重新加载
    if (ctrl && shift && key === 'r') {
      win.webContents.reloadIgnoringCache()
      event.preventDefault()
      return
    }
    // F11 全屏切换
    if (key === 'f11') {
      win.setFullScreen(!win.isFullScreen())
      event.preventDefault()
    }
  })

  logger.info('窗口快捷键注册完成（无原生菜单栏模式）')
}
