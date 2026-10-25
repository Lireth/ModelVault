import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
import { samePathIgnoreCase } from '../utils'
import { atomicWriteFile } from './atomic-write'
import { notifyStoreSaveError } from './store-events'
import { isUnsafeModelKey } from './store-meta-normalize'
import { removeJournalDir } from './store-meta-journal'
import { metaState } from './store-meta-state'
import { serializeJsonOffThread } from './json-serializer'
import {
  getCurrentRoot,
  getDataDir,
  getDataFilePath,
  getJournalDir,
} from './store-paths'

/**
 * 关联存储落盘链（O5/O1 自 store-meta.js 拆出）：
 * 防抖保存（SAVE_DELAY）→ 统一写盘入口 runSave → 增量日志或全量快照：
 * - 背景保存只写变化键的增量日志（.modelvault/journal/），达到
 *   JOURNAL_COMPACT_ENTRIES 阈值自动合并为紧凑快照并清空日志；
 * - 写盘并发排队：写盘进行中收到的新请求登记 pendingSave/pendingSnapshot，
 *   完成后补写一次，绝不丢失；
 * - 库目录离线（被移动/盘符未挂载）时跳过序列化与写盘，脏数据保留在内存
 *   并安排恢复后的自动补写——绝不重建模型根目录树（O5）；
 * - 恢复重载窗口（saveSuppressed，B-02）内丢弃保存请求：旧内存不得写回
 *   刚恢复的文件。
 */

/** 防抖落盘延迟（ms） */
const SAVE_DELAY = 500

/**
 * 增量日志合并阈值（O5）：背景保存累计的脏键/日志条目达到该值即写一次
 * 全量快照并清空日志；退出、备份、切库、备份恢复等路径强制快照。
 */
const JOURNAL_COMPACT_ENTRIES = 200

/**
 * 全量快照超过该模型数时把 JSON.stringify 移入序列化线程（OPT-03）：
 * 大库快照可达数十 MB，主线程同步序列化会造成窗口/进度条卡顿。
 */
const SNAPSHOT_WORKER_THRESHOLD = 2000
/** 快照 worker 阈值（测试可注入 0 强制走 worker） */
let snapshotWorkerThreshold = SNAPSHOT_WORKER_THRESHOLD

/** 注入快照 worker 阈值（仅供单元测试使用；生产代码严禁调用） */
export function setSnapshotWorkerThresholdForTests(count) {
  snapshotWorkerThreshold =
    Number.isFinite(count) && count >= 0 ? count : SNAPSHOT_WORKER_THRESHOLD
}

/**
 * 根目录可用性探测缓存（O5）的有效期：只缓存「可用」结果，避免正常落盘前
 * 每次都 stat；离线时不缓存负结果，库恢复后下一次保存立即生效。
 */
const ROOT_PROBE_TTL_MS = 1000
/** 离线跳过后自动重试落盘的间隔（ms）：库恢复可用时无需用户再次编辑即可补写 */
const OFFLINE_RETRY_MS = 10000

/** 当前模型根目录是否可用（O5：离线库跳过落盘，不重建目录树） */
async function isCurrentRootAvailable() {
  const root = getCurrentRoot()
  if (!root) return false
  const now = Date.now()
  if (
    metaState.rootProbe.root === root &&
    now - metaState.rootProbe.at < ROOT_PROBE_TTL_MS
  ) {
    return true
  }
  try {
    const stat = await fs.stat(root)
    if (!stat.isDirectory()) return false
    metaState.rootProbe = { root, at: now }
    return true
  } catch {
    return false
  }
}

/**
 * 确保 .modelvault 已存在（O5）：使用非递归 mkdir——父目录（模型根）离线时
 * 返回 ENOENT 而不是被 recursive 重建；调用方随后以 createDirs=false 原子写。
 * @returns {Promise<boolean>} 目录可用时为 true
 */
async function ensureDataDir() {
  try {
    await fs.mkdir(getDataDir())
    return true
  } catch (err) {
    if (err.code === 'EEXIST') return true
    logger.warn(`关联存储目录不可用，已跳过元数据落盘: ${err.message}`)
    return false
  }
}

/** 离线跳过后安排一次自动重试（库恢复可用时自动补写内存中的修改） */
function scheduleOfflineRetry() {
  if (metaState.offlineRetryTimer || metaState.saveSuppressed) return
  metaState.offlineRetryTimer = setTimeout(() => {
    metaState.offlineRetryTimer = null
    if (getCurrentRoot() && !metaState.saveSuppressed) {
      saveStoreDeltaNow().catch(notifyStoreSaveError)
    }
  }, OFFLINE_RETRY_MS)
  metaState.offlineRetryTimer.unref?.()
}

