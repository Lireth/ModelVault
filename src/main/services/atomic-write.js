import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * 原子写入文本文件（先写临时文件再重命名）（C2 自 store.js 拆出）。
 * 断电安全（A2）：rename 前对临时文件 fsync 刷盘数据块——更名落盘后
 * 目标文件必为完整的新版本（或旧版本/不存在），不会出现"已更名但内容
 * 损坏/全零"。更名操作的目录项持久化在 Windows 上受平台限制不做
 * 目录级 fsync，极端情况下表现为回退到旧版本而非损坏。
 * 并发安全（A1）：同一文件的并发写入各自使用独立临时文件（互不截断），
 * 并对 Windows 上并发替换目标的 rename 竞争退避重试。
 * @param {string} file 目标文件绝对路径
 * @param {string} content 待写入内容
 */
let tmpSeq = 0

/** rename 覆盖最大尝试次数：Windows 并发替换竞争窗口通常一次退避即可避开 */
const RENAME_MAX_ATTEMPTS = 5

/**
 * 重命名覆盖目标文件，并对 Windows 并发替换竞争退避重试：
 * 同一文件的并发原子写（临时文件已彼此独立）在 Windows 上，
 * 后到达的 MoveFileExW 替换会确定性失败于 EPERM，短暂退避后重试
 * 待前一路 rename 释放目标即可成功。
 */
async function renameReplacing(tmp, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(tmp, file)
      return
    } catch (err) {
      const retriable = err.code === 'EPERM' || err.code === 'EEXIST' || err.code === 'EBUSY'
      if (!retriable || attempt >= RENAME_MAX_ATTEMPTS) throw err
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt))
    }
  }
}

export async function atomicWriteFile(file, content) {
  // 临时名带进程内单调序号（A1）：同一文件的并发写入（如 settings:update 与
  // 扫描完成回写）各自使用不同临时文件，避免后写方截断前写方内容、
  // 或先行方 rename 移走临时文件致后行方 ENOENT
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`
  let fh = null
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    fh = await fs.open(tmp, 'w')
    await fh.writeFile(content, { encoding: 'utf-8' })
    // fsync 刷盘数据块（A2）：必须在 rename 之前完成，使更名后的目标
    // 在断电后必为完整内容而非半写状态
    await fh.sync()
    await fh.close()
    fh = null
    await renameReplacing(tmp, file)
  } catch (err) {
    if (fh) {
      await fh.close().catch(() => {})
    }
    try {
      await fs.rm(tmp, { force: true })
    } catch {
      /* 清理失败可忽略 */
    }
    throw err
  }
}
