import { app } from 'electron'
import { flushStoreSave } from './services/store'
import { flushWindowStateSave } from './windows/mainWindow'
import { stopWatcher } from './services/watcher'
import logger from './logger'

/**
 * 所有窗口关闭后的退出编排（window-all-closed）：
 *
 * 1. 停止目录监控：避免退出过程中 watcher 再次触发重扫；
 * 2. 等待元数据（store.json）与窗口状态（window-state.json）两路落盘——
 *    必须等待而非直接 quit，否则 app.quit() 会中断进行中的异步原子写，
 *    造成最后一批元数据修改丢失或 window-state.json 残留临时文件；
 * 3. 落盘有确定性时间上限（A4）：磁盘挂起/被杀毒软件锁文件时 flush 可能
 *    永不 settle，导致「窗口已关、进程不退」。超时后记警告并强制退出，
 *    保证「关窗后进程必退」的底线可靠性（超时场景数据可能不完整，
 *    错误报告通道已将落盘失败告知用户）。
 */

/** 退出前落盘等待上限（ms）：覆盖磁盘挂起/锁文件等异常场景 */
const FLUSH_TIMEOUT_MS = 5000

/** 所有窗口关闭后的退出流程 */
export function quitAfterFlush() {
  stopWatcher()
  // 退出流程只完成一次：无论正常 quit 先到还是超时 exit 先到，
  // 另一条路径到达时静默返回（防止强制退出后迟到完成再触发二次退出）
  let settled = false
  const timer = setTimeout(() => {
    if (settled) return
    settled = true
    logger.warn(
      `退出落盘等待超过 ${FLUSH_TIMEOUT_MS}ms 仍未完成，强制退出（数据可能未完整保存）`
    )
    app.exit(0)
  }, FLUSH_TIMEOUT_MS)
  Promise.all([flushStoreSave(), flushWindowStateSave()])
    .catch((err) => {
      // 落盘失败不阻塞退出：flush* 内部已尽力保存并经通知链路告知用户
      logger.warn(`退出落盘未完全成功: ${err?.message || err}`)
    })
    .finally(() => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      logger.info('所有窗口已关闭，应用退出')
      app.quit()
    })
}
