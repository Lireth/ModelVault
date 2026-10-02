import { BrowserWindow, ipcMain } from 'electron'
import logger from '../../logger'
import { getSettings, loadSettings } from '../../services/store'
import { scanModels } from '../../services/scanner'
import { pruneOrphanCovers } from '../../services/covers'
import { decorateModels, startThumbDrain } from './decorate'
import { ensureRootStore } from './store'
import { getDecorateCacheRoot, getThumbDrainPromise, resetDecorateCache } from './model-state'

/**
 * 扫描链路：全量扫描模型目录（进度推送、可取消）与取消入口。
 * scanning/scanAbort 为本模块私有状态，仅 models:scan 与 models:cancelScan 使用。
 */

/** 进度事件节流间隔（ms），避免大量小文件时 IPC 过载 */
const PROGRESS_INTERVAL = 120

let scanning = false
/** 当前扫描的取消控制器（null 表示无进行中的扫描） */
let scanAbort = null

/** 注册扫描链路的 IPC 处理器 */
export function registerScanHandlers() {
  // 扫描模型目录（耗时操作，进度通过 models:scanProgress 事件推送，
  // 可经 models:cancelScan 取消）
  ipcMain.handle('models:scan', async (event, { folder } = {}) => {
    // 同步先检查并置位扫描状态：任何 await 之前完成，
    // 防止并发请求在事件循环间隙双重进入（B4）
    if (scanning) {
      return { error: '正在扫描中，请稍候' }
    }
    scanning = true
    scanAbort = new AbortController()
    const signal = scanAbort.signal
    const startedAt = Date.now()
    let root = ''

    try {
      root = typeof folder === 'string' && folder ? folder : (await loadSettings()).modelsFolder
      if (!root) {
        return { error: '尚未设置模型文件夹' }
      }

      const win = BrowserWindow.fromWebContents(event.sender)
      logger.info(`开始扫描模型目录: ${root}`)

      // 等待上一轮后台缩略图生成完成，避免与新扫描的缩略图清理逻辑竞争
      const thumbDrainPromise = getThumbDrainPromise()
      if (thumbDrainPromise) {
        await thumbDrainPromise.catch(() => {})
      }
      // 切换/加载该根目录的关联存储，并清理孤儿封面文件
      await ensureRootStore(root)
      await pruneOrphanCovers()
      // 切换根目录后装饰缓存全部失效
      if (getDecorateCacheRoot() !== root) {
        resetDecorateCache(root)
      }

      let lastSent = 0
      // 应用扫描规则：排除目录 + 扫描文件扩展名（来自应用设置）
      const appSettings = getSettings()
      const { models, errors, dirCount } = await scanModels(
        root,
        (progress) => {
          const now = Date.now()
          if (now - lastSent >= PROGRESS_INTERVAL) {
            lastSent = now
            // 窗口可能已在扫描期间关闭：?. 只防 null 不防已销毁（访问 webContents 抛错），须判 isDestroyed
            if (win && !win.isDestroyed()) {
              win.webContents.send('models:scanProgress', progress)
            }
          }
        },
        {
          excludeDirs: appSettings.excludeDirs || [],
          extensions: appSettings.scanExtensions || [],
          signal
        }
      )

      const decorated = await decorateModels(models, signal)
      const byType = {}
      for (const m of decorated) {
        byType[m.type] = (byType[m.type] || 0) + 1
      }

      logger.info(
        `扫描完成：${decorated.length} 个模型 / ${dirCount} 个目录 / 耗时 ${Date.now() - startedAt}ms / ${errors.length} 个错误`
      )
      if (errors.length > 0) {
        logger.warn(`扫描错误详情: ${JSON.stringify(errors.slice(0, 20))}`)
      }

      // 响应先返回，缺失的缩略图由后台队列补齐（完成后推送 thumbsReady 更新）
      startThumbDrain(win)

      return {
        root,
        models: decorated,
        byType,
        errors,
        durationMs: Date.now() - startedAt
      }
    } catch (err) {
      if (err?.name === 'AbortError') {
        logger.info(`扫描已取消: ${root}`)
        return { canceled: true }
      }
      logger.error(`扫描失败: ${err.stack || err.message}`)
      return { error: `扫描失败: ${err.message}` }
    } finally {
      scanning = false
      scanAbort = null
    }
  })

  // 取消进行中的扫描（经 AbortController 中止，扫描返回 { canceled: true }）
  ipcMain.handle('models:cancelScan', () => {
    if (scanning && scanAbort) {
      scanAbort.abort()
      return { ok: true }
    }
    return { ok: false }
  })
}
