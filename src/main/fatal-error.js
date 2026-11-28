import { app, dialog } from 'electron'
import logger from './logger'
import { isSettledWithin } from './utils'
import { flushSettingsSave, flushStoreSave } from './services/store'
import { flushWindowStateSave } from './windows/mainWindow'
import { errorMessage } from '../shared/error-text'

/**
 * 主进程未捕获异常处理（A3）。
 *
 * uncaughtException 意味着进程状态已不可信：防抖落盘链、目录监控、
 * 扫描任务等可变状态可能处于中间态，带病续跑有元数据静默丢失与
 * 双重写入风险。本地软件无云端兜底，安全策略是：
 * 记录日志 -> 尽力落盘 -> 展示错误框 -> relaunch + exit 优雅重启。
 *
 * 确定性崩溃（如损坏的 settings/store 在启动链路触发）会让每次重启
 * 再次崩溃，形成重启循环——自动重启带熔断：窗口内连续重启计数经
 * relaunch 参数跨进程携带，达到阈值后不再 relaunch，弹框交用户
 * 手动处置（与渲染进程崩溃恢复的放弃决策范式对齐）。
 *
 * unhandledRejection 不适用本策略（多数为可恢复的异步业务错误，
 * 且渲染进程异常另有 app:reportError 通道上报），维持仅记录，
 * 由 index.js 单独处理。
 */

/** 致命错误处理进行中标记：处理期间到达的新异常不重复触发重启 */
let handling = false

/**
 * 致命错误处理中的落盘等待上限（ms，#158）：与 quit.js 退出路径的 A4 底线
 * 同一口径——挂起磁盘（死亡网络盘/被杀毒软件锁文件）上 flush 可能永不
 * settle，无上限等待会让错误框不弹、进程不重不退，handling=true 下整个
 * 应用僵死为「已崩溃但不退出」。
 */
const FLUSH_TIMEOUT_MS = 5000

/** 落盘等待上限（测试可注入；生产代码严禁调用注入器） */
let flushWaitTimeoutMs = FLUSH_TIMEOUT_MS

/**
 * 注入致命错误处理的落盘等待上限（仅供单元测试使用）
 * @param {number} ms 毫秒
 */
export function setFlushWaitTimeoutForTests(ms) {
  flushWaitTimeoutMs = Number.isFinite(ms) && ms >= 0 ? ms : FLUSH_TIMEOUT_MS
}

/** 错误框中展示的错误信息最大长度（避免超长堆栈撑爆对话框） */
const MAX_DETAIL_LENGTH = 500

/**
 * 重启循环熔断窗口（issue #74）：窗口起点为窗口内首次崩溃时刻，
 * 经 relaunch 参数跨进程携带；窗口内连续自动重启达阈值则熔断。
 */
const RESTART_LOOP_WINDOW_MS = 60_000
/** 熔断阈值：窗口内最多自动重启次数 */
const MAX_AUTO_RELAUNCH_IN_WINDOW = 3

/**
 * 截取错误详情（堆栈优先），超长时截断
 * @param {any} error 捕获值（Error 或任意抛出值，经可选链降级 String）
 */
function errorDetail(error) {
  const text = error?.stack || error?.message || String(error)
  return text.length > MAX_DETAIL_LENGTH
    ? `${text.slice(0, MAX_DETAIL_LENGTH)}…`
    : text
}

/**
 * 从启动参数解析上次致命重启携带的熔断计数状态（参数形式与下方
 * relaunch 传参一致）。无合法参数视为全新启动，从 1 重新计数。
 * @param {readonly string[]} argv 进程参数
 * @returns {{count: number, firstMs: number}} 窗口内已重启次数与窗口起点
 */
function parseRestartLoopState(argv) {
  let count = 0
  let firstMs = 0
  if (Array.isArray(argv)) {
    for (const arg of argv) {
      const text = String(arg)
      const c = /^--fatal-restart-count=(\d{1,3})$/.exec(text)
      if (c?.[1]) count = Number(c[1])
      const t = /^--fatal-restart-first=(\d{1,15})$/.exec(text)
      if (t?.[1]) firstMs = Number(t[1])
    }
  }
  return { count, firstMs }
}

