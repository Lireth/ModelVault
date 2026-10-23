import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import logger, { getLogDir } from '../src/main/logger'

/**
 * logger 单日体积上限与分片滚动（O-2）：
 * 渲染进程异常经 app:reportError 汇入同一日志文件，异常刷屏时仅按天轮转
 * 不足以约束体积——单文件超限后滚动到当日分片（.1/.2…），分片用尽后仅保留
 * 控制台输出，避免日志把磁盘写满后自身写入失败而丢失现场。
 *
 * 测试直接驱动单例内部状态（logDir/currentDate/fileIndex/bytesWritten），
 * 避免真实写入 5MB 数据；fileIndex 等字段的语义由 ensureStream 消费。
 */

/** 与 logger.localDateString 同规则（本地时区 YYYY-MM-DD） */
function todayStr(date = new Date()) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const MAX_LOG_BYTES = 5 * 1024 * 1024
const MAX_LOG_FILES_PER_DAY = 5

let logDir
/** 收集控制台输出，避免测试噪声并断言降级告警 */
let consoleError

/** 结束当前写入流并等待落盘（随后置空，使下次写入重新建流） */
async function flushStream() {
  const stream = logger.stream
  logger.stream = null
  if (!stream) return
  await new Promise((resolve) => stream.end(resolve))
}

/** 重置单例的跨测试状态 */
function resetLogger() {
  logger.stream?.destroy()
  logger.stream = null
  logger.logDir = logDir
  logger.currentDate = todayStr()
  logger.fileIndex = 0
  logger.bytesWritten = 0
  logger.overflowWarned = false
}

beforeEach(() => {
  logDir = getLogDir()
  fs.rmSync(logDir, { recursive: true, force: true })
  fs.mkdirSync(logDir, { recursive: true })
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  resetLogger()
})

afterEach(async () => {
  await flushStream()
  vi.restoreAllMocks()
  fs.rmSync(logDir, { recursive: true, force: true })
})

describe('logger 单日体积上限（O-2）', () => {
  it('未超限时写入当日主文件', async () => {
    logger.info('常规日志')
    await flushStream()
    const main = path.join(logDir, `modelvault-${todayStr()}.log`)
    expect(fs.readFileSync(main, 'utf8')).toContain('常规日志')
    expect(fs.existsSync(path.join(logDir, `modelvault-${todayStr()}.1.log`))).toBe(false)
  })

  it('主文件已达上限时滚动到当日分片，并保留本次日志', async () => {
    const main = path.join(logDir, `modelvault-${todayStr()}.log`)
    // 预置超限的主文件：createStream 按实际体积初始化计数，触发滚动分支
    fs.writeFileSync(main, Buffer.alloc(MAX_LOG_BYTES + 1, 0x61))
    const sizeBefore = fs.statSync(main).size

    logger.info('超限后的日志')
    await flushStream()

    const shard = path.join(logDir, `modelvault-${todayStr()}.1.log`)
    expect(fs.existsSync(shard)).toBe(true)
    expect(fs.readFileSync(shard, 'utf8')).toContain('超限后的日志')
    // 已达上限的主文件不再被追加
    expect(fs.statSync(main).size).toBe(sizeBefore)
  })

  it('分片数用尽后仅输出控制台，不再新建文件', async () => {
    logger.fileIndex = MAX_LOG_FILES_PER_DAY
    const before = fs.readdirSync(logDir).length

    logger.info('超限丢弃')
    logger.warn('超限丢弃2')
    await flushStream()

    expect(fs.readdirSync(logDir).length).toBe(before)
    const warned = consoleError.mock.calls.some((c) => String(c[0]).includes('单日体积上限'))
    expect(warned).toBe(true)
  })

  it('跨天后序号归零并写回当日主文件', async () => {
    logger.fileIndex = 3
    logger.currentDate = '1999-01-01'

    logger.info('新一天')
    await flushStream()

    expect(logger.fileIndex).toBe(0)
    const main = path.join(logDir, `modelvault-${todayStr()}.log`)
    expect(fs.readFileSync(main, 'utf8')).toContain('新一天')
  })

  it('过期清理识别各分片文件（.N.log 同样按日期回收）', async () => {
    const staleDate = '1999-01-01'
    for (const name of [
      `modelvault-${staleDate}.log`,
      `modelvault-${staleDate}.1.log`,
      `modelvault-${staleDate}.2.log`
    ]) {
      fs.writeFileSync(path.join(logDir, name), 'old')
    }
    // 触发一次全新初始化，走 cleanExpiredLogs 分支
    logger.logDir = null
    logger.stream = null
    logger.currentDate = ''
    logger.info('触发初始化')
    await flushStream()

    // 清理是异步的（readdir + rm），让出事件循环轮询等待
    const staleShard = path.join(logDir, `modelvault-${staleDate}.1.log`)
    for (let i = 0; i < 40 && fs.existsSync(staleShard); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(fs.existsSync(path.join(logDir, `modelvault-${staleDate}.log`))).toBe(false)
    expect(fs.existsSync(staleShard)).toBe(false)
    expect(fs.existsSync(path.join(logDir, `modelvault-${staleDate}.2.log`))).toBe(false)
  })
})