import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fakeUserData } from './setup'

/**
 * 应用内检查更新（updater.js，E1/O-3/V-06/A2）单元测试：
 * - compareVersions：数字段比较（非字典序、缺段补零）；
 * - checkForUpdate：Latest 主路径 / 404 视为最新 / 限流可辨识文案 /
 *   V-06 遗留标签回查兜底（A2）/ 下载页白名单过滤 / 超时与异常映射 /
 *   资产可用性（canDownload/downloadSize）与 pending 登记；
 * - runStartupUpdateCheck：设置开关、失败静默、仅「有更新」推送子集载荷；
 * - scheduleStartupUpdateCheck：dev/冒烟跳过、延迟触发、重复调用幂等、
 *   广播经 BrowserWindow 白名单事件出口。
 * update-download 仅桩掉网络入口与模块态写入，findUpdateAssets/
 * isSafeUpdateVersion 用真实实现（资产校验语义在本文件一并锁定）。
 */

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => fakeUserData),
    isPackaged: true,
    getVersion: vi.fn(() => '0.6.0'),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  net: { fetch: vi.fn(), request: vi.fn() },
}))

vi.mock('../src/main/services/store-settings', () => ({
  getSettings: vi.fn(() => ({})),
}))

vi.mock('../src/main/services/update-download', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    fetchAllowedUpdateUrl: vi.fn(),
    setPendingUpdate: vi.fn(),
  }
})

import { app, BrowserWindow } from 'electron'
import {
  fetchAllowedUpdateUrl,
  setPendingUpdate,
} from '../src/main/services/update-download'
import { getSettings } from '../src/main/services/store-settings'
import {
  compareVersions,
  checkForUpdate,
  runStartupUpdateCheck,
  scheduleStartupUpdateCheck,
} from '../src/main/services/updater'

/** 合规 Release 载荷（含命名约定资产对） */
const releasePayload = (over = {}) => ({
  tag_name: 'v9.9.9',
  html_url: 'https://github.com/Lireth/ModelVault/releases/tag/v9.9.9',
  body: 'release notes',
  assets: [
    {
      name: 'ModelVault-9.9.9.exe',
      browser_download_url:
        'https://github.com/Lireth/ModelVault/releases/download/v9.9.9/ModelVault-9.9.9.exe',
      size: 111,
    },
    {
      name: 'ModelVault-9.9.9.exe.sha256',
      browser_download_url:
        'https://github.com/Lireth/ModelVault/releases/download/v9.9.9/ModelVault-9.9.9.exe.sha256',
      size: 100,
    },
  ],
  ...over,
})

const jsonRes = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers })

beforeEach(() => {
  vi.mocked(fetchAllowedUpdateUrl).mockReset()
  vi.mocked(setPendingUpdate).mockReset()
  vi.mocked(app.getVersion).mockReturnValue('0.6.0')
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([])
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env.MODELVAULT_SMOKE
})

describe('compareVersions', () => {
  it('按数字段比较：10 > 9，缺段补零，非法段视为 0', () => {
    expect(compareVersions('0.6.0', '0.5.9')).toBe(1)
    expect(compareVersions('10.0.0', '9.99.99')).toBe(1)
    expect(compareVersions('0.6.0', '0.6.1')).toBe(-1)
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.6.0', '0.6.0')).toBe(0)
    expect(compareVersions('x.y', '0.0')).toBe(0)
  })
})

