import { app, dialog } from 'electron'
import logger from './logger'
import { flushStoreSave } from './services/store'

/**
 * 主进程未捕获异常处理（A3）。
 *
 * uncaughtException 意味着进程状态已不可信：防抖落盘链、目录监控、
 * 扫描任务等可变状态可能处于中间态，带病续跑有元数据静默丢失与
 * 双重写入风险。本地软件无云端兜底，安全策略是：
 * 记录日志 -> 尽力落盘 -> 展示错误框 -> relaunch + exit 优雅重启。
 *
 * unhandledRejection 不适用本策略（多数为可恢复的异步业务错误，
 * 且渲染进程异常另有 app:reportError 通道上报），维持仅记录，
 * 由 index.js 单独处理。
 */

/** 致命错误处理进行中标记：处理期间到达的新异常不重复触发重启 */
let handling = false

/** 错误框中展示的错误信息最大长度（避免超长堆栈撑爆对话框） */
const MAX_DETAIL_LENGTH = 500

/** 截取错误详情（堆栈优先），超长时截断 */
function errorDetail(error) {
  const text = error?.stack || error?.message || String(error)
  return text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH)}…` : text
}

/**
 * 处理一个未捕获异常：尽力保存数据后提示用户并重启。
 * 可安全重复调用——首个异常进入处理流程后，后续异常仅记录警告。
 * @param {unknown} error 异常对象
 */
export async function handleUncaughtException(error) {
  logger.error(`未捕获的异常: ${error?.stack || error?.message || String(error)}`)
  if (handling) {
    logger.warn('已处于致命错误处理流程中，忽略后续异常')
    return
  }
  handling = true
  try {
    // 尽力保存：防抖中的元数据立即落盘，减少重启导致的数据丢失。
    // 落盘失败不阻断重启——数据已可能不一致，续跑风险高于重启
    await flushStoreSave().catch((err) => {
      logger.warn(`致命错误处理中落盘失败: ${err.message}`)
    })
  } finally {
    // showErrorBox 是同步 void API（返回 undefined），不可 await/.catch；
    // try/catch 兜底：展示失败不阻断重启
    try {
      dialog.showErrorBox(
        '模匣 遇到无法恢复的错误',
        `应用将保存数据后自动重启。\n\n错误信息：\n${errorDetail(error)}\n\n` +
          '若同一问题反复出现，请查看日志目录（%APPDATA%\\modelvault\\logs）并联系开发者。'
      )
    } catch (dialogErr) {
      logger.warn(`错误框展示失败: ${dialogErr?.message || dialogErr}`)
    }
    app.relaunch()
    app.exit(1)
  }
}
