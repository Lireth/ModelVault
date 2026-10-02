import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * 原子写入文本文件（先写临时文件再重命名）（C2 自 store.js 拆出）。
 * 写入中断电/崩溃时不会损坏目标文件，settings.json、
 * window-state.json 与关联存储统一采用该策略。
 * @param {string} file 目标文件绝对路径
 * @param {string} content 待写入内容
 */
export async function atomicWriteFile(file, content) {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(tmp, content, 'utf-8')
    await fs.rename(tmp, file)
  } catch (err) {
    try {
      await fs.rm(tmp, { force: true })
    } catch {
      /* 清理失败可忽略 */
    }
    throw err
  }
}
