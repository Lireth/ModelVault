import { describe, expect, it, vi, afterEach } from 'vitest'
import { fakeUserData } from './setup'

/**
 * civitai.js 顶层 import 了 Electron net（网络请求），Node 测试环境
 * 提供最小桩（纯函数测试不触网，fetch 不会被调用）。
 */
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  net: { fetch: vi.fn(), request: vi.fn() },
}))

import {
  civitaiTagsToTag,
  civitaiTypeToTag,
} from '../src/shared/model-categories'
import {
  civitaiCompletePatch,
  downloadCivitaiImage,
  fetchCivitaiModelType,
  fetchCivitaiVideo,
  isAllowedCivitaiImageUrl,
  normalizeVersionInfo,
  parseCivitaiModelId,
  setCivitaiApiInterval,
  setCivitaiTransientRetryDelayForTests,
  stripHtml,
} from '../src/main/services/civitai'
import { net } from 'electron'

// 测试环境关闭请求节流：避免 vitest 真实等待 1.2s 间隔拖慢用例
setCivitaiApiInterval(0)
// 同理关闭瞬时错误重试的真实退避等待（500ms → 0）
setCivitaiTransientRetryDelayForTests(0)

/**
 * civitai.js 单元测试（纯函数 + 类型查询，不真实触网）：
 * - normalizeVersionInfo：by-hash 响应规范化与页面 URL 拼装、坏数据容错
 * - parseCivitaiModelId：模型页 URL 的 id 提取
 * - fetchCivitaiModelType：按模型 id 查询类型（mock net.fetch）
 * - civitaiTypeToTag：Civitai 类型 → 本地标签映射
 * - stripHtml：描述富文本转纯文本（换行保留、实体解码）
 * - civitaiCompletePatch：仅补空缺字段（触发词/备注），不覆盖用户标注
 */

describe('parseCivitaiModelId', () => {
  it('从模型页 URL 提取数字 id（含 slug 与 query 变体，com/red 两站均接受）', () => {
    expect(parseCivitaiModelId('https://civitai.com/models/12345')).toBe(
      '12345',
    )
    expect(parseCivitaiModelId('https://civitai.red/models/12345')).toBe(
      '12345',
    )
    expect(
      parseCivitaiModelId('https://civitai.com/models/12345/some-name'),
    ).toBe('12345')
    expect(
      parseCivitaiModelId(
        'https://civitai.com/models/12345?modelVersionId=678',
      ),
    ).toBe('12345')
    expect(
      parseCivitaiModelId(
        'https://civitai.red/models/12345?modelVersionId=678',
      ),
    ).toBe('12345')
  })

  it('非模型页 URL 或坏数据返回 null', () => {
    expect(parseCivitaiModelId('https://civitai.com/models/abc')).toBe(null)
    expect(parseCivitaiModelId('https://civitai.com.evil.com/models/123')).toBe(
      null,
    )
    expect(parseCivitaiModelId('https://evil.com/models/123')).toBe(null)
    expect(parseCivitaiModelId('not-a-url')).toBe(null)
    expect(parseCivitaiModelId('')).toBe(null)
    expect(parseCivitaiModelId(null)).toBe(null)
  })
})

