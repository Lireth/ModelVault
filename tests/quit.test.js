import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeUserData } from './setup'

/**
 * quit.js 单元测试（A4）：
 * 窗口全部关闭后的退出编排——
 * 1. 停止目录监控，防止退出过程中 watcher 再触发重扫；
 * 2. 等待元数据与窗口状态两路落盘后 app.quit()；
 * 3. 落盘有确定性时间上限：磁盘挂起/被杀软锁文件时 flush 永不 settle，
 *    超时后记警告并 app.exit() 强制退出，保证「关窗后进程必退」。
 */

const timeline = []
const stopWatcher = vi.fn(() => timeline.push('stopWatcher'))
const flushStoreSave = vi.fn(async () => timeline.push('flushStore'))
const flushWindowStateSave = vi.fn(async () => timeline.push('flushWindow'))
const quit = vi.fn(() => timeline.push('quit'))
const exit = vi.fn(() => timeline.push('exit'))
const loggerInfo = vi.fn()
const loggerWarn = vi.fn()

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => fakeUserData),
    isPackaged: true,
    quit,
    exit
  }
}))

vi.mock('../src/main/logger', () => ({
  default: { info: loggerInfo, warn: loggerWarn, error: vi.fn() }
}))

vi.mock('../src/main/services/store', () => ({
  flushStoreSave
}))

vi.mock('../src/main/services/watcher', () => ({
  stopWatcher
}))

vi.mock('../src/main/windows/mainWindow', () => ({
  flushWindowStateSave
}))

/** 每个用例以全新模块实例运行（超时定时器为模块级状态，跨用例需复位） */
async function freshQuit() {
  vi.resetModules()
  const mod = await import('../src/main/quit')
  return mod.quitAfterFlush
}

beforeEach(() => {
  timeline.length = 0
  vi.clearAllMocks()
  flushStoreSave.mockImplementation(async () => timeline.push('flushStore'))
  flushWindowStateSave.mockImplementation(async () => timeline.push('flushWindow'))
  quit.mockImplementation(() => timeline.push('quit'))
  exit.mockImplementation(() => timeline.push('exit'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('quitAfterFlush', () => {
  it('正常路径：先停监控，等待两路落盘完成后 quit（A4）', async () => {
    const quitAfterFlush = await freshQuit()
    quitAfterFlush()

    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
    expect(timeline).toEqual(['stopWatcher', 'flushStore', 'flushWindow', 'quit'])
    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining('应用退出'))
    // 未超时：不触发强制退出
    expect(exit).not.toHaveBeenCalled()
  })

  it('落盘超时：记警告并强制 exit，保证关窗后进程必退', async () => {
    const quitAfterFlush = await freshQuit()
    vi.useFakeTimers()
    // 模拟磁盘挂起：两路 flush 均永不 settle
    flushStoreSave.mockImplementation(() => new Promise(() => {}))
    flushWindowStateSave.mockImplementation(() => new Promise(() => {}))

    quitAfterFlush()
    expect(quit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000)

    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('强制退出'))
    // 超时后不再走正常 quit 路径
    expect(quit).not.toHaveBeenCalled()
  })

  it('落盘失败不阻塞退出：记警告后仍然 quit', async () => {
    const quitAfterFlush = await freshQuit()
    flushStoreSave.mockRejectedValue(new Error('磁盘已满'))

    quitAfterFlush()

    await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1))
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('未完全成功'))
    expect(exit).not.toHaveBeenCalled()
  })

  it('超时后迟到的落盘完成不触发二次退出', async () => {
    const quitAfterFlush = await freshQuit()
    vi.useFakeTimers()
    let releaseFlush = () => {}
    flushStoreSave.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFlush = resolve
        })
    )
    flushWindowStateSave.mockImplementation(() => new Promise(() => {}))

    quitAfterFlush()
    await vi.advanceTimersByTimeAsync(5000)
    expect(exit).toHaveBeenCalledTimes(1)

    // 强制退出后磁盘恢复，落盘迟来完成：不应再触发 quit/exit
    releaseFlush()
    await vi.advanceTimersByTimeAsync(0)

    expect(exit).toHaveBeenCalledTimes(1)
    expect(quit).not.toHaveBeenCalled()
  })
})
