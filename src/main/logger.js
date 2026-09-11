import fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'
import { app } from 'electron'

/**
 * 轻量级日志模块：同时输出到控制台与日志文件。
 * 日志文件位置：%APPDATA%/modelvault/logs/modelvault-YYYY-MM-DD.log（按天分文件）
 * 启动时自动清理超过保留期的旧日志，避免磁盘无限累积。
 */

/** 日志保留天数：超过该天数的旧日志文件在启动时删除 */
const LOG_RETENTION_DAYS = 14

/** 本地日期字符串（YYYY-MM-DD）：使用本地时区，避免 UTC 日期导致跨天错位 */
function localDateString(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 清理超过保留期的旧日志文件（异步执行，失败不影响日志功能） */
function cleanExpiredLogs(logDir) {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - LOG_RETENTION_DAYS)
  const cutoffStr = localDateString(cutoff)
  fs.promises
    .readdir(logDir)
    .then((files) => {
      const stale = files.filter((name) => {
        const match = name.match(/^modelvault-(\d{4}-\d{2}-\d{2})\.log$/)
        return match && match[1] < cutoffStr
      })
      return Promise.all(stale.map((name) => fs.promises.rm(path.join(logDir, name), { force: true })))
        .then(() => {
          if (stale.length > 0) console.log(`已清理 ${stale.length} 个过期日志文件`)
        })
    })
    .catch(() => {
      /* 清理失败可忽略 */
    })
}

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
      // 首次初始化时清理过期日志
      cleanExpiredLogs(this.logDir)
    }

    const today = localDateString()
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
