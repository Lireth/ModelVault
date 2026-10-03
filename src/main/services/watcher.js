import fs from 'node:fs'
import { BrowserWindow } from 'electron'
import logger from '../logger'

/**
 * 模型目录变更监控（E8）：
 * - 递归监听当前模型根目录，文件增删/修改经防抖后向渲染进程推送
 *   models:fsChanged 事件（渲染进程据此自动重扫）；
 * - 关联存储目录（.modelvault/）内的写入（缩略图/封面/store.json）不触发，
 *   防止「缩略图生成 → 触发重扫 → 再生成」的自激励循环；
 * - 事件防抖 3 秒静默期：批量解压/移动文件时只触发一次重扫。
 */

let watcher = null
/** 当前监听的根目录（用于事件负载与防跨根误报） */
let watchedRoot = null
let debounceTimer = null

/** 停止监听并清理状态 */
function stop() {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (watcher) {
    watcher.close()
    watcher = null
  }
  watchedRoot = null
}

/** 向所有窗口广播目录变更 */
function broadcast() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('models:fsChanged', { root: watchedRoot })
    }
  }
}

/**
 * 同步目录监控状态（扫描成功后与设置变更时调用）。
 * @param {string} root 当前模型根目录
 * @param {boolean} enabled 是否启用自动重扫（settings.autoRescan）
 */
export function syncWatcher(root, enabled) {
  // 根目录与监听状态均未变化时不动（避免每次扫描重启 watcher）
  if (watcher && watchedRoot === root && enabled) return
  stop()
  if (!root || !enabled) return
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      // 关联存储写入不触发重扫（防自激励循环）
      const rel = filename ? String(filename).replaceAll('\\', '/') : ''
      if (rel.startsWith('.modelvault/')) return
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        logger.info(`检测到模型目录变更，触发重扫: ${root}`)
        broadcast()
      }, 3000)
    })
    watcher.on('error', (err) => {
      // 目录被删除/不可达时停止监听，避免反复报错
      logger.warn(`目录监控异常，已停止: ${err.message}`)
      stop()
    })
    watchedRoot = root
    logger.info(`目录监控已启动（autoRescan）: ${root}`)
  } catch (err) {
    logger.warn(`目录监控启动失败: ${err.message}`)
    stop()
  }
}

/** 停止目录监控（应用退出时调用） */
export function stopWatcher() {
  stop()
  logger.info('目录监控已停止')
}
