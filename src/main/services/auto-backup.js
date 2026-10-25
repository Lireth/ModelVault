import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
import { DATA_DIR, getCurrentRoot, getSettings } from './store'
import { buildBackupParts } from './backup-export'
import { writeBackupZipToFile } from './backup-zip'

/**
 * 自动定期元数据备份（OPT-07）：
 * journal + 原子写保证了单机一致性，但「误删库/磁盘故障」场景此前只能靠
 * 用户手动导出 zip——标注（收藏/评分/备注/标签，多年的整理成果）没有任何
 * 自动兜底。本服务在启动后延迟检查、此后周期性检查：到期（距上次自动
 * 备份 ≥24h）时对当前库做一次「仅标注」备份（metadata 模式，不含封面，
 * 通常 KB 级）写入 <root>/.modelvault/backups/，滚动保留最近 5 份
 * （时间戳命名，字典序即时间序——与 snapshotSelectiveStore 同一滚动模式）。
 *
 * 设计要点：
 * - 是否执行由触发时刻的设置值决定（用户关闭开关即时生效，无需重启）；
 * - 无激活库 / 库尚无标注 / 上次备份不足 24h / 已有备份在途时静默跳过；
 * - 定时器 unref，不阻止进程退出（与 scheduleStartupUpdateCheck 同规范）；
 * - 开发与冒烟模式跳过（避免测试环境在用户库目录写备份）。
 */

/** 自动备份目录名（.modelvault/backups/，库内随文件夹整体迁移） */
const BACKUP_DIR_NAME = 'backups'
const AUTO_BACKUP_PREFIX = 'auto-'
const AUTO_BACKUP_SUFFIX = '.zip'
/** 自动备份滚动保留份数 */
const AUTO_BACKUP_KEEP = 5
/** 备份间隔（ms）：距上次自动备份不足 24h 不重复 */
const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000
/** 启动后首次检查延迟（ms）：避开启动初期的库加载/索引读取 */
const STARTUP_DELAY_MS = 60 * 1000
/** 周期检查间隔（ms）：实际备份仍由 24h 门槛约束 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** 周期检查定时器（全局唯一，unref） */
let checkTimer = null
/** 备份在途标记（防重入） */
let running = false

/** 调度下一次检查（全局唯一；unref 不阻止进程退出） */
function scheduleNext(delayMs) {
  if (checkTimer) clearTimeout(checkTimer)
  checkTimer = setTimeout(() => {
    checkTimer = null
    runAutoBackupIfDue()
      .catch((err) => logger.warn(`自动备份检查失败: ${err.message}`))
      .finally(() => scheduleNext(CHECK_INTERVAL_MS))
  }, delayMs)
  checkTimer.unref?.()
}

/**
 * 应用启动入口：延迟一个启动窗口后开始周期检查。
 * 开发/冒烟模式跳过（避免测试环境向库目录写自动备份）。
 */
export function scheduleAutoBackupCheck() {
  if (!app.isPackaged || process.env.MODELVAULT_SMOKE === '1') return
  scheduleNext(STARTUP_DELAY_MS)
}

/**
 * 上一次自动备份的时间戳（解析备份目录内 auto-<stamp>.zip 文件名）。
 * @param {string} dir 备份目录
 * @returns {Promise<number>} 最近一次的时间戳；目录不存在/无备份为 0
 */
async function lastAutoBackupAt(dir) {
  let names
  try {
    names = await fs.readdir(dir)
  } catch {
    return 0
  }
  let latest = 0
  for (const name of names) {
    if (
      !name.startsWith(AUTO_BACKUP_PREFIX) ||
      !name.endsWith(AUTO_BACKUP_SUFFIX)
    )
      continue
    const stamp = Number(
      name.slice(
        AUTO_BACKUP_PREFIX.length,
        name.length - AUTO_BACKUP_SUFFIX.length,
      ),
    )
    if (Number.isFinite(stamp) && stamp > latest) latest = stamp
  }
  return latest
}

/** 滚动清理超出保留数的旧备份（字典序即时间序；尽力而为） */
async function pruneAutoBackups(dir) {
  try {
    const names = (await fs.readdir(dir))
      .filter(
        (n) =>
          n.startsWith(AUTO_BACKUP_PREFIX) && n.endsWith(AUTO_BACKUP_SUFFIX),
      )
      .sort()
    for (const old of names.slice(
      0,
      Math.max(0, names.length - AUTO_BACKUP_KEEP),
    )) {
      await fs.rm(path.join(dir, old), { force: true }).catch(() => {})
    }
  } catch {
    /* 清理失败仅留下多余的旧备份，不影响正确性 */
  }
}

/**
 * 执行一次到期判定与备份（测试可直接调用注入 now）。
 * @param {number} [now] 当前时间戳（默认 Date.now()）
 * @returns {Promise<{skipped?: string, error?: string, path?: string,
 *   models?: number, last?: number, reason?: string}>}
 *   skipped 为跳过原因（recent 附 last=上次备份时间戳；empty 附
 *   reason=组装层失败原因）；path 为新备份文件路径
 */
export async function runAutoBackupIfDue(now = Date.now()) {
  // 触发时刻读设置：用户关闭开关即时生效
  if (getSettings().autoBackup !== true) return { skipped: 'disabled' }
  const root = getCurrentRoot()
  if (!root) return { skipped: 'no-root' }
  if (running) return { skipped: 'busy' }
  running = true
  try {
    const dir = path.join(root, DATA_DIR, BACKUP_DIR_NAME)
    const last = await lastAutoBackupAt(dir)
    if (now - last < AUTO_BACKUP_INTERVAL_MS) return { skipped: 'recent', last }

    // metadata 模式：全库标注、不含封面（体积小）——复用手动备份的组装核心
    const built = await buildBackupParts({ mode: 'metadata' })
    if (built.error) {
      // 库尚无标注是正常状态（刚建库），静默跳过而非报错
      logger.info(`自动备份跳过: ${built.error}`)
      return { skipped: 'empty', reason: built.error }
    }
    await fs.mkdir(dir, { recursive: true })
    const target = path.join(
      dir,
      `${AUTO_BACKUP_PREFIX}${now}${AUTO_BACKUP_SUFFIX}`,
    )
    try {
      await writeBackupZipToFile(target, built.parts)
    } catch (err) {
      await fs.rm(target, { force: true }).catch(() => {})
      return { error: `自动备份写入失败: ${err.message}` }
    }
    await pruneAutoBackups(dir)
    logger.info(`自动元数据备份完成: ${target}（${built.models} 模型）`)
    return { path: target, models: built.models }
  } finally {
    running = false
  }
}

/* ---------------- 仅供单元测试使用 ---------------- */

/** 重置调度状态（测试隔离用；生产代码严禁调用） */
export function resetAutoBackupForTests() {
  if (checkTimer) {
    clearTimeout(checkTimer)
    checkTimer = null
  }
  running = false
}