describe('fetchCivitaiModelType', () => {
  it('命中时返回模型类型与 tags（分类实际挂在 tags 里）', async () => {
    vi.mocked(net.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 123,
          type: 'LORA',
          name: 'Some Model',
          tags: ['character', 'foo'],
        }),
        { status: 200 },
      ),
    )
    const res = await fetchCivitaiModelType('123')
    expect(res).toEqual({
      found: true,
      type: 'LORA',
      tags: ['character', 'foo'],
    })
  })

  it('响应无 tags 字段时返回空数组', async () => {
    vi.mocked(net.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ id: 123, type: 'Character', name: 'Some Model' }),
        { status: 200 },
      ),
    )
    const res = await fetchCivitaiModelType('123')
    expect(res).toEqual({ found: true, type: 'Character', tags: [] })
  })

  it('404 视为未收录（非错误）', async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response('', { status: 404 }))
    const res = await fetchCivitaiModelType('123')
    expect(res).toEqual({ found: false })
  })

  it('非 2xx 返回错误信息', async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response('', { status: 500 }))
    const res = await fetchCivitaiModelType('123')
    expect(res.found).toBe(false)
    expect(res.error).toContain('HTTP 500')
  })

  it('响应缺 type 字段视为数据异常', async () => {
    vi.mocked(net.fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: 123 }), { status: 200 }),
    )
    const res = await fetchCivitaiModelType('123')
    expect(res.found).toBe(false)
    expect(res.error).toContain('格式异常')
  })

  it('429 限流按 Retry-After 退避重试后成功', async () => {
    vi.mocked(net.fetch)
      .mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'Retry-After': '0' } }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 123, type: 'LORA', tags: ['character'] }),
          { status: 200 },
        ),
      )
    const res = await fetchCivitaiModelType('123')
    expect(res).toEqual({ found: true, type: 'LORA', tags: ['character'] })
    expect(net.fetch).toHaveBeenCalledTimes(2)
  })

  it('429 重试次数耗尽后按 HTTP 错误返回', async () => {
    for (let i = 0; i < 4; i++) {
      vi.mocked(net.fetch).mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'Retry-After': '0' } }),
      )
    }
    const res = await fetchCivitaiModelType('123')
    expect(res.found).toBe(false)
    expect(res.error).toContain('HTTP 429')
    expect(net.fetch).toHaveBeenCalledTimes(4)
  })

  it('429 等待超过单次超时后，重试使用新的超时信号而非已终止信号', async () => {
    // 将单次请求超时压缩到 10ms（真实 timers，避免 fake timers 介入节流链）：
    // 429 的 50ms 等待必然跨过第一次请求的超时窗口。
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation(() => {
        const controller = new AbortController()
        setTimeout(
          () => controller.abort(new DOMException('请求超时', 'TimeoutError')),
          10,
        )
        return controller.signal
      })
    let attempts = 0
    vi.mocked(net.fetch).mockImplementation(async (_url, options) => {
      attempts += 1
      if (options?.signal?.aborted)
        throw new DOMException('已终止', 'AbortError')
      if (attempts === 1) {
        return new Response('', {
          status: 429,
          headers: { 'Retry-After': '0.05' },
        })
      }
      return new Response(JSON.stringify({ id: 1, type: 'LORA', tags: [] }), {
        status: 200,
      })
    })

    try {
      const res = await fetchCivitaiModelType('123')
      expect(res).toEqual({ found: true, type: 'LORA', tags: [] })
      expect(attempts).toBe(2)
      // 每次 attempt 各自创建超时信号，而不是复用第一次已过期的 signal
      expect(timeoutSpy).toHaveBeenCalledTimes(2)
    } finally {
      vi.mocked(net.fetch).mockReset()
      timeoutSpy.mockRestore()
    }
  })

  it('连接级瞬时错误自动重试一次后成功（对齐 update-download OPT-01）', async () => {
    let attempts = 0
    vi.mocked(net.fetch).mockImplementation(async () => {
      attempts += 1
      if (attempts === 1) {
        // 镜像 Electron net 栈真实形态：Error + cause 链携带 errno code
        const err = new Error('net::ERR_CONNECTION_RESET')
        err.cause = Object.assign(new Error('connect ECONNRESET'), {
          code: 'ECONNRESET',
        })
        throw err
      }
      return new Response(JSON.stringify({ id: 1, type: 'LORA', tags: [] }), {
        status: 200,
      })
    })
    const res = await fetchCivitaiModelType('123')
    expect(res).toEqual({ found: true, type: 'LORA', tags: [] })
    expect(attempts).toBe(2)
  })

  it('瞬时错误重试后仍失败时按既有网络错误语义返回', async () => {
    let attempts = 0
    vi.mocked(net.fetch).mockImplementation(async () => {
      attempts += 1
      throw new Error('net::ERR_NETWORK_CHANGED')
    })
    const res = await fetchCivitaiModelType('123')
    expect(res.found).toBe(false)
    expect(res.error).toContain('网络请求失败')
    expect(attempts).toBe(2)
  })

  it('超时中止不触发连接级重试（按既有超时语义返回）', async () => {
    // isTransientNetworkError 明确排除超时中止：重试会成倍拉长等待
    let attempts = 0
    vi.mocked(net.fetch).mockImplementation(async () => {
      attempts += 1
      throw new DOMException('请求超时', 'TimeoutError')
    })
    const res = await fetchCivitaiModelType('123')
    expect(res.found).toBe(false)
    expect(res.error).toContain('请求超时')
    expect(attempts).toBe(1)
  })

  it('瞬时重试与 429 退避独立计数：抖动重试后遇限流仍可退避重试', async () => {
    let attempts = 0
    vi.mocked(net.fetch).mockImplementation(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('net::ERR_CONNECTION_RESET')
      if (attempts === 2)
        return new Response('', {
          status: 429,
          headers: { 'Retry-After': '0' },
        })
      return new Response(JSON.stringify({ id: 1, type: 'LORA', tags: [] }), {
        status: 200,
      })
    })
    const res = await fetchCivitaiModelType('123')
    expect(res).toEqual({ found: true, type: 'LORA', tags: [] })
    expect(attempts).toBe(3)
  })
})

