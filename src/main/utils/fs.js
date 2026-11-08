/**
 * 文件系统原语：
 * 损坏数据的滚动备份（时间戳命名 + 保留份数上限）。
 */

import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * 损坏数据文件的保底备份（时间戳命名 + 滚动保留）：
 * 单一 `${file}.bak` 在连续损坏时会被 fs.rename 静默覆盖，上一次的损坏
 * 现场即丢失。改为 `${file}.bak-${Date.now()}` 命名（时间戳位数恒定，
 * 字典序即时间序；同毫秒内连续损坏时递增避免覆盖），并按字典序清理
 * 超出 keep 份数的旧备份。rename 失败原样抛出，由调用方兜底记录；
 * 旧备份清理为尽力而为，任何失败不阻断调用方的重置流程。
 * @param {string} file 损坏文件的绝对路径（须存在）
 * @param {number} [keep=3] 滚动保留份数
 * @returns {Promise<string>} 备份文件绝对路径
 */
export async function preserveCorruptedFile(file, keep = 3) {
  const base = path.basename(file)
  let stamp = Date.now()
  let backup = `${file}.bak-${stamp}`
  while (
    await fs.access(backup).then(
      () => true,
      () => false,
    )
  ) {
    stamp += 1
    backup = `${file}.bak-${stamp}`
  }
  await fs.rename(file, backup)
  try {
    const dir = path.dirname(file)
    const names = (await fs.readdir(dir))
      .filter((name) => name.startsWith(`${base}.bak-`))
      .sort()
    for (const old of names.slice(0, Math.max(0, names.length - keep))) {
      await fs.rm(path.join(dir, old), { force: true }).catch(() => {})
    }
  } catch {
    /* 清理失败仅留下多余的旧备份，不影响正确性 */
  }
  return backup
}
