import { BrowserWindow, ipcMain } from 'electron'
import logger from '../../logger'
import { exportBackup, importBackup } from '../../services/backup'

/**
 * 备份与恢复链路（FEAT-3）：
 * 导出（设置 + 当前库标注/封面 → zip）与恢复（zip → 设置 + 指定库）。
 * 对话框与覆盖确认均在主进程经原生 API 完成，渲染进程一次调用拿结果。
 */

/** 注册备份与恢复链路的 IPC 处理器 */
export function registerBackupHandlers() {
  // 导出备份：返回 { path, sizeBytes, library, models, covers } / { canceled } / { error }
  ipcMain.handle('models:exportBackup', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const res = await exportBackup(win)
    if (res.error) {
      logger.warn(`备份导出失败: ${res.error}`)
    } else if (!res.canceled) {
      logger.info(`备份已导出: ${res.path}（${res.models} 模型 / ${res.covers} 封面）`)
    }
    return res
  })

  // 从备份恢复：返回 { settingsRestored, libraryRestored? } / { canceled } / { error }
  ipcMain.handle('models:importBackup', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const res = await importBackup(win)
    if (res.error) {
      logger.warn(`备份恢复失败: ${res.error}`)
    } else if (!res.canceled) {
      logger.info(`备份已恢复: 设置=${res.settingsRestored} 库=${res.libraryRestored?.root || '无'}`)
    }
    return res
  })
}