describe('Civitai 网络边界（V-06）', () => {
  it('API 重定向逐跳校验：白名单子域放行，外部主机拒绝', async () => {
    vi.mocked(net.fetch).mockResolvedValueOnce(
      new Response('', {
        status: 302,
        headers: { Location: 'https://evil.example.com/x' },
      }),
    )
    const rejected = await fetchCivitaiModelType('1')
    expect(rejected.found).toBe(false)
    expect(rejected.error).toContain('重定向目标不在白名单')

    vi.mocked(net.fetch)
      .mockResolvedValueOnce(
        new Response('', {
          status: 302,
          headers: { Location: 'https://civitai.com/api/v1/models/123' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 1, type: 'LORA' }), { status: 200 }),
      )
    const allowed = await fetchCivitaiModelType('123')
    expect(allowed).toEqual({ found: true, type: 'LORA', tags: [] })
  })

  /** 构造只发一次 redirect 事件的 net.request 桩（Electron manual 模式） */
  function fakeRedirectingRequest(target) {
    const requests = []
    const impl = (opts) => {
      expect(opts.redirect).toBe('manual')
      expect(opts.useSessionCookies).toBe(true)
      const listeners = {}
      const req = {
        on: (evt, cb) => {
          ;(listeners[evt] ||= []).push(cb)
          return req
        },
        end: () => {
          queueMicrotask(() => {
            listeners.redirect?.[0]?.(302, 'GET', target, {
              Location: [target],
            })
          })
        },
        followRedirect: () => {},
        // ClientRequest 的真实取消方法是 abort（无 cancel/destroy）
        abort: () => requests.push('abort'),
        destroy: undefined,
      }
      requests.request = req
      return req
    }
    impl.requests = requests
    return impl
  }

  it('Electron 不支持 manual 重定向时（Redirect was cancelled），经 net.request 探测目标并逐跳继续', async () => {
    // Electron 实际行为：net.fetch manual 模式遇 3xx 直接抛错而非返回 3xx 响应
    const requestStub = fakeRedirectingRequest(
      'https://api.civitai.com/api/v1/models/1',
    )
    vi.mocked(net.fetch).mockImplementation(async (url) => {
      if (String(url) === 'https://civitai.red/api/v1/models/1') {
        throw new Error('Redirect was cancelled')
      }
      return new Response(JSON.stringify({ id: 1, type: 'LORA' }), {
        status: 200,
      })
    })
    vi.mocked(net.request).mockImplementation(requestStub)

    const res = await fetchCivitaiModelType('1')
    expect(res).toEqual({ found: true, type: 'LORA', tags: [] })
    expect(net.fetch).toHaveBeenCalledTimes(2)
    // 探测完成后经 abort 取消底层请求（ClientRequest 无 cancel/destroy 方法，
    // 回归防御：调用不存在的方法会在事件处理器内抛错并演变为致命错误）
    expect(requestStub.requests).toContain('abort')
  })

  it('探测到的重定向目标不在白名单时同样拒绝（探测路径保持 V-06 门禁）', async () => {
    vi.mocked(net.fetch).mockImplementation(async () => {
      throw new Error('Redirect was cancelled')
    })
    vi.mocked(net.request).mockImplementation(
      fakeRedirectingRequest('https://evil.example.com/x'),
    )

    const res = await fetchCivitaiModelType('1')
    expect(res.found).toBe(false)
    expect(res.error).toContain('重定向目标不在白名单')
  })

  it('API JSON 超过体积上限时拒绝读取', async () => {
    vi.mocked(net.fetch).mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'Content-Length': String(9 * 1024 * 1024) },
      }),
    )
    const res = await fetchCivitaiModelType('1')
    expect(res.found).toBe(false)
    expect(res.error).toContain('过大')
  })

  it('并发请求按最小间隔串行，不形成突发', async () => {
    setCivitaiApiInterval(30)
    try {
      let inFlight = 0
      let maxInFlight = 0
      vi.mocked(net.fetch).mockImplementation(async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 10))
        inFlight -= 1
        return new Response(JSON.stringify({ id: 1, type: 'LORA' }), {
          status: 200,
        })
      })

      await Promise.all([
        fetchCivitaiModelType('1'),
        fetchCivitaiModelType('2'),
        fetchCivitaiModelType('3'),
      ])

      // 旧实现三者在同一时刻睡醒后一起发请求（max=3）
      expect(maxInFlight).toBe(1)
      expect(net.fetch).toHaveBeenCalledTimes(3)
    } finally {
      setCivitaiApiInterval(0)
    }
  })

  it('图片重定向到非 CDN 主机时拒绝', async () => {
    vi.mocked(net.fetch).mockResolvedValue(
      new Response('', {
        status: 302,
        headers: { Location: 'https://evil.example.com/a.jpg' },
      }),
    )
    const res = await downloadCivitaiImage('https://image.civitai.com/a.jpg')
    expect(res.error).toContain('重定向目标不在白名单')
  })

  it('图片响应超过 50MB 上限时拒绝读取', async () => {
    vi.mocked(net.fetch).mockResolvedValue(
      new Response('x', {
        status: 200,
        headers: { 'Content-Length': String(51 * 1024 * 1024) },
      }),
    )
    const res = await downloadCivitaiImage('https://image.civitai.com/a.jpg')
    expect(res.error).toContain('过大')
  })
})

