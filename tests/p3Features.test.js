import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeUserData } from './setup'

/**
 * P3 新功能纯函数特征测试：
 * - compareVersions / checkForUpdate（E1 更新检查）：版本比较、下载页域名白名单（B3）
 * - 遗留非语义化标签迁移（A2）：Latest 为 Beta-0.x 时回查 Release 列表取最新
 *   合规版本，注入式 tag 一律跳过（V-06 不放宽）
 */

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => fakeUserData),
    isPackaged: true,
    getVersion: vi.fn(() => '0.1.0'),
  },
  net: { fetch: vi.fn() },
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
    vi.mocked(net.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v9.9.9',
          html_url: 'https://github.com/Lireth/ModelVault/releases/tag/v9.9.9',
          body: '更新说明',
        }),
        { status: 200 },
      ),
    )
    const res = await checkForUpdate()
    expect(res.error).toBeUndefined()
    expect(res.hasUpdate).toBe(true)
    expect(res.latest).toBe('9.9.9')
    expect(res.releaseUrl).toBe(
      'https://github.com/Lireth/ModelVault/releases/tag/v9.9.9',
    )
  })

  it('API 返回非白名单域名时忽略下载页地址（不向渲染层提供外链）', async () => {
    vi.mocked(net.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: 'v9.9.9',
          html_url: 'https://evil.example.com/ModelVault-Setup.exe',
        }),
        { status: 200 },
      ),
    )
    const res = await checkForUpdate()
    expect(res.hasUpdate).toBe(true)
    // 地址被剔除：渲染层 v-if 隐藏「前往下载」，用户不会被引向白名单外站点
    expect(res.releaseUrl).toBe('')
  })

  it('缺少 html_url 时不留空地址（渲染层隐藏下载入口）', async () => {
    vi.mocked(net.fetch).mockResolvedValue(
      new Response(JSON.stringify({ tag_name: 'v9.9.9' }), { status: 200 }),
    )
    const res = await checkForUpdate()
    expect(res.hasUpdate).toBe(true)
    expect(res.releaseUrl).toBe('')
  })

  it('仓库尚无任何 Release（404）时视为已是最新', async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response('{}', { status: 404 }))
    const res = await checkForUpdate()
    expect(res.error).toBeUndefined()
    expect(res.hasUpdate).toBe(false)
  })

  it('最新 Release 为遗留非语义化标签时回查列表，采用最新合规版本（A2 迁移）', async () => {
    vi.mocked(net.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tag_name: 'Beta-0.5' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { tag_name: 'Beta-0.5' },
            {
              tag_name: 'v0.6.0',
              html_url:
                'https://github.com/Lireth/ModelVault/releases/tag/v0.6.0',
            },
          ]),
          { status: 200 },
        ),
      )
    const res = await checkForUpdate()
    expect(res.error).toBeUndefined()
    expect(res.latest).toBe('0.6.0')
    expect(res.hasUpdate).toBe(true)
    // 第二次请求命中 Release 列表端点（主路径 /releases/latest 未命中合规版本）
    expect(vi.mocked(net.fetch).mock.calls[1][0]).toContain(
      '/releases?per_page=10',
    )
  })

  it('列表内也无语义化版本 Release 时视为暂无更新（迁移期静默不报错）', async () => {
    vi.mocked(net.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tag_name: 'Beta-0.5' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ tag_name: 'Beta-0.4' }, { tag_name: 'Beta-0.3' }]),
          { status: 200 },
        ),
      )
    const res = await checkForUpdate()
    expect(res.error).toBeUndefined()
    expect(res.hasUpdate).toBe(false)
    expect(res.latest).toBeUndefined()
  })

  it('注入式 tag 同样被跳过，不会成为更新目标（V-06 白名单不放宽）', async () => {
    vi.mocked(net.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tag_name: 'v../../evil' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ tag_name: 'v../../evil2' }]), {
          status: 200,
        }),
      )
    const res = await checkForUpdate()
    expect(res.error).toBeUndefined()
    expect(res.hasUpdate).toBe(false)
    expect(res.latest).toBeUndefined()
  })

  it('Release JSON 超过 2MB 上限时拒绝', async () => {
    vi.mocked(net.fetch).mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'Content-Length': String(3 * 1024 * 1024) },
      }),
    )
    const res = await checkForUpdate()
    expect(res.error).toContain('更新信息过大')
  })
})
