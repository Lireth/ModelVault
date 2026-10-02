import logger from '../logger'

/**
 * 持久化失败通知（C2 自 store.js 拆出）：
 * 元数据 store.json 与应用设置 settings.json 落盘失败共用同一通知通道，
 * 写日志并回调监听器（IPC 层注册，向渲染进程广播，防止用户标注静默丢失）。
 */

/** 元数据落盘失败监听器（IPC 层注册） */
let storeSaveErrorListener = null

/**
 * 注册持久化失败监听器（传 null 可清除）。
 * @param {((err: Error) => void) | null} fn
 */
export function setStoreSaveErrorListener(fn) {
  storeSaveErrorListener = typeof fn === 'function' ? fn : null
}

/**
 * 统一处理持久化失败：写日志并通知监听器。
 * 监听器自身异常不影响保存流程（仅降级为日志）。
 * @param {Error} err
 */
export function notifyStoreSaveError(err) {
  logger.error(`持久化写入失败: ${err.message}`)
  if (storeSaveErrorListener) {
    try {
      storeSaveErrorListener(err)
    } catch (listenErr) {
      logger.warn(`落盘失败监听器异常: ${listenErr.message}`)
    }
  }
}
