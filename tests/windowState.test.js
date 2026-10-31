import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fakeUserData } from './setup'

/**
 * loadWindowState 窗口状态恢复的健壮性单元测试（P0-6）：
 * 状态文件位于 userData（半信任面，可能被外部工具改写/写坏），畸形几何值
 * （负数尺寸/1e12 类极端值/超界坐标）与异常膨胀的文件必须回退默认窗口
 * 状态（null），不得进入 BrowserWindow 构造。
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  screen: {
    getAllDisplays: vi.fn(() => [
      { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    ]),
  },
  BrowserWindow: Object.assign(vi.fn(), {
    fromWebContents: vi.fn(),
    getAllWindows: vi.fn(() => []),
  }),
}))

import {
  createRendererCrashRecovery,
  loadWindowState,
} from '../src/main/windows/mainWindow'

const stateFile = () => path.join(fakeUserData, 'window-state.json')

function writeState(raw) {
  fs.writeFileSync(stateFile(), JSON.stringify(raw))
}

describe('loadWindowState 健壮性', () => {
  beforeEach(() => {
    fs.rmSync(stateFile(), { force: true })
  })

  it('合理范围内的状态原样恢复（含最大化标记）', async () => {
    writeState({ x: 100, y: 50, width: 1200, height: 800, maximized: true })
    await expect(loadWindowState()).resolves.toEqual({
      x: 100,
      y: 50,
      width: 1200,
      height: 800,
      maximized: true,
    })
  })

  it('负数 / 超大（1e12）/ 过小尺寸回退默认，不进 BrowserWindow 构造', async () => {
    writeState({ x: 100, y: 50, width: -5, height: 800 })
    await expect(loadWindowState()).resolves.toBeNull()
    writeState({ x: 100, y: 50, width: 1e12, height: 800 })
    await expect(loadWindowState()).resolves.toBeNull()
    writeState({ x: 100, y: 50, width: 1200, height: 100 })
    await expect(loadWindowState()).resolves.toBeNull()
  })

  it('坐标绝对值超出上限（1e9）回退默认', async () => {
    writeState({ x: 1e9, y: 50, width: 1200, height: 800 })
    await expect(loadWindowState()).resolves.toBeNull()
  })

  it('文件体积超过 64KB 上限不解析（异常膨胀防护）', async () => {
    fs.writeFileSync(stateFile(), `{"x":${'1'.repeat(100 * 1024)}}`)
    await expect(loadWindowState()).resolves.toBeNull()
  })

  it('非有限数值 / 位置在所有显示器之外回退默认（既有行为锁定）', async () => {
    writeState({ x: 'a', y: 50, width: 1200, height: 800 })
    await expect(loadWindowState()).resolves.toBeNull()
    writeState({ x: 5000, y: 50, width: 1200, height: 800 })
    await expect(loadWindowState()).resolves.toBeNull()
  })
})

describe('createRendererCrashRecovery 渲染进程崩溃恢复（OPT-12）', () => {
  const TIMING = {
    maxAutoReloads: 2,
    reloadDelayMs: 5,
    survivalResetMs: 30,
    recoverTotalMax: 10,
  }

  /** 最小主窗口结构（webContents.reload 计数） */
  function makeFakeWin() {
    return {
      destroyed: false,
      webContents: {
        reloadCalls: 0,
        reload() {
          this.reloadCalls += 1
        },
      },
      isDestroyed() {
        return this.destroyed
      },
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  it('crashed 按退避自动重载；clean-exit 不恢复（窗口关闭链路）', async () => {
    const win = makeFakeWin()
    const showGiveUpDialog = vi.fn()
    const recovery = createRendererCrashRecovery(
      win,
      { showGiveUpDialog },
      TIMING,
    )

    recovery.onRendererGone({ reason: 'crashed' })
    await sleep(30)
    expect(win.webContents.reloadCalls).toBe(1)
    expect(showGiveUpDialog).not.toHaveBeenCalled()

    // clean-exit：页面正常退出（窗口关闭链路），不触发恢复重载
    recovery.onRendererGone({ reason: 'clean-exit' })
    await sleep(30)
    expect(win.webContents.reloadCalls).toBe(1)
    recovery.dispose()
  })

  it('连续崩溃超限后停止自动恢复并弹框交用户决策', async () => {
    const win = makeFakeWin()
    const showGiveUpDialog = vi.fn()
    const recovery = createRendererCrashRecovery(
      win,
      { showGiveUpDialog },
      TIMING,
    )

    // 真实时序：每次崩溃发生在上一次重载重启页面之后（页面重启→再次崩溃）
    recovery.onRendererGone({ reason: 'crashed' })
    await sleep(20)
    expect(win.webContents.reloadCalls).toBe(1)
    recovery.onRendererGone({ reason: 'oom' })
    await sleep(30)
    expect(win.webContents.reloadCalls).toBe(2)
    expect(showGiveUpDialog).not.toHaveBeenCalled()

    // 第 3 次连续崩溃：超过 maxAutoReloads（2），放弃静默循环
    //（快速崩溃循环下新崩溃会取消未决重载——空转重载不如尽快交用户决策）
    recovery.onRendererGone({ reason: 'crashed' })
    expect(win.webContents.reloadCalls).toBe(2)
    expect(showGiveUpDialog).toHaveBeenCalledTimes(1)
    expect(showGiveUpDialog.mock.calls[0][0]).toBe(3)

    // 用户在弹框选择「重新加载」：计数重置并重载，再次崩溃仍可自动恢复
    showGiveUpDialog.mock.calls[0][1]()
    expect(win.webContents.reloadCalls).toBe(3)
    recovery.onRendererGone({ reason: 'crashed' })
    await sleep(30)
    expect(win.webContents.reloadCalls).toBe(4)
    expect(showGiveUpDialog).toHaveBeenCalledTimes(1)
    recovery.dispose()
  })

  it('加载成功并存活超过存活窗口后计数清零（慢性循环防护不误伤偶发）', async () => {
    const win = makeFakeWin()
    const showGiveUpDialog = vi.fn()
    const recovery = createRendererCrashRecovery(
      win,
      { showGiveUpDialog },
      TIMING,
    )

    recovery.onRendererGone({ reason: 'crashed' })
    await sleep(20)
    expect(win.webContents.reloadCalls).toBe(1)

    // 页面重载成功且存活超过 survivalResetMs（30ms）：连续计数清零
    recovery.onRendererLoaded()
    await sleep(45)

    // 两次新的偶发崩溃照常自动恢复（各自在上一次重载之后发生），
    // 不触发放弃弹框
    recovery.onRendererGone({ reason: 'oom' })
    await sleep(20)
    recovery.onRendererGone({ reason: 'crashed' })
    await sleep(30)
    expect(win.webContents.reloadCalls).toBe(3)
    expect(showGiveUpDialog).not.toHaveBeenCalled()
    recovery.dispose()
  })

  it('重载前窗口已销毁时跳过重载；dispose 清理未决定时器', async () => {
    const win = makeFakeWin()
    const recovery = createRendererCrashRecovery(win, {}, TIMING)

    recovery.onRendererGone({ reason: 'crashed' })
    win.destroyed = true
    await sleep(30)
    expect(win.webContents.reloadCalls).toBe(0)
    recovery.dispose()

    // dispose 后未决的重载定时器不再触发（窗口销毁路径防泄漏）
    const win2 = makeFakeWin()
    const recovery2 = createRendererCrashRecovery(win2, {}, TIMING)
    recovery2.onRendererGone({ reason: 'crashed' })
    recovery2.dispose()
    await sleep(30)
    expect(win2.webContents.reloadCalls).toBe(0)
  })
})