export function clearOfflineRetry() {
  if (!metaState.offlineRetryTimer) return
  clearTimeout(metaState.offlineRetryTimer)
  metaState.offlineRetryTimer = null
}

/** 防抖保存：短时间内多次修改只落盘一次 */
export function scheduleSave() {
  // 恢复重载窗口内不调度：定时器携带的是恢复前的旧内存
  if (metaState.saveSuppressed) return
  if (metaState.saveTimer) clearTimeout(metaState.saveTimer)
  // 记录调度时的根目录（A6）：定时器触发时若根已切换，本次防抖携带的
  // 是旧根数据，直接落盘会写进新根目录的 store.json（跨库污染）——丢弃。
  // 正常流程下切库前已由 switchDataRoot 静止写盘链，此处为兜底
  const scheduledRoot = getCurrentRoot()
  metaState.saveTimer = setTimeout(() => {
    metaState.saveTimer = null
    // 大小写不敏感同根判定（单一实现见 utils.samePathIgnoreCase）：
    // 根仅大小写变化（对话框与设置文件对同一目录的两种拼写）不是跨库
    // 切换，不应误判丢弃——数据不丢，但本次修改会延迟到下一次变更才落盘
    if (!samePathIgnoreCase(getCurrentRoot(), scheduledRoot)) {
      logger.warn('丢弃跨根目录的迟到防抖保存（数据已在切库前落盘）')
      return
    }
    // O5：防抖保存只落「变化键」增量日志，不再每次全量 pretty 序列化；
    // 达到阈值/退出/备份/切库时由写盘链合并为紧凑快照
    saveStoreDeltaNow().catch(notifyStoreSaveError)
  }, SAVE_DELAY)
}

/**
 * 写全量快照（O5：紧凑 JSON，不再 pretty 缩进）+ 清空增量日志。
 * 快照携带 journalSeq：即使快照成功后清理日志失败，加载时也会跳过
 * seq ≤ snapshotSeq 的旧批次，不会用旧 delta 回滚快照内容。
 */
async function writeSnapshot() {
  if (!(await ensureDataDir())) return false
  // 版本快照必须在序列化/写盘之前捕获：序列化与写盘 await 期间若有新变更，
  // dirtyKeys 不能整体清空（否则丢失尚未落盘的修改）
  const versionAtWrite = metaState.mutationVersion
  const payload = {
    version: 1,
    models: metaState.data.models,
    journalSeq: metaState.journalSeq,
  }
  // OPT-03：大库全量快照序列化交给 worker，避免主进程长时间阻塞
  const text =
    Object.keys(metaState.data.models).length >= snapshotWorkerThreshold
      ? (await serializeJsonOffThread(payload)).text
      : JSON.stringify(payload)
  // createDirs=false（O5）：目录已由 ensureDataDir 确认，写入阶段绝不重建根目录树
  await atomicWriteFile(getDataFilePath(), text, { createDirs: false })
  metaState.hasSnapshot = true
  metaState.journalEntryCount = 0
  if (metaState.mutationVersion === versionAtWrite) metaState.dirtyKeys.clear()
  await removeJournalDir()
  return true
}

/**
 * 写一批增量日志（O5）：只序列化自上次快照以来发生变化的键。
 * 每个批次经 atomicWriteFile 原子落盘（独立文件），避免 append 半行；
 * seq 单调递增，快照合并后旧批次按代际跳过。
 * @param {string[]} keys 脏键列表
 */
async function writeDeltaJournal(keys) {
  if (!(await ensureDataDir())) return false
  const seq = metaState.journalSeq + 1
  const entries = []
  /** 写入内容对应的元数据引用：写盘期间被再次修改的键必须保留为脏 */
  const written = new Map()
  for (const key of keys) {
    if (isUnsafeModelKey(key)) continue
    const meta = metaState.data.models[key] || null
    written.set(key, meta)
    entries.push(meta ? { op: 'set', key, meta } : { op: 'del', key })
  }
  if (entries.length === 0) {
    metaState.dirtyKeys.clear()
    return true
  }
  const journalDir = getJournalDir()
  try {
    await fs.mkdir(journalDir)
  } catch (err) {
    if (err.code !== 'EEXIST') {
      logger.warn(`增量日志目录不可用，已跳过元数据落盘: ${err.message}`)
      return false
    }
  }
  const file = path.join(
    journalDir,
    `delta-${String(seq).padStart(12, '0')}.json`,
  )
  await atomicWriteFile(file, JSON.stringify({ seq, entries }), {
    createDirs: false,
  })
  metaState.journalSeq = seq
  metaState.journalEntryCount += entries.length
  for (const [key, metaAtWrite] of written) {
    // 引用一致 = 写盘期间未再修改该键；否则保留脏标记，下次增量补写最新值
    if (
      metaAtWrite === null
        ? !metaState.data.models[key]
        : metaState.data.models[key] === metaAtWrite
    ) {
      metaState.dirtyKeys.delete(key)
    }
  }
  return true
}

