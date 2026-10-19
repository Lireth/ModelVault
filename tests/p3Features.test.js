import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeUserData } from './setup'

/**
 * P3 新功能纯函数特征测试：
 * - compareVersions / checkForUpdate（E1 更新检查）：版本比较、下载页域名白名单（B3）
 */

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => fakeUserData),
    isPackaged: true,
    getVersion: vi.fn(() => '0.1.0')
  },
  net: { fetch: vi.fn() }
}))

import { checkForUpdate, compareVersions } from '../src/main/services/updater'
import { net } from 'electron'

describe('compareVersions（E1 更新检查）', () => {
  it('逐段数字比较，支持不等长版本号', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1)
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('0.1.0', '0.2.0')).toBe(-1)
    expect(compareVersions('1.0', '0.9.9')).toBe(1)
    expect(compareVersions('0.1', '0.1.1')).toBe(-1)
  })

  it('非数字段按 0 处理（beta 后缀场景回退安全）', () => {
    expect(compareVersions('0.1.0', '0.1.0-beta')).toBe(0)
  })
})

describe('checkForUpdate（E1 / B3 下载页域名白名单）', () => {
  beforeEach(() => {
    vi.mocked(net.fetch).mockReset()
  })

  it('有更新时返回白名单内的 GitHub 下载页地址', async () => {
    vi.mocked(net.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v9.9.9',
        html_url: 'https://github.com/Lireth/ModelVault/releases/tag/v9.9.9',
        body: '更新说明'
      })
    })
    const res = await checkForUpdate()
    expect(res.error).toBeUndefined()
    expect(res.hasUpdate).toBe(true)
    expect(res.latest).toBe('9.9.9')
    expect(res.releaseUrl).toBe('https://github.com/Lireth/ModelVault/releases/tag/v9.9.9')
  })

  it('API 返回非白名单域名时忽略下载页地址（不向渲染层提供外链）', async () => {
    vi.mocked(net.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        tag_name: 'v9.9.9',
        html_url: 'https://evil.example.com/ModelVault-Setup.exe'
      })
    })
    const res = await checkForUpdate()
    expect(res.hasUpdate).toBe(true)
    // 地址被剔除：渲染层 v-if 隐藏「前往下载」，用户不会被引向白名单外站点
    expect(res.releaseUrl).toBe('')
  })

  it('缺少 html_url 时不留空地址（渲染层隐藏下载入口）', async () => {
    vi.mocked(net.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tag_name: 'v9.9.9' })
    })
    const res = await checkForUpdate()
    expect(res.hasUpdate).toBe(true)
    expect(res.releaseUrl).toBe('')
  })
})
