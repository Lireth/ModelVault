import path from 'node:path'
import fs from 'node:fs/promises'
import { app } from 'electron'
import logger from '../logger'
import { atomicWriteFile } from './atomic-write'
import { notifyStoreSaveError } from './store-events'
import { isSettledWithin } from '../utils'
import { SETTINGS_FILE, getLibSettingsFilePath } from './store-paths'
import { errorCode } from '../../shared/error-text'

/**
 * 应用设置的持久化层（自 store-settings.js 拆出）：
 * 引导层/库层两条串行写盘链、防抖合并、flush 等待与失败通知。内存态
 * （bootstrap/library）由门面 store-settings.js 持有，本模块只接收
 * 「调用同步段捕获的快照」，避免迟到的落盘读取已被切库替换的全局状态。
 */

/** 引导层全局设置文件绝对路径（%APPDATA%/modelvault/settings.json） */
export function getSettingsFilePath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE)
}

/** 目标库目录是否可用（O5：离线库跳过库设置写入，避免重建 .modelvault） */
export async function isDirectoryAvailable(dir) {
  try {
    return (await fs.stat(dir)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 设置落盘串行队列（A1）：并发写入依次落盘，最终落盘必为最新合并快照。
 * 单次写失败经监听器上报后队列继续服务后续写入，不被中断。
 * 引导层与库层各自独立排队。
 */
let bootstrapWriteChain = Promise.resolve()
let libraryWriteChain = Promise.resolve()

/** 库/引导层设置写盘防抖窗口（ms，OPT-4）：与元数据侧 SAVE_DELAY 同值 */
const SETTINGS_SAVE_DELAY_MS = 500
/** 防抖最长等待（ms）：持续变更（滑块连点）时保证有限时间内落盘 */
const SETTINGS_SAVE_MAX_WAIT_MS = 2000

/** 防抖窗口（测试可注入小值；0 表示下一个宏任务即冲刷） */
let settingsSaveDelayMs = SETTINGS_SAVE_DELAY_MS

/**
 * 注入设置写盘防抖窗口（仅供单元测试使用；生产代码严禁调用）
 * @param {number} ms 毫秒
 */
export function setSettingsSaveDelayForTests(ms) {
  settingsSaveDelayMs =
    Number.isFinite(ms) && ms >= 0 ? ms : SETTINGS_SAVE_DELAY_MS
}

/**
 * 防抖窗口内待落盘的快照（OPT-4）。快照与 root 均在 updateSettings 的调用
 * 同步段捕获（B-02 语义保持：迟到的落盘只写「本次调用所属库」的内容）；
 * 防抖仅延迟「入队写盘链」的时机：
 * - 引导层全量快照最新者胜（窗口内多次更新合并为一次写）；
 * - 库层按序保留且 root 随条目走——防切库窗口内跨库丢写，同库多条目
 *   由写盘链串行自然「后写覆盖」。
 */
let pendingBootstrapSnapshot = null
const pendingLibrarySaves = []
let settingsSaveTimer = null
let firstPendingAt = 0

/** 是否仍有未入队的待写快照 */
function hasPendingSettingsSaves() {
  return pendingBootstrapSnapshot !== null || pendingLibrarySaves.length > 0
}

/** 安排防抖冲刷（重复调用顺延，但受最长等待约束保证前进） */
function scheduleSettingsSaveFlush() {
  const now = Date.now()
  if (!firstPendingAt) firstPendingAt = now
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer)
  const elapsed = now - firstPendingAt
  const delay = Math.max(
    0,
    Math.min(settingsSaveDelayMs, SETTINGS_SAVE_MAX_WAIT_MS - elapsed),
  )
  settingsSaveTimer = setTimeout(() => {
    settingsSaveTimer = null
    flushPendingSettingsSaves()
  }, delay)
  settingsSaveTimer.unref?.()
}

/**
 * 登记一份待落盘的引导层快照（最新者胜）。
 * @param {string} snapshot 已序列化的设置 JSON
 */
export function queueBootstrapSave(snapshot) {
  pendingBootstrapSnapshot = snapshot
  scheduleSettingsSaveFlush()
}

/**
 * 登记一份待落盘的库层快照（root 随条目走，跨库保持先后顺序）。
 * @param {string} root 目标库根目录
 * @param {string} snapshot 已序列化的设置 JSON
 */
export function queueLibrarySave(root, snapshot) {
  pendingLibrarySaves.push({ root, snapshot })
  scheduleSettingsSaveFlush()
}

/** 立即将全部待写快照入队写盘链（flushSettingsSave/防抖到期共用） */
function flushPendingSettingsSaves() {
  if (settingsSaveTimer) {
    clearTimeout(settingsSaveTimer)
    settingsSaveTimer = null
  }
  firstPendingAt = 0
  const bootstrapSnapshot = pendingBootstrapSnapshot
  pendingBootstrapSnapshot = null
  if (bootstrapSnapshot) {
    notifySaveFailure(enqueueBootstrapWrite(bootstrapSnapshot))
  }
  const librarySaves = pendingLibrarySaves.splice(0)
  if (librarySaves.length > 0) {
    // 同根多条目合并为最新一份（全量快照，旧份严格过时）；跨根保持先后
    // 顺序（Map 插入序，原地更新 snapshot 不改变次序）
    const latestByRoot = new Map()
    for (const save of librarySaves) {
      const key = save.root.toLowerCase()
      const prev = latestByRoot.get(key)
      if (prev) prev.snapshot = save.snapshot
      else latestByRoot.set(key, { root: save.root, snapshot: save.snapshot })
    }
    for (const { root, snapshot } of latestByRoot.values()) {
      notifySaveFailure(enqueueLibraryWrite(root, snapshot))
    }
  }
}

/** 写失败经监听器通知渲染进程（C7）——防抖路径无调用方等待，通知随任务挂接 */
function notifySaveFailure(task) {
  task.catch((err) => {
    notifyStoreSaveError(
      Object.assign(new Error(`设置保存失败: ${err.message}`)),
    )
  })
}

/** 将引导层快照排入写盘链（唯一的引导层写入通道，与库层同一串行化语义） */
function enqueueBootstrapWrite(snapshot) {
  const task = bootstrapWriteChain.then(() =>
    atomicWriteFile(getSettingsFilePath(), snapshot),
  )
  bootstrapWriteChain = task.catch(() => {})
  return task
}

/** 立即写入引导层快照（加载迁移等需要等待落定的路径使用） */
export function writeBootstrapNow(snapshot) {
  return enqueueBootstrapWrite(snapshot)
}

/**
 * 将库设置文本排入库层写盘链（唯一的库设置写入通道）。
 * @param {string} root 目标库根目录
 * @param {string} text 已序列化的设置快照
 * @returns {Promise<void>} 本次写入完成（失败时 reject，链本身继续服务后续写入）
 */
function enqueueLibraryWrite(root, text) {
  const task = libraryWriteChain.then(async () => {
    // O5：执行时再次确认库目录可用（排队期间可能被移动/卸载）；
    // 抛出后由 updateSettings 统一经 notifyStoreSaveError 告知用户
    if (!(await isDirectoryAvailable(root))) {
      throw new Error(`模型库目录不可用，已跳过设置落盘: ${root}`)
    }
    const file = getLibSettingsFilePath(root)
    try {
      // 非递归 mkdir：库根离线时返回 ENOENT，绝不重建根目录树
      await fs.mkdir(path.dirname(file))
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') throw err
    }
    await atomicWriteFile(file, text, { createDirs: false })
  })
  libraryWriteChain = task.catch(() => {})
  return task
}

/** 立即写入库设置（初始化/备份恢复等需要等待落定的路径使用） */
export function writeLibraryNow(root, text) {
  return enqueueLibraryWrite(root, text)
}

/**
 * 等待设置写盘链完全静止（B-02）：
 * 切库、备份导出/恢复、退出等需要「磁盘已是最新设置」的场景调用。
 * 先冲刷防抖窗口内尚未入队的待写快照，再循环比较链引用——覆盖等待期间
 * 又有新写入入队（或新待写产生）的情况。
 */
export async function flushSettingsSave() {
  for (;;) {
    flushPendingSettingsSaves()
    const bootstrapTask = bootstrapWriteChain
    const libraryTask = libraryWriteChain
    // 两条链在入队时已 catch（失败经监听器上报），此处等待不会 reject
    await Promise.all([bootstrapTask, libraryTask])
    if (
      bootstrapTask === bootstrapWriteChain &&
      libraryTask === libraryWriteChain &&
      !hasPendingSettingsSaves()
    )
      return
  }
}

/**
 * 设置写盘链的 flush 等待上限（ms，B3）：与元数据 flush 同一底线
 * （store-meta-persist.FLUSH_AWAIT_TIMEOUT_MS）——挂起磁盘上的写链
 * 可能永不 settle，持锁路径直接 await 会永久卡死全局维护锁。
 */
let settingsFlushAwaitTimeoutMs = 5000

/** 注入设置 flush 等待上限（仅供单元测试使用） */
export function setSettingsFlushAwaitTimeoutForTests(ms) {
  settingsFlushAwaitTimeoutMs = Number.isFinite(ms) && ms >= 0 ? ms : 5000
}

/**
 * 有等待上限的设置写盘链静止（B3）：超时返回 false——写链不取消也不
 * 截断，在途写入仍在后台续跑（链式追加语义，后续写入排在其后，不存在
 * 覆盖窗口）；调用方按 false 中止敏感操作或如实告知。
 * @param {number} [timeoutMs] 等待上限
 * @returns {Promise<boolean>} true=写盘链已在时限内静止；false=超时
 */
export async function flushSettingsSaveBounded(
  timeoutMs = settingsFlushAwaitTimeoutMs,
) {
  const settled = await isSettledWithin(flushSettingsSave(), timeoutMs)
  if (!settled) {
    logger.warn(
      '设置写盘链等待超时（磁盘无响应），按未静止处理（写盘仍在后台续跑）',
    )
  }
  return settled
}