/**
 * 处理一个未捕获异常：尽力保存数据后提示用户并重启。
 * 可安全重复调用——首个异常进入处理流程后，后续异常仅记录警告。
 * 窗口内连续自动重启达阈值后熔断：不再 relaunch，仅提示用户手动
 * 处置，打断确定性崩溃形成的重启循环。
 * @param {any} error 异常对象
 */
export async function handleUncaughtException(error) {
  logger.error(
    `未捕获的异常: ${error?.stack || error?.message || String(error)}`,
  )
  if (handling) {
    logger.warn('已处于致命错误处理流程中，忽略后续异常')
    return
  }
  handling = true
  try {
    // 尽力保存：防抖中的元数据与设置立即落盘（含窗口状态，与 quit.js
    // 退出路径三路对齐），减少重启导致的数据丢失。落盘失败不阻断重启
    // ——数据已可能不一致，续跑风险高于重启。
    // 等待有确定性上限（#158，与 quit.js 的 A4 底线同一口径）：磁盘挂起时
    // flush 可能永不 settle，超时按未完成继续走「提示 + 重启」底线；
    // flush 链已 catch 兜底，超时后的迟到完成由 app.exit 终结，无副作用
    const flushChain = Promise.all([
      flushStoreSave(),
      flushSettingsSave(),
      flushWindowStateSave(),
    ]).catch((err) => {
      logger.warn(`致命错误处理中落盘失败: ${err.message}`)
    })
    const settled = await isSettledWithin(flushChain, flushWaitTimeoutMs)
    if (!settled) {
      logger.warn(
        `致命错误处理中落盘等待超过 ${flushWaitTimeoutMs}ms 仍未完成，按未完成继续（数据可能未完整保存）`,
      )
    }
  } finally {
    // 熔断判定：窗口起点（窗口内首次崩溃时刻）不变以维持同一窗口；
    // 窗口过期（超过 RESTART_LOOP_WINDOW_MS）则视为已恢复，重新计数
    const prev = parseRestartLoopState(process.argv)
    const now = Date.now()
    const inWindow =
      prev.firstMs > 0 && now - prev.firstMs < RESTART_LOOP_WINDOW_MS
    const nextCount = inWindow ? prev.count + 1 : 1
    const tripBreaker = nextCount > MAX_AUTO_RELAUNCH_IN_WINDOW
    // showErrorBox 是同步 void API（返回 undefined），不可 await/.catch；
    // try/catch 兜底：展示失败不阻断退出
    try {
      dialog.showErrorBox(
        '模匣 遇到无法恢复的错误',
        tripBreaker
          ? `应用已连续多次异常重启，已停止自动重启以避免重启循环。\n请手动重新启动应用；若问题持续，请查看日志目录（%APPDATA%\\modelvault\\logs）并联系开发者。\n\n错误信息：\n${errorDetail(error)}`
          : `应用将保存数据后自动重启。\n\n错误信息：\n${errorDetail(error)}\n\n` +
              '若同一问题反复出现，请查看日志目录（%APPDATA%\\modelvault\\logs）并联系开发者。',
      )
    } catch (dialogErr) {
      logger.warn(`错误框展示失败: ${errorMessage(dialogErr) || dialogErr}`)
    }
    if (tripBreaker) {
      logger.error(`窗口内连续崩溃重启 ${nextCount} 次，熔断生效，停止自动重启`)
    } else {
      app.relaunch({
        args: [
          `--fatal-restart-count=${nextCount}`,
          `--fatal-restart-first=${inWindow ? prev.firstMs : now}`,
        ],
      })
    }
    app.exit(1)
  }
}

/** 测试钩子：复位处理中标记（熔断计数由启动参数跨进程携带，无需复位） */
export function resetFatalErrorForTests() {
  handling = false
}
