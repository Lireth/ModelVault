import fs from 'node:fs/promises'
import { ipcMain } from 'electron'
import logger from '../logger'
import { startPerf } from '../services/perf'
import { getCurrentRoot, isInRoot } from '../services/store'
import { validateIpcPayload } from '../../shared/ipc-schema'
import { isPathRealWithin, resolveRealPath } from '../utils'
import { isThumbRendererContents } from '../services/thumb-renderer'

/**
 * IPC handler 统一包装与入参校验助手（O1/O2 样板收敛）：
 *
 * 此前各注册模块手写两类样板，且形态不一：
 * - 「typeof id !== 'string' || !id → { error: '无效的模型标识' }」
 *   在 covers/meta/misc 等 9 处逐字重复，新增 handler 极易漏写；
 * - 多数 async handler 没有 try/catch 兜底，业务代码抛出的任何异常都以
 *   IPC reject 的形式抛给渲染层——Error 对象经结构化克隆后只剩难以辨认的
 *   消息体，且各通道错误形状不一。
 *
 * wrapHandler 收敛为统一约定：
 * - 校验助手（checkModelId 等）返回错误文案，handler 首行短路返回 { error }；
 * - payload 结构校验（O-2）：按通道 schema 前置校验（shared/ipc-schema.js
 *   注册表，O2 单一来源），非法 payload 在进入业务代码前即拒绝——schema 只查
 *   类型/边界，handler 内的语义校验与专属文案保持不变；未登记 schema 的通道
 *   一律拒绝并告警（O1 fail-closed），新增通道漏登记不会静默绕过结构门禁；
 * - 抛出的异常兜底为 { error: `${前缀}: ${err.message}` } 并写主进程日志；
 * - AbortError（用户主动取消）保留 { canceled: true } 语义（与 models:scan
 *   取消链路的既有契约一致）；
 * - 通道级耗时观测（OPT-3，PERF-2 基线）：每次 invoke 覆盖「schema 校验 +
 *   业务处理」全程计时，quiet 模式低于阈值零日志（高频通道无噪音）、超阈值
 *   以 [perf] warn 显形（长耗时通道按 perfWarnMs 下调阈值采集基线，为
 *   IPC payload 瘦身等优化提供实测依据）；失败路径不静默——异常日志始终
 *   携带耗时（按通道名检索可离线聚合失败率/慢调用分布）。
 */

/** IPC 通道慢调用阈值（ms）：quiet 模式仅超阈值写 [perf] 日志 */
const IPC_PERF_WARN_MS = 1000
/** 慢调用阈值（测试可注入 0 观察全部通道） */
let ipcPerfWarnMs = IPC_PERF_WARN_MS

/**
 * 注入 IPC 通道慢调用阈值（仅供单元测试使用；生产代码严禁调用）
 * @param {number} ms 毫秒
 */
export function setIpcPerfWarnMsForTests(ms) {
  ipcPerfWarnMs = Number.isFinite(ms) && ms >= 0 ? ms : IPC_PERF_WARN_MS
}

/**
 * 注册一个带统一异常兜底的 IPC handler。
 * @param {string} channel 通道名（日志定位用）
 * @param {(event: import('electron').IpcMainInvokeEvent, payload: any) => any} handler
 *   业务处理器；返回值原样回传渲染进程
 * @param {{errorPrefix?: string, perfWarnMs?: number}} [opts]
 *   errorPrefix 为异常兜底文案前缀（默认「操作失败」）；perfWarnMs 覆盖该
 *   通道的慢调用阈值（长耗时通道下调以采集基线，高频通道保持全局默认）
 */