describe('civitaiTypeToTag', () => {
  it('七类 Civitai 类型映射到本地标签（忽略大小写与空白）', () => {
    expect(civitaiTypeToTag('Character')).toBe('role')
    expect(civitaiTypeToTag('character')).toBe('role')
    expect(civitaiTypeToTag(' Style ')).toBe('style')
    expect(civitaiTypeToTag('Concept')).toBe('concept')
    expect(civitaiTypeToTag('Clothing')).toBe('outfit')
    expect(civitaiTypeToTag('Background')).toBe('background')
    expect(civitaiTypeToTag('Pose')).toBe('pose')
    expect(civitaiTypeToTag('Tool')).toBe('tool')
  })

  it('其余类型（Lora/Checkpoint 等）与坏输入不映射', () => {
    expect(civitaiTypeToTag('Lora')).toBe('')
    expect(civitaiTypeToTag('Checkpoint')).toBe('')
    expect(civitaiTypeToTag('')).toBe('')
    expect(civitaiTypeToTag(null)).toBe('')
  })
})

describe('civitaiTagsToTag', () => {
  it('按 tags 顺序取第一个可映射的分类 tag（含 poses 复数形式）', () => {
    expect(civitaiTagsToTag(['character', 'zenless zone zero'])).toBe('role')
    expect(
      civitaiTagsToTag(['illustrious', 'lora', 'tool', 'breasts slider']),
    ).toBe('tool')
    expect(civitaiTagsToTag(['poses'])).toBe('pose')
    expect(civitaiTagsToTag(['Breasts Squeeze', 'poses'])).toBe('pose')
    expect(civitaiTagsToTag(['style', 'character'])).toBe('style')
  })

  it('无可映射分类或坏输入返回空串', () => {
    expect(civitaiTagsToTag(['lora', 'nsfw'])).toBe('')
    expect(civitaiTagsToTag([])).toBe('')
    expect(civitaiTagsToTag(null)).toBe('')
    expect(civitaiTagsToTag('character')).toBe('')
  })
})