/**
 * 统一写盘入口：增量日志或全量快照。
 * @param {boolean} forceSnapshot 是否强制写全量快照
 */
async function runSave(forceSnapshot) {
  if (!metaState.data || !getCurrentRoot() || metaState.saveSuppressed) return
  if (metaState.saving) {
    // 写盘进行中又有新修改：标记待补写；若其中有强制快照请求，补写也必须快照
    metaState.pendingSave = true
    metaState.pendingSnapshot = metaState.pendingSnapshot || forceSnapshot
    return
  }
  metaState.saving = true
  try {
    // O5：库目录离线（被移动/盘符未挂载）时跳过序列化与写盘，
    // 脏数据保留在内存，并安排恢复后的自动补写——绝不重建模型根目录树
    if (!(await isCurrentRootAvailable())) {
      if (metaState.dirtyKeys.size > 0 || metaState.journalEntryCount > 0)
        scheduleOfflineRetry()
      return
    }
    const keys = [...metaState.dirtyKeys]
    let wrote = true
    if (
      forceSnapshot ||
      !metaState.hasSnapshot ||
      metaState.journalEntryCount + keys.length >= JOURNAL_COMPACT_ENTRIES
    ) {
      wrote = await writeSnapshot()
    } else if (keys.length > 0) {
      wrote = await writeDeltaJournal(keys)
    }
    if (wrote) clearOfflineRetry()
    else if (metaState.dirtyKeys.size > 0 || metaState.journalEntryCount > 0) {
      scheduleOfflineRetry()
    }
  } catch (err) {
    notifyStoreSaveError(err)
  } finally {
    metaState.saving = false
    if (metaState.pendingSave) {
      metaState.pendingSave = false
      const force = metaState.pendingSnapshot
      metaState.pendingSnapshot = false
      // 补写读取的是当前最新 data，覆盖写盘期间的任何后续修改；
      // 若已进入恢复重载窗口则丢弃，绝不把旧内存写回刚恢复的文件
      if (!metaState.saveSuppressed) {
        ;(force ? runSave(true) : runSave(false)).catch(notifyStoreSaveError)
      }
    }
  }
}

/**
 * 增量落盘（防抖保存路径）：只写脏键日志；达到阈值时自动合并快照。
 * @returns {Promise<void>}
 */
export async function saveStoreDeltaNow() {
  return runSave(false)
}

/**
 * 立即写全量快照（原子写入：临时文件 -> 重命名；并发请求排队补写，不会丢失）。
 * 退出、备份、切库、备份恢复等需要磁盘为完整快照的场景使用。
 */
export async function saveStoreNow() {
  return runSave(true)
}

/**
 * 等待元数据写盘链完全静止（退出路径专用，替代直接 await saveStoreNow）：
 * saveStoreNow 在写盘进行中仅登记 pendingSave 立即返回，退出流程若直接 await
 * 会过早 quit 中断在途写入，且 finally 中的补写永无机会执行，导致最后一批
 * 元数据修改丢失。本函数先取消未触发的防抖定时器、触发一次落盘请求
 * （空闲则立即写入，写盘中则登记补写），随后等待写盘与补写全部完成。
 */
export async function flushStoreSave() {
  const hadPendingTimer = metaState.saveTimer !== null
  if (metaState.saveTimer) {
    clearTimeout(metaState.saveTimer)
    metaState.saveTimer = null
  }
  // 无待落盘内容时不要“为写而写”：空库首次导出/退出不应凭空创建 store.json。
  // 存在增量日志时必须强制快照——备份/退出读取的是 store.json 快照本身。
  if (
    !hadPendingTimer &&
    !metaState.saving &&
    !metaState.pendingSave &&
    metaState.dirtyKeys.size === 0 &&
    metaState.journalEntryCount === 0
  ) {
    return
  }
  await saveStoreNow()
  while (metaState.saving || metaState.pendingSave) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}