export function wrapHandler(channel, handler, opts = {}) {
  const prefix = opts.errorPrefix || '操作失败'
  const perfWarnMs =
    typeof opts.perfWarnMs === 'number' ? opts.perfWarnMs : ipcPerfWarnMs
  ipcMain.handle(channel, async (event, payload) => {
    // OPT-3 通道级观测：覆盖「schema 校验 + 业务处理」全程，label 即通道名
    //（与既有 [perf] 打点同一前缀格式，可统一检索聚合）
    const done = startPerf(channel, { warnMs: perfWarnMs, quiet: true })
    // OPT-01：缩略图隐藏窗口只允许 on/send 两条缩略图通道；即使其
    // preload 被图片解码漏洞利用，也不能借 invoke 触达业务 IPC。
    if (isThumbRendererContents(event?.sender)) {
      done('来源拒绝')
      logger.warn(`拒绝来自缩略图渲染窗口的 IPC 调用: ${channel}`)
      return { error: '不允许的 IPC 来源' }
    }
    try {
      // O-2 结构门禁：非法 payload 不进入业务代码（语义校验仍在 handler 内）
      const schemaError = validateIpcPayload(channel, payload)
      if (schemaError) {
        done('入参校验失败')
        logger.warn(`IPC ${channel} 入参校验失败: ${schemaError}`)
        return { error: schemaError }
      }
      const result = await handler(event, payload)
      done()
      return result
    } catch (err) {
      if (err?.name === 'AbortError') {
        done('用户取消')
        logger.info(`IPC ${channel}: 用户已取消`)
        return { canceled: true }
      }
      // 失败路径不受 quiet 静默：done 恒返回耗时，随异常日志带出
      const ms = done(err?.message || '异常')
      logger.error(
        `IPC ${channel} 处理异常（耗时 ${ms}ms）: ${err.stack || err.message}`,
      )
      return { error: `${prefix}: ${err.message}` }
    }
  })
}

/** 模型 id 入参校验：合法返回空串，非法返回统一错误文案 */
export function checkModelId(id) {
  return typeof id === 'string' && id ? '' : '无效的模型标识'
}

/** 模型 id + 根目录越界的复合校验（元数据/网络等非破坏性操作入口） */
export function checkModelIdInRoot(id) {
  return checkModelId(id) || (isInRoot(id) ? '' : '模型不在当前根目录内')
}

/** 当前模型库根目录的真实路径（O6）；未设置/不可访问返回空串 */
export async function getRealRootPath() {
  const root = getCurrentRoot()
  return root ? resolveRealPath(root) : ''
}

/**
 * 破坏性操作的模型归属校验（O6）：realpath 归一后必须仍在库根内。
 * 元数据写入/在线查询等非破坏性操作仍用同步的字面校验；
 * 删除、移动、重命名、禁用等会改动磁盘文件的操作必须使用本函数。
 * @param {string} id 模型绝对路径
 * @param {{realRoot?: string, message?: string}} [options]
 *   realRoot 为批量场景预先解析的根真实路径；message 为越界错误文案
 * @returns {Promise<string>} 合法返回空串，否则返回错误文案
 */
export async function checkModelIdInRootReal(id, options = {}) {
  const base = checkModelId(id)
  if (base) return base
  const message = options.message || '模型不在当前根目录内'
  const realRoot = options.realRoot || (await getRealRootPath())
  if (!realRoot || !isInRoot(id)) return message
  if (!(await isPathRealWithin(id, realRoot))) return message
  return ''
}

/**
 * 路径存在性 + 目录类型校验（O2）：
 * 此前 models:scan / models:partialScan / settings:update 三处手写同构的
 * 「fs.stat + isDirectory + catch」逻辑，文案与判定规则须保持一致，
 * 收敛为单一实现；调用方可用自定义文案组合出各自的错误提示。
 * @param {string} p 待校验路径
 * @param {string} [message] 失败时返回的文案
 * @returns {Promise<string>} 校验通过返回空串，失败返回错误文案
 */
export async function checkExistingDirectory(
  p,
  message = '目录不存在或不是目录',
) {
  try {
    const stat = await fs.stat(p)
    return stat.isDirectory() ? '' : message
  } catch {
    return message
  }
}