describe('normalizeVersionInfo', () => {
  it('由 modelId + versionId 拼装官方页面 URL，并提取展示字段', () => {
    const info = normalizeVersionInfo({
      id: 456,
      modelId: 123,
      name: 'v2.0',
      baseModel: 'SDXL 1.0',
      trainedWords: ['foo', ' bar ', ''],
      description: '<p>desc</p>',
      model: { id: 123, name: 'Some LoRA' },
    })
    expect(info.url).toBe('https://civitai.red/models/123?modelVersionId=456')
    expect(info.modelName).toBe('Some LoRA')
    expect(info.versionName).toBe('v2.0')
    expect(info.baseModel).toBe('SDXL 1.0')
    expect(info.trainedWords).toEqual(['foo', 'bar'])
  })

  it('缺 modelId/versionId 或坏数据返回 null', () => {
    expect(normalizeVersionInfo(null)).toBe(null)
    expect(normalizeVersionInfo({ id: 1 })).toBe(null)
    expect(normalizeVersionInfo({ modelId: 1 })).toBe(null)
    expect(normalizeVersionInfo('x')).toBe(null)
  })

  it('trainedWords 非数组时容错为空列表', () => {
    const info = normalizeVersionInfo({
      id: 1,
      modelId: 2,
      trainedWords: 'not-array',
    })
    expect(info.trainedWords).toEqual([])
  })

  it('图片与视频分流输出，携带尺寸/NSFW/视频封面；坏数据剔除', () => {
    const info = normalizeVersionInfo({
      id: 1,
      modelId: 2,
      images: [
        {
          type: 'image',
          url: 'https://image.civitai.com/a.jpeg',
          width: 512,
          height: 768,
          nsfw: false,
        },
        {
          type: 'video',
          url: 'https://image.civitai.com/b.mp4',
          width: 512,
          height: 768,
          thumbnailUrl: 'https://image.civitai.com/b.jpeg',
        },
        { type: 'video', url: 'https://image.civitai.com/c.webm' },
        {
          type: 'image',
          url: 'http://image.civitai.com/c.jpeg',
          width: 1,
          height: 1,
        },
        {
          type: 'image',
          url: 'https://evil.com/d.jpeg',
          width: 1,
          height: 1,
          nsfw: true,
        },
        null,
        { type: 'image', width: 1, height: 1 },
      ],
    })
    // https 前缀的静态图与视频分别保留（域名白名单在下载/代理时强制），
    // http/坏数据剔除
    expect(info.images).toEqual([
      {
        url: 'https://image.civitai.com/a.jpeg',
        width: 512,
        height: 768,
        nsfw: false,
      },
      { url: 'https://evil.com/d.jpeg', width: 1, height: 1, nsfw: true },
    ])
    expect(info.videos).toEqual([
      {
        url: 'https://image.civitai.com/b.mp4',
        width: 512,
        height: 768,
        nsfw: false,
        thumbnailUrl: 'https://image.civitai.com/b.jpeg',
      },
      {
        url: 'https://image.civitai.com/c.webm',
        width: 0,
        height: 0,
        nsfw: false,
        thumbnailUrl: '',
      },
    ])
  })

  it('示例图按 API 顺序截断至 30 张', () => {
    const imgs = Array.from({ length: 40 }, (_, i) => ({
      type: 'image',
      url: `https://image.civitai.com/${i}.jpeg`,
      width: 1,
      height: 1,
    }))
    expect(
      normalizeVersionInfo({ id: 1, modelId: 2, images: imgs }).images,
    ).toHaveLength(30)
  })

  it('nsfwLevel 数组非空视为 NSFW', () => {
    const info = normalizeVersionInfo({
      id: 1,
      modelId: 2,
      images: [
        {
          type: 'image',
          url: 'https://image.civitai.com/x.jpeg',
          nsfwLevel: ['X'],
        },
      ],
    })
    expect(info.images[0].nsfw).toBe(true)
  })
})

