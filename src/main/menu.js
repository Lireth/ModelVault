import { app, BrowserWindow, Menu, dialog } from 'electron'
import logger from './logger'

/**
 * 创建应用菜单与快捷键。
 * Windows 平台下菜单显示在窗口标题栏下方。
 */
export function createAppMenu() {
  const isMac = process.platform === 'darwin'

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        {
          label: '重新加载',
          accelerator: 'CmdOrCtrl+R',
          click: (_item, win) => win?.reload()
        },
        {
          label: '强制重新加载',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: (_item, win) => win?.webContents.reloadIgnoringCache()
        },
        { type: 'separator' },
        {
          label: '退出',
          accelerator: 'Alt+F4',
          click: () => app.quit()
        }
      ]
    },
    {
      label: '编辑',
      role: 'editMenu'
    },
    {
      label: '视图',
      submenu: [
        {
          label: '开发者工具',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: (_item, win) => win?.webContents.toggleDevTools()
        },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        {
          label: '全屏',
          accelerator: 'F11',
          click: (_item, win) => win?.setFullScreen(!win.isFullScreen())
        }
      ]
    },
    {
      label: '窗口',
      submenu: [
        {
          label: '最小化',
          accelerator: 'CmdOrCtrl+M',
          click: (_item, win) => win?.minimize()
        },
        {
          label: '关闭窗口',
          accelerator: 'CmdOrCtrl+W',
          click: (_item, win) => win?.close()
        }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 模匣',
          click: () => {
            const win = BrowserWindow.getFocusedWindow()
            dialog.showMessageBox(win, {
              type: 'info',
              title: '关于 模匣',
              message: 'ModelVault（模匣）',
              detail: `版本 ${app.getVersion()}\nElectron ${process.versions.electron}\nChromium ${process.versions.chrome}\nNode ${process.versions.node}`
            })
          }
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  logger.info('应用菜单已创建')
}