describe('checkForUpdate（主路径）', () => {
  it('发现新版本：返回完整结果、登记可下载资产并透传大小', async () => {
    vi.mocked(fetchAllowedUpdateUrl).mockResolvedValue(
      jsonRes(releasePayload()),
    )
    const r = await checkForUpdate()
    expect(r).toMatchObject({
      current: '0.6.0',
      latest: '9.9.9',
      hasUpdate: true,
      releaseUrl: 'https://github.com/Lireth/ModelVault/releases/tag/v9.9.9',
      releaseNotes: 'release notes',
      canDownload: true,
      downloadSize: 111,
    })
    expect(setPendingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ size: 111 }),
      '9.9.9',
    )
    expect(fetchAllowedUpdateUrl).toHaveBeenCalledTimes(1)
  })

  it('已是最新：hasUpdate=false 且清空 pending（不保留旧资产）', async () => {
    vi.mocked(fetchAllowedUpdateUrl).mockResolvedValue(
      jsonRes(releasePayload({ tag_name: 'v0.6.0' })),
    )
    const r = await checkForUpdate()
    expect(r.hasUpdate).toBe(false)
    expect(r.canDownload).toBe(false)
    expect(setPendingUpdate).toHaveBeenCalledWith(null, '0.6.0')
  })

  it('发布说明超 500 字符截断', async () => {
    vi.mocked(fetchAllowedUpdateUrl).mockResolvedValue(
      jsonRes(releasePayload({ body: 'x'.repeat(600), tag_name: 'v0.7.0' })),
    )
    const r = await checkForUpdate()
    expect(r.releaseNotes).toHaveLength(500)
  })

  it('仓库无任何 Release（404）：视为已是最新且不登记 pending', async () => {
    vi.mocked(fetchAllowedUpdateUrl).mockResolvedValue(
      jsonRes({ message: 'Not Found' }, 404),
    )
    const r = await checkForUpdate()
    expect(r).toEqual({ current: '0.6.0', hasUpdate: false })
    expect(setPendingUpdate).not.toHaveBeenCalled()
  })

  it('缺少 tag_name：格式异常报错', async () => {
    vi.mocked(fetchAllowedUpdateUrl).mockResolvedValue(jsonRes({ body: 'x' }))
    const r = await checkForUpdate()
    expect(r.error).toContain('缺少版本号')
  })

  it('GitHub API 限流（403 + x-ratelimit-remaining:0）给出可辨识文案（OPT-13）', async () => {
    vi.mocked(fetchAllowedUpdateUrl).mockResolvedValue(
      jsonRes({}, 403, { 'x-ratelimit-remaining': '0' }),
    )
    const r = await checkForUpdate()
    expect(r.error).toContain('限流')
  })

  it('其他 HTTP 错误透传状态码', async () => {
    vi.mocked(fetchAllowedUpdateUrl).mockResolvedValue(jsonRes({}, 500))
    const r = await checkForUpdate()
    expect(r.error).toContain('HTTP 500')
  })

  it('响应体非法 JSON：解析失败文案', async () => {
    vi.mocked(fetchAllowedUpdateUrl).mockResolvedValue(
      new Response('not-json', { status: 200 }),
    )
    const r = await checkForUpdate()
    expect(r.error).toContain('解析失败')
  })

  it('下载页地址不在外链白名单：置空并放行（不引导用户离站）', async () => {
    vi.mocked(fetchAllowedUpdateUrl).mockResolvedValue(
      jsonRes(
        releasePayload({
          html_url: 'https://evil.example.com/phishing',
          tag_name: 'v0.7.0',
        }),
      ),
    )
    const r = await checkForUpdate()
    expect(r.releaseUrl).toBe('')
  })

  it('请求超时（TimeoutError/AbortError）映射为超时文案', async () => {
    const timeout = new Error('The operation was aborted due to timeout')
    timeout.name = 'TimeoutError'
    vi.mocked(fetchAllowedUpdateUrl).mockRejectedValue(timeout)
    const r = await checkForUpdate()
    expect(r.error).toContain('超时')
  })

  it('其他网络异常统一兜底为失败文案', async () => {
    vi.mocked(fetchAllowedUpdateUrl).mockRejectedValue(new Error('dns down'))
    const r = await checkForUpdate()
    expect(r.error).toContain('dns down')
  })
})

describe('checkForUpdate（A2 遗留标签回查兜底）', () => {
  it('Latest 为遗留非语义化标签：回查列表取最新合规版本', async () => {
    vi.mocked(fetchAllowedUpdateUrl)
      .mockResolvedValueOnce(jsonRes(releasePayload({ tag_name: 'Beta-0.9' })))
      .mockResolvedValueOnce(
        jsonRes([
          { tag_name: 'Beta-0.8' },
          releasePayload({ tag_name: 'v0.7.0' }),
        ]),
      )
    const r = await checkForUpdate()
    expect(r).toMatchObject({ latest: '0.7.0', hasUpdate: true })
    expect(fetchAllowedUpdateUrl).toHaveBeenCalledTimes(2)
    expect(fetchAllowedUpdateUrl.mock.calls[1][0]).toContain(
      'releases?per_page=10',
    )
  })

  it('列表内也无合规版本：静默视为暂无更新（不打扰用户）', async () => {
    vi.mocked(fetchAllowedUpdateUrl)
      .mockResolvedValueOnce(jsonRes(releasePayload({ tag_name: 'Beta-0.9' })))
      .mockResolvedValueOnce(jsonRes([{ tag_name: 'Beta-0.3' }]))
    const r = await checkForUpdate()
    expect(r).toEqual({ current: '0.6.0', hasUpdate: false })
    expect(r.error).toBeUndefined()
  })

  it('回查请求失败：错误透传给调用方', async () => {
    vi.mocked(fetchAllowedUpdateUrl)
      .mockResolvedValueOnce(jsonRes(releasePayload({ tag_name: 'Beta-0.9' })))
      .mockResolvedValueOnce(jsonRes({}, 502))
    const r = await checkForUpdate()
    expect(r.error).toContain('HTTP 502')
  })
})

