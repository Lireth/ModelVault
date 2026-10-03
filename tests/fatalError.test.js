import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeUserData } from './setup'

/**
 * fatal-error.js 单元测试（A3）：
 * 主进程未捕获异常的处理策略——
 * 1. 记录日志（含堆栈）；
 * 2. 尽力落盘（防抖中的元数据先行保存）；
 * 3. 展示错误框告知用户；
 * 4. relaunch + exit 优雅重启。
 * 处理进行中的后续异常被忽略，不重复触发重启。
 */

const timeline = []
const flushStoreSave = vi.fn()
const showErrorBox = vi.fn()
const relaunch = vi.fn()
const exit = vi.fn()
const loggerError = vi.fn()
const loggerWarn = vi.fn()

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => fakeUserData),
    isPackaged: true,
    relaunch,
    exit
  },
  dialog: { showErrorBox }
}))

vi.mock('../src/main/logger', () => ({
  default: { error: loggerError, warn: loggerWarn, info: vi.fn() }
}))

vi.mock('../src/main/services/store', () => ({
  flushStoreSave
}))

/** 每个用例以全新模块实例运行（处理中标记为模块级状态，跨用例需复位） */
async function freshHandler() {
  vi.resetModules()
  const mod = await import('../src/main/fatal-error')
  return mod.handleUncaughtException
}

const sampleError = Object.assign(new Error('boom'), {
  stack: 'Error: boom\n    at somewhere'
})

beforeEach(() => {
  timeline.length = 0
  vi.clearAllMocks()
  flushStoreSave.mockImplementation(async () => {
    timeline.push('flush')
  })
  showErrorBox.mockImplementation(async () => {
    timeline.push('dialog')
    return {}
  })
  relaunch.mockImplementation(() => timeline.push('relaunch'))
  exit.mockImplementation(() => timeline.push('exit'))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('handleUncaughtException', () => {
  it('记录日志后按「落盘 -> 提示 -> 重启」顺序处理（A3）', async () => {
    const handleUncaughtException = await freshHandler()
    await handleUncaughtException(sampleError)

    // 异常信息入日志（堆栈优先）
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining('未捕获的异常'))
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining('Error: boom'))
    // 顺序：先尽力保存数据，再提示用户，最后重启
    expect(timeline).toEqual(['flush', 'dialog', 'relaunch', 'exit'])
    expect(showErrorBox).toHaveBeenCalledWith(
      expect.stringContaining('模匣'),
      expect.stringContaining('重启')
    )
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('落盘失败不阻断重启：数据尽力保存后仍然提示并重启', async () => {
    const handleUncaughtException = await freshHandler()
    flushStoreSave.mockRejectedValue(new Error('磁盘已满'))

    await expect(handleUncaughtException(sampleError)).resolves.toBeUndefined()
    expect(flushStoreSave).toHaveBeenCalledTimes(1)
    expect(showErrorBox).toHaveBeenCalledTimes(1)
    expect(relaunch).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('处理进行中的后续异常被忽略，不重复触发重启', async () => {
    const handleUncaughtException = await freshHandler()
    let releaseFlush = () => {}
    flushStoreSave.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFlush = resolve
        })
    )

    const first = handleUncaughtException(sampleError)
    // 第一次尚在等待落盘：第二个致命异常到达
    const second = handleUncaughtException(sampleError)
    releaseFlush()
    await Promise.all([first, second])

    // 重启流程只执行一次，第二个异常仅记录警告
    expect(relaunch).toHaveBeenCalledTimes(1)
    expect(showErrorBox).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1)
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('忽略'))
  })
})