describe('isAllowedCivitaiImageUrl', () => {
  it('仅放行 https 协议的 Civitai 基域主机（com/red 含子域，覆盖 CDN 迁移主机名）', () => {
    expect(isAllowedCivitaiImageUrl('https://image.civitai.com/a.jpeg')).toBe(
      true,
    )
    expect(
      isAllowedCivitaiImageUrl('https://blobs-b2.civitai.com/a.jpeg'),
    ).toBe(true)
    expect(isAllowedCivitaiImageUrl('https://image.civitai.red/a.jpeg')).toBe(
      true,
    )
    expect(isAllowedCivitaiImageUrl('http://image.civitai.com/a.jpeg')).toBe(
      false,
    )
    expect(isAllowedCivitaiImageUrl('http://image.civitai.red/a.jpeg')).toBe(
      false,
    )
    expect(isAllowedCivitaiImageUrl('https://evil.com/a.jpeg')).toBe(false)
    // 子域伪装与用户信息段伪装均拒绝（真实主机不匹配）
    expect(
      isAllowedCivitaiImageUrl('https://image.civitai.com.evil.com/a.jpeg'),
    ).toBe(false)
    expect(
      isAllowedCivitaiImageUrl('https://image.civitai.red.evil.com/a.jpeg'),
    ).toBe(false)
    expect(
      isAllowedCivitaiImageUrl('https://image.civitai.com@evil.com/a.jpeg'),
    ).toBe(false)
    expect(isAllowedCivitaiImageUrl('not-a-url')).toBe(false)
    expect(isAllowedCivitaiImageUrl(null)).toBe(false)
  })
})

describe('stripHtml', () => {
  it('剥离标签、保留块级换行并解码常见实体', () => {
    expect(stripHtml('<p>A</p><p>B</p>')).toBe('A\nB')
    expect(stripHtml('a<br>b')).toBe('a\nb')
    expect(stripHtml('&amp;&lt;&gt;&quot;&#39;&nbsp;x')).toBe(`&<>"' x`)
    expect(stripHtml('<b>bold</b> text')).toBe('bold text')
  })

  it('连续空行压缩与非字符串容错', () => {
    expect(stripHtml('<p>a</p><div></div><div></div><p>b</p>')).not.toMatch(
      /\n{3,}/,
    )
    expect(stripHtml(null)).toBe('')
    expect(stripHtml(42)).toBe('')
  })
})