describe('runStartupUpdateCheck（启动静默检查决策）', () => {
  it('设置关闭：不发任何请求直接跳过', async () => {
    const check = vi.fn()
    const notify = vi.fn()
    expect(
      await runStartupUpdateCheck({ autoCheckUpdate: false }, check, notify),
    ).toBe(false)
    expect(check).not.toHaveBeenCalled()
  })

  it('检查失败或无更新：静默结束不推送', async () => {
    const notify = vi.fn()
    expect(
      await runStartupUpdateCheck(
        { autoCheckUpdate: true },
        async () => ({ error: '网络失败' }),
        notify,
      ),
    ).toBe(false)
    expect(
      await runStartupUpdateCheck(
        { autoCheckUpdate: true },
        async () => ({ hasUpdate: false }),
        notify,
      ),
    ).toBe(false)
    expect(notify).not.toHaveBeenCalled()
  })

  it('有更新：推送渲染层所需子集，缺失字段补默认值', async () => {
    const notify = vi.fn()
    const ok = await runStartupUpdateCheck(
      { autoCheckUpdate: true },
      async () => ({ current: '0.6.0', latest: '0.7.0', hasUpdate: true }),
      notify,
    )
    expect(ok).toBe(true)
    expect(notify).toHaveBeenCalledWith({
      current: '0.6.0',
      latest: '0.7.0',
      releaseUrl: '',
      releaseNotes: '',
      canDownload: false,
      downloadSize: 0,
    })
  })
})

describe('scheduleStartupUpdateCheck（延迟调度与广播出口）', () => {
  it('开发环境（未打包）不安排检查', async () => {
    vi.useFakeTimers()
    vi.mocked(app.isPackaged, true)
    Object.defineProperty(app, 'isPackaged', {
      value: false,
      configurable: true,
      writable: true,
    })
    try {
      scheduleStartupUpdateCheck(1000)
      await vi.advanceTimersByTimeAsync(2000)
      expect(fetchAllowedUpdateUrl).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(app, 'isPackaged', {
        value: true,
        configurable: true,
        writable: true,
      })
    }
  })

  it('冒烟模式（MODELVAULT_SMOKE=1）不发起网络请求', () => {
    process.env.MODELVAULT_SMOKE = '1'
    scheduleStartupUpdateCheck(10)
    expect(fetchAllowedUpdateUrl).not.toHaveBeenCalled()
  })

  it('打包环境延迟触发：命中设置后经 app:updateAvailable 广播所有窗口', async () => {
    vi.useFakeTimers()
    vi.mocked(getSettings).mockReturnValue({ autoCheckUpdate: true })
    vi.mocked(fetchAllowedUpdateUrl).mockResolvedValue(
      jsonRes(releasePayload()),
    )
    const send = vi.fn()
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
      { isDestroyed: () => false, webContents: { send } },
      { isDestroyed: () => true, webContents: { send } },
    ])
    scheduleStartupUpdateCheck(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchAllowedUpdateUrl).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
    const [channel, payload] = send.mock.calls[0]
    expect(channel).toBe('app:updateAvailable')
    expect(payload).toMatchObject({ latest: '9.9.9', canDownload: true })
  })

  it('重复调用覆盖未触发的定时器（幂等，仅执行一次）', async () => {
    vi.useFakeTimers()
    vi.mocked(getSettings).mockReturnValue({ autoCheckUpdate: true })
    vi.mocked(fetchAllowedUpdateUrl).mockResolvedValue(
      jsonRes(releasePayload()),
    )
    scheduleStartupUpdateCheck(1000)
    scheduleStartupUpdateCheck(1000)
    await vi.advanceTimersByTimeAsync(500)
    scheduleStartupUpdateCheck(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchAllowedUpdateUrl).toHaveBeenCalledTimes(1)
  })
})
