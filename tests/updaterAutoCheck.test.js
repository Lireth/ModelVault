import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 启动自动检查更新测试（O-3）：
 * - runStartupUpdateCheck 决策逻辑：设置关闭跳过（零网络）、失败/无更新静默、
 *   有更新时推送规范化载荷；
 * - scheduleStartupUpdateCheck：开发环境与冒烟模式跳过、打包环境延迟执行且
 *   是否请求由触发时刻设置值决定。
 *
 * electron 按文件替换 mock（setup.js 全局桩无 BrowserWindow）：
 * app.isPackaged / BrowserWindow.getAllWindows 由本文件控制。
 */

const { electronMock, getSettingsMock } = vi.hoisted(() => ({
  electronMock: {
    app: {
      getPath: vi.fn(() => '/tmp/modelvault-updater-ud'),
      getVersion: vi.fn(() => '0.4.0'),
      isPackaged: true,
    },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
  },
  getSettingsMock: vi.fn(),
}))

vi.mock('electron', () => electronMock)
vi.mock('../src/main/services/store-settings', () => ({
  getSettings: getSettingsMock,
}))

import {
  runStartupUpdateCheck,
  scheduleStartupUpdateCheck,
} from '../src/main/services/updater'

describe('runStartupUpdateCheck（启动检查决策逻辑）', () => {
  it('设置关闭时直接跳过，不发起任何检查', async () => {
    const check = vi.fn()
    const notify = vi.fn()
    const pushed = await runStartupUpdateCheck(
      { autoCheckUpdate: false },
      check,
      notify,
    )
    expect(pushed).toBe(false)
    expect(check).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('settings 缺失（旧版本库设置）时视为关闭', async () => {
    const check = vi.fn()
    const pushed = await runStartupUpdateCheck(null, check, vi.fn())
    expect(pushed).toBe(false)
    expect(check).not.toHaveBeenCalled()
  })

  it('检查失败（{ error }）时静默结束，不推送', async () => {
    const notify = vi.fn()
    const pushed = await runStartupUpdateCheck(
      { autoCheckUpdate: true },
      vi.fn(async () => ({ error: '更新检查超时', current: '0.4.0' })),
      notify,
    )
    expect(pushed).toBe(false)
    expect(notify).not.toHaveBeenCalled()
  })

  it('已是最新版本（hasUpdate=false）时静默结束，不推送', async () => {
    const notify = vi.fn()
    const pushed = await runStartupUpdateCheck(
      { autoCheckUpdate: true },
      vi.fn(async () => ({ current: '0.4.0', hasUpdate: false })),
      notify,
    )
    expect(pushed).toBe(false)
    expect(notify).not.toHaveBeenCalled()
  })

  it('有更新时推送规范化载荷：仅渲染层所需子集，缺省字段补齐', async () => {
    const notify = vi.fn()
    const pushed = await runStartupUpdateCheck(
      { autoCheckUpdate: true },
      vi.fn(async () => ({
        current: '0.4.0',
        latest: '0.5.0',
        hasUpdate: true,
        releaseUrl: 'https://github.com/Lireth/ModelVault/releases/tag/v0.5.0',
        releaseNotes: '新功能',
        canDownload: true,
        downloadSize: 123,
        // 渲染层不需要的内部字段应被丢弃
        releaseNotesHtml: '<script>',
      })),
      notify,
    )
    expect(pushed).toBe(true)
    expect(notify).toHaveBeenCalledWith({
      current: '0.4.0',
      latest: '0.5.0',
      releaseUrl: 'https://github.com/Lireth/ModelVault/releases/tag/v0.5.0',
      releaseNotes: '新功能',
      canDownload: true,
      downloadSize: 123,
    })
  })

  it('releaseUrl/canDownload 缺省时归一为空串/false（载荷形状稳定）', async () => {
    const notify = vi.fn()
    await runStartupUpdateCheck(
      { autoCheckUpdate: true },
      vi.fn(async () => ({
        current: '0.4.0',
        latest: '0.5.0',
        hasUpdate: true,
      })),
      notify,
    )
    expect(notify).toHaveBeenCalledWith({
      current: '0.4.0',
      latest: '0.5.0',
      releaseUrl: '',
      releaseNotes: '',
      canDownload: false,
      downloadSize: 0,
    })
  })

  it('check 抛出异常时向上传播（由调度方 catch 记日志）', async () => {
    await expect(
      runStartupUpdateCheck(
        { autoCheckUpdate: true },
        vi.fn(async () => {
          throw new Error('network down')
        }),
        vi.fn(),
      ),
    ).rejects.toThrow('network down')
  })
})

describe('scheduleStartupUpdateCheck（启动调度）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    electronMock.app.isPackaged = true
    delete process.env.MODELVAULT_SMOKE
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('开发环境（未打包）直接跳过，不安排定时器', () => {
    electronMock.app.isPackaged = false
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    scheduleStartupUpdateCheck(1000)
    expect(timerSpy).not.toHaveBeenCalled()
  })

  it('冒烟模式（MODELVAULT_SMOKE=1）直接跳过，保证 CI 确定性', () => {
    process.env.MODELVAULT_SMOKE = '1'
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    scheduleStartupUpdateCheck(1000)
    expect(timerSpy).not.toHaveBeenCalled()
  })

  it('打包环境延迟执行：触发时设置已关闭则不发请求、不广播', async () => {
    getSettingsMock.mockReturnValue({ autoCheckUpdate: false })
    scheduleStartupUpdateCheck(15000)
    await vi.advanceTimersByTimeAsync(15000)
    expect(getSettingsMock).toHaveBeenCalled()
    // checkForUpdate 若被调用会尝试真实网络（本文件未 mock 其依赖）：
    // 设置关闭路径在发起请求前短路， advancing 后无未处理定时器即可证明
    expect(vi.getTimerCount()).toBe(0)
  })

  it('重复调用幂等：前次未触发的定时器被覆盖，不叠加执行', async () => {
    getSettingsMock.mockReturnValue({ autoCheckUpdate: false })
    scheduleStartupUpdateCheck(15000)
    scheduleStartupUpdateCheck(15000)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(15000)
    expect(getSettingsMock).toHaveBeenCalledTimes(1)
  })
})
