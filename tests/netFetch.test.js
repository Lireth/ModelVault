import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeUserData } from './setup'

/**
 * net-fetch.js 共享网络基元单元测试（V-06 逐跳白名单单一实现）：
 * - fetchWithValidatedRedirects：白名单拒绝文案（label 拼接）、逐跳放行、
 *   跳数上限、Electron 重定向探测的凭据语义参数化
 * - isTransientNetworkError：连接级瞬时特征（含 cause 链 / Electron
 *   net:: 前缀）与超时/普通错误的边界
 * electron 以全局最小桩提供，仅 mock net.fetch / net.request。
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  net: { fetch: vi.fn(), request: vi.fn() },
}))

import { net } from 'electron'
import {
  MAX_REDIRECTS,
  REQUEST_TIMEOUT_MS,
  fetchWithValidatedRedirects,
  isTransientNetworkError,
} from '../src/main/services/net-fetch'

/** 测试用白名单：example.com 及其子域（https） */
const allowExample = (url) => {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'https:' && parsed.hostname.endsWith('.example.com')
    )
  } catch {
    return false
  }
}

beforeEach(() => {
  vi.mocked(net.fetch).mockReset()
  vi.mocked(net.request).mockReset()
})

describe('统一常量', () => {
  it('超时基线 15s、重定向上限 5 跳（原 civitai 3 跳 / updater 10s 已收敛）', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(15000)
    expect(MAX_REDIRECTS).toBe(5)
  })
})

describe('fetchWithValidatedRedirects（V-06 逐跳白名单）', () => {
  it('初始 URL 未过白名单立即拒绝，文案携带调用方 label', async () => {
    await expect(
      fetchWithValidatedRedirects(
        'https://evil.net/x',
        {},
        allowExample,
        '测试请求',
      ),
    ).rejects.toThrow('测试请求地址不在白名单内，已拒绝')
    expect(net.fetch).not.toHaveBeenCalled()
  })

  it('白名单内跳转逐跳跟随到终态；白名单外跳转拒绝', async () => {
    vi.mocked(net.fetch)
      .mockResolvedValueOnce(
        new Response('', {
          status: 302,
          headers: { Location: 'https://cdn.example.com/asset' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const res = await fetchWithValidatedRedirects(
      'https://a.example.com/x',
      {},
      allowExample,
      '测试请求',
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')

    vi.mocked(net.fetch).mockReset()
    vi.mocked(net.fetch).mockResolvedValueOnce(
      new Response('', {
        status: 302,
        headers: { Location: 'https://evil.net/x' },
      }),
    )
    await expect(
      fetchWithValidatedRedirects(
        'https://a.example.com/x',
        {},
        allowExample,
        '测试请求',
      ),
    ).rejects.toThrow('测试请求重定向目标不在白名单内，已拒绝')
  })

  it('超过最大跳数时拒绝，实际请求数为上限 + 1 次', async () => {
    vi.mocked(net.fetch).mockImplementation(
      async () =>
        new Response('', {
          status: 302,
          headers: { Location: 'https://loop.example.com/next' },
        }),
    )
    await expect(
      fetchWithValidatedRedirects(
        'https://a.example.com/x',
        {},
        allowExample,
        '测试请求',
      ),
    ).rejects.toThrow('测试请求重定向次数过多，已拒绝')
    expect(net.fetch).toHaveBeenCalledTimes(MAX_REDIRECTS + 1)
  })

  it('探测请求按调用方凭据语义携带/不携带会话 Cookie（civitai true / 更新 false）', async () => {
    /** 构造只发一次 redirect 事件的 net.request 桩（Electron manual 模式） */
    const seenCookies = []
    vi.mocked(net.request).mockImplementation((opts) => {
      seenCookies.push(opts.useSessionCookies)
      const listeners = {}
      const req = {
        on: (evt, cb) => {
          ;(listeners[evt] ||= []).push(cb)
          return req
        },
        end: () => {
          queueMicrotask(() => {
            listeners.redirect?.[0]?.(302, 'GET', 'https://b.example.com/y', {
              Location: ['https://b.example.com/y'],
            })
          })
        },
        abort: () => {},
      }
      return req
    })

    for (const useSessionCookies of [true, false]) {
      vi.mocked(net.fetch).mockReset()
      vi.mocked(net.fetch)
        .mockRejectedValueOnce(new Error('Redirect was cancelled'))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }))
      const res = await fetchWithValidatedRedirects(
        'https://a.example.com/x',
        {},
        allowExample,
        '测试请求',
        { useSessionCookies },
      )
      expect(res.status).toBe(200)
    }
    expect(seenCookies).toEqual([true, false])
  })
})

describe('isTransientNetworkError（连接级瞬时特征）', () => {
  it('Electron net:: 前缀、cause 链与错误码三种形态均判为瞬时', () => {
    expect(
      isTransientNetworkError(new Error('net::ERR_CONNECTION_RESET')),
    ).toBe(true)
    const withCause = new Error('fetch failed')
    withCause.cause = Object.assign(new Error('connect ECONNRESET'), {
      code: 'ECONNRESET',
    })
    expect(isTransientNetworkError(withCause)).toBe(true)
    expect(
      isTransientNetworkError(
        Object.assign(new Error('dns failure'), {
          code: 'ENOTFOUND',
        }),
      ),
    ).toBe(true)
  })

  it('超时中止/普通失败/非 Error 输入不判为瞬时（不触发重试）', () => {
    expect(
      isTransientNetworkError(new DOMException('已终止', 'AbortError')),
    ).toBe(false)
    expect(isTransientNetworkError(new Error('timeout exceeded'))).toBe(false)
    expect(isTransientNetworkError(new Error('普通失败'))).toBe(false)
    expect(isTransientNetworkError('not an error')).toBe(false)
    expect(isTransientNetworkError(null)).toBe(false)
  })
})
