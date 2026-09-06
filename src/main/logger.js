import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import { app } from 'electron'

/**
 * 轻量级日志模块：同时输出到控制台与日志文件。
 * 日志文件位置：%APPDATA%/modelvault/logs/modelvault-YYYY-MM-DD.log（按天分文件）
 */
class Logger {
  constructor() {
    this.logDir = null
    this.stream = null
    this.currentDate = ''
  }

  /** 懒初始化：首次写日志时才创建目录与写入流 */
  ensureStream() {
    if (!this.logDir) {
      this.logDir = path.join(app.getPath('userData'), 'logs')
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true })
      }
    }

    const today = new Date().toISOString().slice(0, 10)
    if (this.currentDate !== today || !this.stream) {
      this.currentDate = today
      this.stream?.end()
      this.stream = fs.createWriteStream(path.join(this.logDir, `modelvault-${today}.log`), {
        flags: 'a',
        encoding: 'utf-8'
      })
    }
    return this.stream
  }

  write(level, args) {
    const time = new Date().toLocaleString('zh-CN', { hour12: false })
    const line = `[${time}] [${level}] ${util.format(...args)}\n`

    // 控制台输出
    if (level === 'ERROR') {
      console.error(line.trimEnd())
    } else {
      console.log(line.trimEnd())
    }

    // 文件输出（初始化失败时静默降级，仅使用控制台）
    try {
      this.ensureStream().write(line)
    } catch (err) {
      console.error(`日志写入失败: ${err.message}`)
    }
  }

  info(...args) {
    this.write('INFO', args)
  }

  warn(...args) {
    this.write('WARN', args)
  }

  error(...args) {
    this.write('ERROR', args)
  }
}

const logger = new Logger()
export default logger
