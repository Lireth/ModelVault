import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * 主进程未捕获异常处理（fatal-error.js，A3 + issue #74）单元测试：
 * - 首次崩溃：三路落盘 -> 错误框 -> relaunch（携带熔断计数参数）+ exit(1)，
 *   成功路径语义回归；
 * - 重启循环熔断（issue #74）：窗口内连续重启计数经 relaunch 参数跨进程
 *   携带，达阈值后不再 relaunch，弹框改提示手动处置，打断确定性崩溃
 *   形成的重启循环；落盘与 exit(1) 不因熔断降级；
 * - 窗口过期（超过熔断窗口）视为已恢复，重新计数并更新窗口起点；
 * - 启动参数损坏/缺失时安全按全新启动计数；
 * - 处理中防抖、落盘失败、错误框失败等既有容错语义回归。
 */

vi.mock('electron', () => ({
  app: {
    relaunch: vi.fn(),
    exit: vi.fn(),
  },
  dialog: {
    showErrorBox: vi.fn(),
  },
}))

vi.mock('../src/main/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock('../src/main/services/store', () => ({
  flushStoreSave: vi.fn(async () => {}),
  flushSettingsSave: vi.fn(async () => {}),
}))

vi.mock('../src/main/windows/mainWindow', () => ({
  flushWindowStateSave: vi.fn(async () => {}),
}))

import { app, dialog } from 'electron'
import logger from '../src/main/logger'
import { flushSettingsSave, flushStoreSave } from '../src/main/services/store'
import { flushWindowStateSave } from '../src/main/windows/mainWindow'
import {
  handleUncaughtException,
  resetFatalErrorForTests,
} from '../src/main/fatal-error'

/** 熔断判定基准时刻（真实量级的 epoch ms） */
const BASE_MS = 1_700_000_000_000

const realArgv = process.argv
let nowSpy

/** 构造携带熔断计数状态的重启链 argv（relaunch args 落在新进程 argv） */
function chainArgv(count, firstMs) {
  return [
    '/exe',
    `--fatal-restart-count=${count}`,
    `--fatal-restart-first=${firstMs}`,
  ]
}

beforeEach(() => {
  vi.clearAllMocks()
  resetFatalErrorForTests()
  process.argv = ['/exe']
  nowSpy = vi.spyOn(Date, 'now').mockReturnValue(BASE_MS)
})

afterEach(() => {
  process.argv = realArgv
  nowSpy.mockRestore()
})

describe('首次崩溃（成功路径语义回归）', () => {
  it('三路落盘后 relaunch 携带初始计数参数并 exit(1)，弹框提示自动重启', async () => {
    await handleUncaughtException(new Error('boom'))

    expect(flushStoreSave).toHaveBeenCalledTimes(1)
    expect(flushSettingsSave).toHaveBeenCalledTimes(1)
    expect(flushWindowStateSave).toHaveBeenCalledTimes(1)
    expect(app.relaunch).toHaveBeenCalledTimes(1)
    expect(app.relaunch).toHaveBeenCalledWith({
      args: ['--fatal-restart-count=1', `--fatal-restart-first=${BASE_MS}`],
    })
    expect(app.exit).toHaveBeenCalledWith(1)
    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      '模匣 遇到无法恢复的错误',
      expect.stringContaining('应用将保存数据后自动重启'),
    )
  })

  it('落盘失败不阻断重启判定与退出', async () => {
    vi.mocked(flushStoreSave).mockRejectedValueOnce(new Error('disk full'))

    await handleUncaughtException(new Error('boom'))

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('落盘失败'),
    )
    expect(app.relaunch).toHaveBeenCalledTimes(1)
    expect(app.exit).toHaveBeenCalledWith(1)
  })

  it('错误框展示失败不阻断重启', async () => {
    vi.mocked(dialog.showErrorBox).mockImplementationOnce(() => {
      throw new Error('no dialog')
    })

    await handleUncaughtException(new Error('boom'))

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('错误框展示失败'),
    )
    expect(app.relaunch).toHaveBeenCalledTimes(1)
    expect(app.exit).toHaveBeenCalledWith(1)
  })

  it('处理中到达的后续异常仅记录警告，不重复触发重启', async () => {
    await handleUncaughtException(new Error('first'))
    const relaunchCalls = vi.mocked(app.relaunch).mock.calls.length

    await handleUncaughtException(new Error('second'))

    expect(vi.mocked(app.relaunch).mock.calls.length).toBe(relaunchCalls)
    expect(logger.warn).toHaveBeenCalledWith(
      '已处于致命错误处理流程中，忽略后续异常',
    )
  })
})

describe('重启循环熔断（issue #74）', () => {
  it('窗口内连续重启计数递增且窗口起点延续', async () => {
    process.argv = chainArgv(2, BASE_MS)
    nowSpy.mockReturnValue(BASE_MS + 30_000)

    await handleUncaughtException(new Error('again'))

    expect(app.relaunch).toHaveBeenCalledTimes(1)
    expect(app.relaunch).toHaveBeenCalledWith({
      args: ['--fatal-restart-count=3', `--fatal-restart-first=${BASE_MS}`],
    })
    expect(app.exit).toHaveBeenCalledWith(1)
    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      '模匣 遇到无法恢复的错误',
      expect.stringContaining('应用将保存数据后自动重启'),
    )
  })

  it('窗口内计数达阈值后熔断：不再 relaunch，弹框改提示手动处置', async () => {
    process.argv = chainArgv(3, BASE_MS)
    nowSpy.mockReturnValue(BASE_MS + 30_000)

    await handleUncaughtException(new Error('loop'))

    expect(app.relaunch).not.toHaveBeenCalled()
    expect(app.exit).toHaveBeenCalledWith(1)
    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      '模匣 遇到无法恢复的错误',
      expect.stringContaining('已停止自动重启'),
    )
  })

  it('熔断生效时三路落盘仍执行（数据安全不因熔断降级）', async () => {
    process.argv = chainArgv(3, BASE_MS)

    await handleUncaughtException(new Error('loop'))

    expect(flushStoreSave).toHaveBeenCalledTimes(1)
    expect(flushSettingsSave).toHaveBeenCalledTimes(1)
    expect(flushWindowStateSave).toHaveBeenCalledTimes(1)
    expect(app.relaunch).not.toHaveBeenCalled()
    expect(app.exit).toHaveBeenCalledWith(1)
  })

  it('窗口过期视为已恢复：重新从 1 计数并更新窗口起点', async () => {
    process.argv = chainArgv(3, BASE_MS)
    nowSpy.mockReturnValue(BASE_MS + 60_001)

    await handleUncaughtException(new Error('later'))

    expect(app.relaunch).toHaveBeenCalledTimes(1)
    expect(app.relaunch).toHaveBeenCalledWith({
      args: [
        '--fatal-restart-count=1',
        `--fatal-restart-first=${BASE_MS + 60_001}`,
      ],
    })
  })

  it('启动参数损坏或缺失时安全按全新启动计数', async () => {
    // 计数超位数与非法窗口起点均不匹配解析白名单，等价全新启动
    process.argv = [
      '/exe',
      '--fatal-restart-count=9999',
      '--fatal-restart-not-a-flag=1',
    ]

    await handleUncaughtException(new Error('weird'))

    expect(app.relaunch).toHaveBeenCalledTimes(1)
    expect(app.relaunch).toHaveBeenCalledWith({
      args: ['--fatal-restart-count=1', `--fatal-restart-first=${BASE_MS}`],
    })
  })
})
