import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * 原子写入文本文件（先写临时文件再重命名）（C2 自 store.js 拆出）。
 * 写入中断电/崩溃时不会损坏目标文件，settings.json、
 * window-state.json 与关联存储统一采用该策略。
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
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(tmp, content, 'utf-8')
    await renameReplacing(tmp, file)
  } catch (err) {
    try {
      await fs.rm(tmp, { force: true })
    } catch {
      /* 清理失败可忽略 */
    }
    throw err
  }
}
