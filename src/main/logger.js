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

/**
 * 单日单文件体积上限（O-2）：渲染进程异常经 app:reportError 汇入同一文件，
 * 异常刷屏时按天轮转不足以约束体积——单文件过大既难以打开查看，也可能在
 * 磁盘紧张时把日志写入自身撑到失败（写入降级为控制台后反而丢失现场）。
 */
const MAX_LOG_BYTES = 5 * 1024 * 1024
/**
 * 单日分片数上限（5MB × 5 ≈ 25MB/天）：超出后仅输出控制台并告警一次。
 * 与 14 天保留期共同构成日志占盘的硬上限，避免异常刷屏无限写盘。
 */
const MAX_LOG_FILES_PER_DAY = 5

/** 日志文件路径：index 0 为当日主文件，其余为分片（.1/.2…） */
function logFilePath(logDir, dateStr, index) {
  return path.join(logDir, index === 0 ? `modelvault-${dateStr}.log` : `modelvault-${dateStr}.${index}.log`)
}

/** 日志目录绝对路径（%APPDATA%/modelvault/logs；与文件写入流使用的目录一致）。
 * 独立为导出函数：设置页「打开日志目录」经 IPC 调用，无需先触发一次写日志 */
export function getLogDir() {
  return path.join(app.getPath('userData'), 'logs')
}

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
        const match = name.match(/^modelvault-(\d{4}-\d{2}-\d{2})(?:\.\d+)?\.log$/)
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
    /** 当日分片序号（0 主文件，1..MAX-1 为分片） */
    this.fileIndex = 0
    /** 当前分片已写入字节数（跨进程重启续写同文件时按实际体积初始化） */
    this.bytesWritten = 0
    /** 单日体积超限告警只发一次 */
    this.overflowWarned = false
  }

  /**
   * 创建日志写入流并挂错误监听（B14）。
   * 未监听 error 时，磁盘满/权限错误会作为 uncaughtException 抛出，
   * 且此后写日志静默失败；这里降级为控制台输出并置空流，下次写入时尝试重建。
   */
  createStream(dateStr, index) {
    const file = logFilePath(this.logDir, dateStr, index)
    // 续写既有文件（同一天内进程重启）时按实际体积初始化计数，否则体积上限失效
    let existing = 0
    try {
      const stat = fs.statSync(file)
      if (stat.isFile()) existing = stat.size
    } catch {
      /* 文件不存在（新建）：从 0 计 */
    }
    const stream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf-8' })
    stream.on('error', (err) => {
      console.error(`日志流错误（文件输出降级为控制台）: ${err.message}`)
      this.stream = null
    })
    this.bytesWritten = existing
    return stream
  }

  /** 懒初始化：首次写日志时才创建目录与写入流 */
  ensureStream() {
    if (!this.logDir) {
      this.logDir = getLogDir()
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true })
      }
      // 首次初始化时清理过期日志
      cleanExpiredLogs(this.logDir)
    }

    const today = localDateString()
    if (this.currentDate !== today) {
      // 跨天：序号与体积计数归零，关闭上一日的流
      this.currentDate = today
      this.fileIndex = 0
      this.bytesWritten = 0
      this.overflowWarned = false
      this.stream?.end()
      this.stream = null
    }
    if (!this.stream) {
      // 单日分片数用尽（异常刷屏）：仅保留控制台输出，写盘到此为止
      if (this.fileIndex >= MAX_LOG_FILES_PER_DAY) return null
      this.stream = this.createStream(today, this.fileIndex)
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

    // 文件输出（初始化失败/超限时静默降级，仅使用控制台）
    try {
      const bytes = Buffer.byteLength(line, 'utf-8')
      let stream = this.ensureStream()
      if (stream && this.bytesWritten + bytes > MAX_LOG_BYTES) {
        // 体积超限：滚动到当日下一个分片（序号用尽则仅控制台）
        this.fileIndex += 1
        stream.end()
        this.stream = null
        stream = this.ensureStream()
      }
      if (!stream) {
        if (!this.overflowWarned) {
          this.overflowWarned = true
          console.error(
            `日志已达单日体积上限（${MAX_LOG_FILES_PER_DAY} × ${MAX_LOG_BYTES / 1024 / 1024}MB），` +
              '后续日志仅输出到控制台'
          )
        }
        return
      }
      stream.write(line)
      this.bytesWritten += bytes
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
