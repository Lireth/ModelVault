import fsSync from 'node:fs'
import path from 'node:path'
import logger from '../logger'
import { isExcludedScanName } from './scanner'
import {
  DEFAULT_POLL_INTERVAL,
  NATIVE_WATCH_FALLBACK_BACKOFF,
  getWatcher,
} from './watcher-state'
import { scheduleBroadcast } from './watcher-broadcast'

/**
 * 原生目录事件监听（O12 自 watcher.js 拆出；OP-05）：
 * Windows 纯 fs.watch recursive 端到端不可靠（漏事件、filename 偶发为 null、
 * 缓冲区溢出丢细节），因此原生监听仅作为**加速触发**：事件提前打开防抖窗，
 * 快照差异仍是最终判据（漏事件由轮询兜底）。监听初始化失败或中途异常时
 * 静默回落到原轮询节奏。
 */

/** @typedef {import('./watcher-state').WatcherState} WatcherState */

/**
 * 原生事件文件名 → 待广播子树（OP-05）。
 * @param {WatcherState} w 监控状态（读取 excludeNames）
 * @param {string|null} filename fs.watch 回调的文件名（recursive 下为相对路径）
 * @returns {string[]|null} 子树数组；null 表示忽略该事件；空数组表示无法定位（全量兜底）
 */
export function nativeEventDirs(w, filename) {
  // 文件名缺失（缓冲区溢出/平台差异）时无法定位子树：走全量扫描兜底
  if (typeof filename !== 'string' || !filename) return []
  const rel = filename.split(path.sep).join('/').replace(/^\/+/, '')
  if (!rel) return []
  const segments = rel.split('/').filter(Boolean)
  for (const seg of segments) {
    // 关联存储/隐藏项/put_ 临时项/内置与用户排除目录：与快照遍历共享
    // isExcludedScanName（O11），从机制上避免监听自身写入造成自激励
    if (isExcludedScanName(seg, w.excludeNames)) return null
  }
  const slash = rel.lastIndexOf('/')
  return [slash < 0 ? '' : rel.slice(0, slash)]
}

/**
 * 启动原生递归监听（OP-05，仅作加速触发；失败时静默回落到轮询）。
 * @param {WatcherState} w 监控状态
 */
export function startNativeWatch(w) {
  try {
    const native = fsSync.watch(
      w.root,
      { recursive: true },
      (_eventType, filename) => {
        if (w !== getWatcher()) return // 旧根在途事件：丢弃（B2 代际防护）
        const dirs = nativeEventDirs(w, filename)
        if (dirs === null) return
        // refresh：原生事件后回填快照基线，避免下一轮轮询重复检出同一变更
        scheduleBroadcast(w, dirs, { refresh: true })
      },
    )
    native.on('error', (err) => {
      logger.warn(`原生目录监听异常，回落到轮询: ${err.message}`)
      try {
        native.close()
      } catch {
        /* 已关闭 */
      }
      if (w === getWatcher()) {
        w.nativeWatcher = null
        // 监听已不可用：恢复原轮询节奏，保证变更仍能被发现
        w.pollInterval = DEFAULT_POLL_INTERVAL
        w.backoff = NATIVE_WATCH_FALLBACK_BACKOFF
      }
    })
    w.nativeWatcher = native
    return true
  } catch (err) {
    logger.warn(`原生目录监听不可用，继续使用轮询: ${err.message}`)
    w.nativeWatcher = null
    return false
  }
}