describe('civitaiCompletePatch', () => {
  const info = {
    url: 'https://civitai.com/models/1?modelVersionId=2',
    trainedWords: ['w1', 'w2'],
    description: '<p>Some description</p>',
  }

  it('空缺字段全部补齐', () => {
    const { patch, applied } = civitaiCompletePatch(
      { triggerWords: '', note: '' },
      info,
    )
    expect(patch.triggerWords).toBe('w1, w2')
    expect(patch.note).toBe('Some description')
    expect(applied).toEqual(['triggerWords', 'note'])
  })

  it('已有标注不覆盖（触发词/备注任一非空即跳过对应字段）', () => {
    const { patch, applied } = civitaiCompletePatch(
      { triggerWords: 'mine', note: 'my note' },
      info,
    )
    expect(patch).toEqual({})
    expect(applied).toEqual([])
  })

  it('部分空缺只补空缺部分', () => {
    const { patch, applied } = civitaiCompletePatch(
      { triggerWords: 'mine', note: '' },
      info,
    )
    expect(patch).toEqual({ note: 'Some description' })
    expect(applied).toEqual(['note'])
  })

  it('info 无可用内容时不产生补丁', () => {
    const { applied } = civitaiCompletePatch(
      { triggerWords: '', note: '' },
      { trainedWords: [], description: '' },
    )
    expect(applied).toEqual([])
  })

  it('备注截断至 2000 字符', () => {
    const long = '<p>' + 'x'.repeat(3000) + '</p>'
    const { patch } = civitaiCompletePatch({ note: '' }, { description: long })
    expect(patch.note.length).toBe(2000)
  })

  it('meta 或 info 缺失时安全返回', () => {
    expect(civitaiCompletePatch(null, info).applied).toEqual([])
    expect(civitaiCompletePatch({}, null).applied).toEqual([])
  })
})

describe('fetchCivitaiVideo（头部阶段超时）', () => {
  const VIDEO_URL = 'https://image.civitai.com/generation/x-123.mp4'

  afterEach(() => {
    vi.useRealTimers()
    vi.mocked(net.fetch).mockReset()
  })

  it('上游连接挂死（响应头迟迟不到）时按超时中止而非无限悬挂', async () => {
    vi.useFakeTimers()
    // 模拟连接挂死 + 真实 net.fetch 对 signal 的反应：永不 resolve，仅在中止时拒绝
    vi.mocked(net.fetch).mockImplementation(
      (_url, opts) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () =>
            reject(
              new DOMException('This operation was aborted', 'AbortError'),
            ),
          )
        }),
    )

    const pending = fetchCivitaiVideo(VIDEO_URL)
    const assertion = expect(pending).rejects.toThrow('视频上游 30s 内未响应')
    await vi.advanceTimersByTimeAsync(30000)
    await assertion
    // 协议层对错误的既有语义：转 502 返回，UI 不再无限等待
    await expect(pending).rejects.toBeInstanceOf(Error)
  })

  it('响应头按时到达后解除超时定时器，body 不受时限影响（流式播放语义）', async () => {
    vi.useFakeTimers()
    vi.mocked(net.fetch).mockResolvedValue(
      new Response('video-bytes', { status: 200 }),
    )

    const response = await fetchCivitaiVideo(VIDEO_URL)
    expect(response.status).toBe(200)
    // 远超头部超时窗口后定时器已解除：信号未中止，body 仍可完整读取
    await vi.advanceTimersByTimeAsync(120000)
    expect(await response.text()).toBe('video-bytes')
  })

  it('Range 头透传与超时信号一并传给上游请求', async () => {
    vi.mocked(net.fetch).mockResolvedValue(
      new Response('part', { status: 206 }),
    )
    await fetchCivitaiVideo(VIDEO_URL, 'bytes=100-200')
    expect(net.fetch).toHaveBeenCalledWith(
      VIDEO_URL,
      expect.objectContaining({
        redirect: 'manual',
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({ Range: 'bytes=100-200' }),
      }),
    )
  })
})
