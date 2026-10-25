import path from 'node:path'
import { BrowserWindow } from 'electron'
import logger from '../../logger'
import { exportBackup, importBackup } from '../../services/backup'
import {
  getCurrentRoot,
  reloadCurrentRootData,
  reloadLibrarySettings,
} from '../../services/store'
import { clearDeferredJobs } from '../../services/thumbs'
import { resetDecorateCache, awaitThumbDrain } from './model-state'
import { clearDeferredOwners } from './decorate'
import { wrapHandler } from '../handler'

/**
 * 备份与恢复链路（FEAT-3）：
 * 导出（设置 + 当前库标注/封面 → zip）与恢复（zip → 设置 + 指定库）。
 * 对话框与覆盖确认均在主进程经原生 API 完成，渲染进程一次调用拿结果。
 */

/** 注册备份与恢复链路的 IPC 处理器 */
export function registerBackupHandlers() {
  // 导出备份（FN-08 支持 full/selected/metadata 三种范围）：
  // 返回 { path, sizeBytes, library, models, covers, mode, partial } /
  // { canceled } / { error }
  wrapHandler(
    'models:exportBackup',
    async (event, payload = {}) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const res = await exportBackup(win, payload)
      if (res.error) {
        logger.warn(`备份导出失败: ${res.error}`)
      } else if (!res.canceled) {
        logger.info(
          `备份已导出（${res.mode || 'full'}）: ${res.path}（${res.models} 模型 / ${res.covers} 封面）`,
        )
      }
      return res
    },
    { errorPrefix: '备份导出失败' },
  )

  // 从备份恢复：返回 { settingsRestored, libraryRestored? } / { canceled } / { error }
  wrapHandler(
    'models:importBackup',
    async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const res = await importBackup(win)
      // 恢复目标为当前激活根时的善后（B1）：磁盘 store.json 已被整目录替换，
      // 内存元数据、装饰缓存与延迟缩略图任务仍基于恢复前的数据——
      // 不重载内存：下一次标注写入会用旧数据原子覆盖恢复结果（恢复被静默回滚）；
      // 不清装饰缓存：签名恰好相同时缓存命中绕过新元数据（thumbs 目录随
      // .modelvault 整体交换已不存在，thumbs 不入备份），卡片指向失效文件；
      // 不清延迟任务：旧根封面任务的缩略图会写入恢复后的 thumbs 目录
      const restoredRoot = res?.libraryRestored?.root
      const activeRoot = getCurrentRoot()
      if (
        restoredRoot &&
        activeRoot &&
        path.resolve(restoredRoot).toLowerCase() ===
          path.resolve(activeRoot).toLowerCase()
      ) {
        await awaitThumbDrain()
        await reloadCurrentRootData()
        // 库设置随备份恢复：目标库的 .modelvault/settings.json 已随目录交换，
        // 内存库设置须一并重载，否则下一次设置更新会用旧设置覆盖恢复结果
        await reloadLibrarySettings(restoredRoot)
        resetDecorateCache(restoredRoot)
        clearDeferredOwners()
        clearDeferredJobs()
        logger.info(
          `恢复目标为当前模型库，已重载内存元数据并失效装饰缓存: ${restoredRoot}`,
        )
      }
      if (res.error) {
        logger.warn(`备份恢复失败: ${res.error}`)
      } else if (!res.canceled) {
        logger.info(
          `备份已恢复: 设置=${res.settingsRestored} 库=${res.libraryRestored?.root || '无'}`,
        )
      }
      return res
    },
    { errorPrefix: '备份恢复失败' },
  )
}
