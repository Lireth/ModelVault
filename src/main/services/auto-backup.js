import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import logger from '../logger'
import { renameReplacing } from './atomic-write'
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
 * - 正式包原子落点（A4）：先写 <final>.tmp 并 fsync，再经 renameReplacing
 *   带退避更名——进程强退只可能留下 .tmp 半成品（不在识别/滚动清单内，
 *   下次备份前清扫），半截正式包自此不可能出现；
 * - 上次备份时间仅信任 EOCD 完整的 zip（A4）：文件名合法的半截包不顶替
 *   有效备份推迟下次自动备份，确认损坏的包由滚动清理直接清除；
 * - 定时器 unref，不阻止进程退出（与 scheduleStartupUpdateCheck 同规范）；
 * - 开发与冒烟模式跳过（避免测试环境在用户库目录写备份）。
 */

/** 自动备份目录名（.modelvault/backups/，库内随文件夹整体迁移） */
const BACKUP_DIR_NAME = 'backups'
const AUTO_BACKUP_PREFIX = 'auto-'
const AUTO_BACKUP_SUFFIX = '.zip'
/** 原子写临时文件后缀（先写 <final>.tmp 再 rename，强退不留半截正式包） */
const AUTO_BACKUP_TMP_SUFFIX = '.tmp'
/** zip EOCD 记录长度（固定 22 字节；fflate 写出的 zip 无注释区） */
const ZIP_EOCD_LEN = 22
/** zip EOCD 签名（PK\x05\x06）：位于文件末尾 22 字节记录的起始处 */
const ZIP_EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06])
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
 * 校验 zip 文件尾部 EOCD（End of Central Directory）是否完整（A4）。
 * 本项目自动备份仅由 fflate 写出（无注释区），EOCD 必为末尾 22 字节且
 * 签名 PK\x05\x06——强退残留的半截包缺失该记录，可据此确定性识别。
 * @param {string} filePath zip 文件路径
 * @returns {Promise<boolean|null>} true=EOCD 完整；false=可读但 EOCD 缺失
 *   （确认的半截包，可安全清除）；null=打开/读取失败（可能是瞬时 IO 问题，
 *   不作判定，避免误删有效备份）
 */
async function checkZipComplete(filePath) {
  let fh = null
  try {
    fh = await fs.open(filePath, 'r')
    const stat = await fh.stat()
    if (stat.size < ZIP_EOCD_LEN) return false
    const tail = Buffer.alloc(ZIP_EOCD_LEN)
    const { bytesRead } = await fh.read(
      tail,
      0,
      ZIP_EOCD_LEN,
      stat.size - ZIP_EOCD_LEN,
    )
    if (bytesRead !== ZIP_EOCD_LEN) return null
    return tail.subarray(0, 4).equals(ZIP_EOCD_SIGNATURE)
  } catch {
    return null
  } finally {
    if (fh) await fh.close().catch(() => {})
  }
}

/**
 * 上一次自动备份的时间戳（解析备份目录内 auto-<stamp>.zip 文件名）。
 * 仅信任 EOCD 完整的 zip（A4）：强退残留的半截包文件名合法但内容不完整，
 * 不得顶替有效备份推迟下次自动备份。
 * @param {string} dir 备份目录
 * @returns {Promise<number>} 最近一次的时间戳；目录不存在/无有效备份为 0
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
    if (!Number.isFinite(stamp) || stamp <= latest) continue
    if ((await checkZipComplete(path.join(dir, name))) !== true) {
      logger.warn(`自动备份文件不完整或不可读，已忽略: ${name}`)
      continue
    }
    latest = stamp
  }
  return latest
}

/** 滚动清理超出保留数的旧备份（字典序即时间序；尽力而为）。
 * 确认损坏的包（EOCD 缺失的半截包，A4）不占保留名额，直接清除；
 * 打开失败（瞬时 IO）不作判定留待下次，避免误删有效备份。 */
async function pruneAutoBackups(dir) {
  try {
    const names = (await fs.readdir(dir))
      .filter(
        (n) =>
          n.startsWith(AUTO_BACKUP_PREFIX) && n.endsWith(AUTO_BACKUP_SUFFIX),
      )
      .sort()
    const intact = []
    for (const name of names) {
      const filePath = path.join(dir, name)
      if ((await checkZipComplete(filePath)) === false) {
        await fs.rm(filePath, { force: true }).catch(() => {})
        continue
      }
      intact.push(name)
    }
    for (const old of intact.slice(
      0,
      Math.max(0, intact.length - AUTO_BACKUP_KEEP),
    )) {
      await fs.rm(path.join(dir, old), { force: true }).catch(() => {})
    }
  } catch {
    /* 清理失败仅留下多余的旧备份，不影响正确性 */
  }
}

/** 清扫强退残留的 .tmp 半成品（running 互斥保证执行时无在途写入，A4） */
async function sweepStaleTmp(dir) {
  try {
    for (const name of await fs.readdir(dir)) {
      if (
        name.startsWith(AUTO_BACKUP_PREFIX) &&
        name.endsWith(AUTO_BACKUP_TMP_SUFFIX)
      ) {
        await fs.rm(path.join(dir, name), { force: true }).catch(() => {})
      }
    }
  } catch {
    /* 清扫失败不影响本次备份 */
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
    // running 互斥保证此刻无在途备份：目录内的 .tmp 均为强退残留，直接清扫
    await sweepStaleTmp(dir)
    // A4 原子落点：先写 .tmp 并 fsync 刷盘数据块，再经 renameReplacing 带退避
    // 更名——强退（进程被杀）只可能留下不在识别/滚动清单内的 .tmp 半成品，
    // 更名后的正式包必为完整内容（与 atomicWriteFile 同一断电安全标准）
    const tmp = `${target}${AUTO_BACKUP_TMP_SUFFIX}`
    try {
      await writeBackupZipToFile(tmp, built.parts)
      let fh = null
      try {
        fh = await fs.open(tmp, 'r+')
        await fh.sync()
      } finally {
        if (fh) await fh.close().catch(() => {})
      }
      await renameReplacing(tmp, target)
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {})
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
