import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fakeUserData } from './setup'

/**
 * civimg:// 远程图片代理处理器回归测试（O-2 拆分后自 protocol.test.js 迁移）。
 * 覆盖安全边界与并发契约：
 * - 域名白名单 403 / 隐私门禁 403（零网络请求）
 * - 上游失败/网络失败 502 与 OPT-7 负缓存（静默期零回源、到期自愈、成功清除）
 * - OPT-05 在途去重、并发上限 ≤6、视频槽位头部即释放
 * - 代理响应头白名单（Set-Cookie/Content-Disposition/X-* 不透传）
 * - 视频 Range 白名单校验与 Content-Range/Content-Length 保留（FN-02）
 * - O-5 磁盘缓存回写/命中、魔数不符不入缓存、损坏条目删除自愈
 * - OPT-14 离线库根跳过缓存写入
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  },
  net: { fetch: vi.fn() },
  clipboard: { read: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}))

// civ-cache 仅将 saveCivImageCache 替换为可注入 spy（默认直通真实实现，
// 其余导出保持原样）——挂起磁盘形态（写入永不 settle）的用例依赖此注入
vi.mock('../src/main/services/civ-cache', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, saveCivImageCache: vi.fn(actual.saveCivImageCache) }
})

import { net, protocol } from 'electron'
import logger from '../src/main/logger'
import {
  isCivitaiVideoUrl,
  registerCivimgHandler,
  setCivimgBodyIdleTimeoutForTests,
  setCivimgCacheWriteTimeoutForTests,
  setCivimgFailTtlForTests,
} from '../src/main/protocol/remote-image'
import { registerImageScheme } from '../src/main/protocol'
import { setDataRoot, updateSettings } from '../src/main/services/store'
import {
  getCivImageCachePath,
  saveCivImageCache,
} from '../src/main/services/civ-cache'

/** 最小 PNG 文件头（魔数校验所需字节均在文件头 12 字节内） */
const PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13,
])

const roots = []
let root
/** 注册时捕获的 civimg 处理器 */
let civHandler

/** 构造 civimg 请求（与渲染进程 civimg://remote/<encodeURIComponent(url)> 格式一致） */
function makeCivRequest(url) {
  return { url: `civimg://remote/${encodeURIComponent(url)}` }
}

beforeEach(async () => {
  vi.mocked(protocol.handle).mockClear()
  vi.mocked(net.fetch).mockReset()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-civimg-'))
  roots.push(root)
  setDataRoot(root)
  registerCivimgHandler()
  const call = vi
    .mocked(protocol.handle)
    .mock.calls.find(([scheme]) => scheme === 'civimg')
  civHandler = call?.[1]
  expect(typeof civHandler).toBe('function')
})

afterEach(() => {
  setCivimgFailTtlForTests(60000)
  setCivimgBodyIdleTimeoutForTests(30000)
  setCivimgCacheWriteTimeoutForTests(30000)
})

describe('registerImageScheme 特权注册', () => {
  it('mvimg/civimg 均注册 corsEnabled（缩略图隐藏窗口跨源读取依赖）', () => {
    registerImageScheme()
    const entries = vi
      .mocked(protocol.registerSchemesAsPrivileged)
      .mock.calls.flatMap(([schemes]) => schemes)
    for (const scheme of ['mvimg', 'civimg']) {
      const entry = entries.find((s) => s.scheme === scheme)
      expect(entry).toBeDefined()
      expect(entry.privileges.corsEnabled).toBe(true)
      expect(entry.privileges.standard).toBe(true)
      expect(entry.privileges.secure).toBe(true)
      expect(entry.privileges.supportFetchAPI).toBe(true)
    }
  })
})

describe('civimg 协议门禁（白名单与隐私开关）', () => {
  it('非 remote host 的请求返回 400', async () => {
    const res = await civHandler({ url: 'civimg://evil/some-url' })
    expect(res.status).toBe(400)
  })

  it('非白名单域名（伪装 CDN 主机）返回 403，且不发起网络请求', async () => {
    const res = await civHandler(makeCivRequest('https://evil.com/a.jpeg'))
    expect(res.status).toBe(403)
    expect(net.fetch).not.toHaveBeenCalled()
  })

  it('关闭 Civitai 开关后拒绝远程代理，且不发起网络请求（OPT-03）', async () => {
    await updateSettings({ civitaiEnabled: false })
    try {
      vi.mocked(net.fetch).mockResolvedValue(
        new Response('img-bytes', {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        }),
      )
      const res = await civHandler(
        makeCivRequest('https://image.civitai.com/a/1.jpeg'),
      )
      expect(res.status).toBe(403)
      expect(net.fetch).not.toHaveBeenCalled()
    } finally {
      await updateSettings({ civitaiEnabled: true })
    }
  })

  it('畸形编码的 target 返回 400', async () => {
    const res = await civHandler({ url: 'civimg://remote/%E0%A4%A' })
    expect(res.status).toBe(400)
  })
})

describe('civimg 可控 target 日志净化（#66 日志伪造面）', () => {
  it('非白名单地址携带 %0A 解码换行：403 且日志单行转义，不注入伪造行', async () => {
    const warnSpy = vi.spyOn(logger, 'warn')
    try {
      const res = await civHandler(
        makeCivRequest('https://evil.com/a.jpeg\n[INFO] 伪造日志行'),
      )
      expect(res.status).toBe(403)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const line = String(warnSpy.mock.calls[0][0])
      // 换行已转义为字面量 \n：按行落盘的日志不会拆出伪造的 [INFO] 行
      expect(line).toBe(
        'civimg 协议拒绝非白名单图片地址: https://evil.com/a.jpeg\\n[INFO] 伪造日志行',
      )
      expect(line.includes('\n')).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('白名单地址携带 %0A 解码换行且上游失败：异常日志同样单行转义', async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response('', { status: 403 }))
    const warnSpy = vi.spyOn(logger, 'warn')
    try {
      const res = await civHandler(
        makeCivRequest('https://image.civitai.com/x/1.jpeg\n[WARN] 伪造行'),
      )
      expect(res.status).toBe(502)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const line = String(warnSpy.mock.calls[0][0])
      expect(line).toBe(
        'civimg 上游响应异常（HTTP 403）: https://image.civitai.com/x/1.jpeg\\n[WARN] 伪造行',
      )
      expect(line.includes('\n')).toBe(false)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('不含控制字符的地址日志原样输出，白名单放行语义不变', async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response('', { status: 403 }))
    const warnSpy = vi.spyOn(logger, 'warn')
    try {
      const target = 'https://image.civitai.com/plain/1.jpeg'
      const res = await civHandler(makeCivRequest(target))
      expect(res.status).toBe(502)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0][0])).toBe(
        `civimg 上游响应异常（HTTP 403）: ${target}`,
      )
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('civimg 图片代理', () => {
  it('白名单 CDN 图片经 net.fetch 代理放行，附加按天缓存头', async () => {
    vi.mocked(net.fetch).mockResolvedValue(
      new Response('img-bytes', {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      }),
    )
    const target =
      'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/uuid/original=true/1.jpeg'
    const res = await civHandler(makeCivRequest(target))
    expect(res.status).toBe(200)
    expect(vi.mocked(net.fetch)).toHaveBeenCalledWith(
      target,
      expect.objectContaining({
        headers: expect.objectContaining({ Referer: 'https://civitai.red/' }),
      }),
    )
    expect(res.headers.get('Cache-Control')).toContain('max-age=86400')
  })

  it('上游响应失败返回 502', async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response('', { status: 403 }))
    const res = await civHandler(
      makeCivRequest('https://image.civitai.com/fail-502/a.jpeg'),
    )
    expect(res.status).toBe(502)
  })

  it('上游非 ok 返回 502 前取消未消费的上游 body（防连接挂留）', async () => {
    let cancelled = false
    vi.mocked(net.fetch).mockImplementation(() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true
            },
          }),
          { status: 403 },
        ),
      ),
    )
    const res = await civHandler(
      makeCivRequest('https://image.civitai.com/cancel-body/1.png'),
    )
    expect(res.status).toBe(502)
    expect(cancelled).toBe(true)
  })

  it('图片代理响应头按白名单重建：Set-Cookie/Content-Disposition/X-* 不透传', async () => {
    vi.mocked(net.fetch).mockResolvedValue(
      new Response('upstream-error-page', {
        status: 200,
        headers: {
          'Content-Type': 'text/html',
          'Set-Cookie': 'session=secret; Path=/',
          'Content-Disposition': 'attachment; filename="x.png"',
          'X-Custom-Header': 'leak',
          ETag: '"etag-1"',
        },
      }),
    )
    const res = await civHandler(
      makeCivRequest('https://image.civitai.com/h/5.png'),
    )
    expect(res.status).toBe(200)
    // 上游附带头一律不透传（cookie 注入通道切断），白名单子集保留
    expect(res.headers.get('Set-Cookie')).toBeNull()
    expect(res.headers.get('Content-Disposition')).toBeNull()
    expect(res.headers.get('X-Custom-Header')).toBeNull()
    expect(res.headers.get('ETag')).toBe('"etag-1"')
    expect(res.headers.get('Cache-Control')).toContain('max-age=86400')
  })
})

describe('civimg 并发与去重（OPT-05）', () => {
  it('同 URL 并发请求共享一次回源（在途去重）', async () => {
    let fetches = 0
    vi.mocked(net.fetch).mockImplementation(async () => {
      fetches += 1
      // 模拟网络延迟，保证三个请求落在同一在途窗口内
      await new Promise((r) => setTimeout(r, 20))
      return new Response('img-bytes', {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      })
    })
    const target = 'https://image.civitai.com/dedupe/1.jpeg'
    const [a, b, c] = await Promise.all([
      civHandler(makeCivRequest(target)),
      civHandler(makeCivRequest(target)),
      civHandler(makeCivRequest(target)),
    ])
    // 画廊与批量导入选择器同屏渲染同一图：只回源一次
    expect(fetches).toBe(1)
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200])
    // 共享的 Buffer 结果可被各调用方独立消费
    expect(await a.text()).toBe('img-bytes')
    expect(await b.text()).toBe('img-bytes')
    expect(await c.text()).toBe('img-bytes')
  })

  it('不同 URL 并发回源受上限约束（峰值 ≤6，FIFO 全部完成）', async () => {
    let inFlight = 0
    let peak = 0
    vi.mocked(net.fetch).mockImplementation(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 10))
      inFlight -= 1
      return new Response('img-bytes', {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      })
    })
    const urls = Array.from(
      { length: 12 },
      (_, i) => `https://image.civitai.com/conc/${i}.jpeg`,
    )
    const results = await Promise.all(
      urls.map((u) => civHandler(makeCivRequest(u))),
    )
    // 被入侵的渲染进程一次塞数百个 civimg URL 的场景：并发 fetch 被收口
    expect(peak).toBeLessThanOrEqual(6)
    expect(results.every((r) => r.status === 200)).toBe(true)
    expect(net.fetch).toHaveBeenCalledTimes(12)
  })
})

describe('civimg 视频流式代理（FN-02）', () => {
  it('示例视频流式代理：透传 Range 并返回 206', async () => {
    const target = 'https://image.civitai.com/x/video-range.mp4'
    vi.mocked(net.fetch).mockResolvedValue(
      new Response('vid', {
        status: 206,
        headers: {
          'Content-Range': 'bytes 10-12/100',
          'Accept-Ranges': 'bytes',
          'Content-Length': '3',
        },
      }),
    )
    const request = makeCivRequest(target)
    request.headers = new Headers({ range: 'bytes=10-' })
    const res = await civHandler(request)
    expect(res.status).toBe(206)
    expect(vi.mocked(net.fetch)).toHaveBeenCalledWith(
      target,
      expect.objectContaining({
        headers: expect.objectContaining({ Range: 'bytes=10-' }),
      }),
    )
    expect(res.headers.get('content-range')).toBe('bytes 10-12/100')
    // 视频不进入图片缓存路径（仅一次网络请求）
    expect(net.fetch).toHaveBeenCalledTimes(1)
  })

  it('视频上游非 ok 返回 502 前取消未消费的上游 body（防连接挂留）', async () => {
    let cancelled = false
    vi.mocked(net.fetch).mockResolvedValue(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true
          },
        }),
        { status: 404 },
      ),
    )
    const res = await civHandler(
      makeCivRequest('https://image.civitai.com/x/cancel-body.mp4'),
    )
    expect(res.status).toBe(502)
    expect(cancelled).toBe(true)
  })

  it('isCivitaiVideoUrl：识别常见视频扩展名', () => {
    expect(isCivitaiVideoUrl('https://image.civitai.com/a/b.mp4')).toBe(true)
    expect(isCivitaiVideoUrl('https://image.civitai.com/a/b.webm?x=1')).toBe(
      true,
    )
    expect(isCivitaiVideoUrl('https://image.civitai.com/a/b.jpeg')).toBe(false)
    expect(isCivitaiVideoUrl(null)).toBe(false)
  })

  it('非法 Range 头丢弃后按无 Range 回源，合法单区间照常透传', async () => {
    // 每次回源生成新 Response（body 一次性，不可复用同一实例）
    vi.mocked(net.fetch).mockImplementation(() =>
      Promise.resolve(
        new Response('vid', {
          status: 200,
          headers: { 'Content-Type': 'video/mp4' },
        }),
      ),
    )
    const target = 'https://image.civitai.com/x/evil.mp4'

    // 多区间（逗号）：合法 header 值但不符白名单格式 → 不透传
    const multi = makeCivRequest(target)
    multi.headers = new Headers({ range: 'bytes=0-1,5-9' })
    await civHandler(multi)
    expect(vi.mocked(net.fetch).mock.calls[0][1].headers.Range).toBeUndefined()

    // 字节数超长（>16 位）→ 不透传
    const huge = makeCivRequest(target)
    huge.headers = new Headers({ range: 'bytes=99999999999999999999-' })
    await civHandler(huge)
    expect(vi.mocked(net.fetch).mock.calls[1][1].headers.Range).toBeUndefined()

    // 合法闭区间 / 开区间 → 原样透传
    const closed = makeCivRequest(target)
    closed.headers = new Headers({ range: 'bytes=100-200' })
    await civHandler(closed)
    expect(vi.mocked(net.fetch).mock.calls[2][1].headers.Range).toBe(
      'bytes=100-200',
    )
    const open = makeCivRequest(target)
    open.headers = new Headers({ range: 'bytes=10-' })
    await civHandler(open)
    expect(vi.mocked(net.fetch).mock.calls[3][1].headers.Range).toBe(
      'bytes=10-',
    )
  })

  it('视频代理响应头按白名单重建：Set-Cookie 不透传，Content-Range/Content-Length 保留', async () => {
    vi.mocked(net.fetch).mockResolvedValue(
      new Response('vid', {
        status: 206,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Range': 'bytes 0-2/100',
          'Content-Length': '3',
          'Set-Cookie': 'track=1',
          'X-Upstream': 'leak',
        },
      }),
    )
    const request = makeCivRequest('https://image.civitai.com/x/v.mp4')
    request.headers = new Headers({ range: 'bytes=0-2' })
    const res = await civHandler(request)
    expect(res.status).toBe(206)
    expect(res.headers.get('Set-Cookie')).toBeNull()
    expect(res.headers.get('X-Upstream')).toBeNull()
    // 流式播放语义所需的头保留
    expect(res.headers.get('Content-Range')).toBe('bytes 0-2/100')
    expect(res.headers.get('Content-Length')).toBe('3')
  })

  it('视频槽位在响应头到达后即释放，不因 body 流未完成而阻塞图片回源', async () => {
    vi.mocked(net.fetch).mockImplementation(async (url) => {
      if (String(url).endsWith('.mp4')) {
        // 头部立即到达，body 流永不结束（长播放形态）
        return new Response(new ReadableStream({ start() {} }), {
          status: 206,
          headers: { 'Content-Length': '100', 'Accept-Ranges': 'bytes' },
        })
      }
      return new Response('img-bytes', {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      })
    })
    const videoReq = makeCivRequest('https://image.civitai.com/x/slot.mp4')
    videoReq.headers = new Headers()
    const results = await Promise.all([
      civHandler(videoReq),
      ...Array.from({ length: 6 }, (_, i) =>
        civHandler(makeCivRequest(`https://image.civitai.com/after/${i}.jpeg`)),
      ),
    ])
    // 若视频槽位持有到 body 结束（永不），6 张图会占满剩余槽位且第 6 张饿死
    expect(results.map((r) => r.status)).toEqual([
      206, 200, 200, 200, 200, 200, 200,
    ])
  })
})

describe('civimg 磁盘缓存（O-5）', () => {
  it('首次请求回源并写入磁盘缓存，二次请求由缓存服务（不再发起网络请求）', async () => {
    vi.mocked(net.fetch).mockResolvedValue(
      new Response(PNG_MAGIC, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    )
    const target =
      'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/uuid/original=true/2.png'

    const res1 = await civHandler(makeCivRequest(target))
    expect(res1.status).toBe(200)
    expect(vi.mocked(net.fetch)).toHaveBeenCalledTimes(1)
    // 回源成功后缓存条目落盘（位于当前库 .modelvault/civcache/，与 thumbs 同范式）
    const cachePath = getCivImageCachePath(target)
    expect(cachePath).toContain(path.join('.modelvault', 'civcache'))
    await expect(fs.access(cachePath)).resolves.toBeUndefined()

    const res2 = await civHandler(makeCivRequest(target))
    expect(res2.status).toBe(200)
    // 命中磁盘缓存：网络请求次数不变
    expect(vi.mocked(net.fetch)).toHaveBeenCalledTimes(1)
    expect(Buffer.from(await res2.arrayBuffer())).toEqual(PNG_MAGIC)
    expect(res2.headers.get('Content-Type')).toBe('image/png')
    expect(res2.headers.get('Cache-Control')).toContain('max-age=86400')
  })

  it('非图片内容（魔数不符）不放行入缓存', async () => {
    vi.mocked(net.fetch).mockResolvedValue(
      new Response('upstream-error-page', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    )
    const target = 'https://image.civitai.com/b/3.png'
    const res = await civHandler(makeCivRequest(target))
    expect(res.status).toBe(200)
    await expect(fs.access(getCivImageCachePath(target))).rejects.toThrow()
  })

  it('缓存条目损坏（魔数不符）时删除自愈并重新回源', async () => {
    // 每次回源生成新 Response（Response body 一次性，mockResolvedValue 复用
    // 同一实例会在二次消费时抛 Body is unusable）
    vi.mocked(net.fetch).mockImplementation(() =>
      Promise.resolve(new Response(PNG_MAGIC, { status: 200 })),
    )
    const target = 'https://image.civitai.com/c/4.png'
    expect((await civHandler(makeCivRequest(target))).status).toBe(200)
    expect(vi.mocked(net.fetch)).toHaveBeenCalledTimes(1)

    // 模拟半写/损坏：覆写缓存文件为非图片内容
    await fs.writeFile(getCivImageCachePath(target), 'corrupted-not-an-image')
    const res = await civHandler(makeCivRequest(target))
    expect(res.status).toBe(200)
    // 损坏条目已删除并重新拉取
    expect(vi.mocked(net.fetch)).toHaveBeenCalledTimes(2)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG_MAGIC)
  })

  it('OPT-14：库根离线时 saveCivImageCache 跳过写入且不重建目录树', async () => {
    const offlineRoot = path.join(root, 'offline-lib')
    setDataRoot(offlineRoot)
    try {
      await saveCivImageCache(
        'https://image.civitai.com/opt14/cached.png',
        Buffer.from('img-bytes'),
      )
      // 关键回归：失效路径上没有任何目录被重建
      await expect(
        fs.access(path.join(offlineRoot, '.modelvault')),
      ).rejects.toThrow()
      await expect(fs.access(offlineRoot)).rejects.toThrow()
    } finally {
      setDataRoot(root)
    }
  })
})

describe('civimg 上游失败负缓存（OPT-7）', () => {
  it('上游失败记入负缓存：静默期内同 URL 零回源直接返回失败', async () => {
    setCivimgFailTtlForTests(60000)
    const target = 'https://image.civitai.com/opt7/deleted-1.png'
    vi.mocked(net.fetch).mockRejectedValue(new Error('网络不可达'))

    const first = await civHandler(makeCivRequest(target))
    expect(first.status).toBe(502)
    expect(net.fetch).toHaveBeenCalledTimes(1)

    // 静默期内再次请求（画廊滚动重复触发）：零回源直接失败——
    // 旧实现每次 <img> 都重走完整回源（白名单校验 + fetch + 超时等待）
    const second = await civHandler(makeCivRequest(target))
    expect(second.status).toBe(502)
    expect(net.fetch).toHaveBeenCalledTimes(1)
  })

  it('静默期到期自动恢复回源；成功后由磁盘缓存服务且失败记录已清除', async () => {
    setCivimgFailTtlForTests(20)
    const target = 'https://image.civitai.com/opt7/relisted-2.png'
    vi.mocked(net.fetch).mockRejectedValue(new Error('网络不可达'))
    expect((await civHandler(makeCivRequest(target))).status).toBe(502)

    // 静默期（20ms）到期：恢复回源，本次成功（真实 PNG 魔数入磁盘缓存）
    vi.mocked(net.fetch).mockResolvedValue(
      new Response(PNG_MAGIC, {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await civHandler(makeCivRequest(target))).status).toBe(200)
    expect(net.fetch).toHaveBeenCalledTimes(2)

    // 成功即清除失败记录：第三次请求命中磁盘缓存（200 而非负缓存的 502）
    const third = await civHandler(makeCivRequest(target))
    expect(third.status).toBe(200)
    expect(net.fetch).toHaveBeenCalledTimes(2)
  })
})

describe('civimg 有界等待（#46）：停滞上游与挂起磁盘不再永久占死并发槽', () => {
  it('响应头到达后 body 停滞：空闲超时中止返回 502，并记入负缓存静默期内零回源', async () => {
    setCivimgBodyIdleTimeoutForTests(30)
    // 半开连接形态：头部立即到达，body 流永不出字也永不关闭
    vi.mocked(net.fetch).mockImplementation(() =>
      Promise.resolve(
        new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg' },
        }),
      ),
    )
    const target = 'https://image.civitai.com/stall-body/1.png'
    expect((await civHandler(makeCivRequest(target))).status).toBe(502)
    expect(net.fetch).toHaveBeenCalledTimes(1)
    // 中止路径与网络失败同走负缓存：静默期内同 URL 零回源（到期自愈）
    expect((await civHandler(makeCivRequest(target))).status).toBe(502)
    expect(net.fetch).toHaveBeenCalledTimes(1)
  })

  it('6 路停滞回源超时中止释放槽位后，第 7 路回源不再饿死', async () => {
    setCivimgBodyIdleTimeoutForTests(30)
    vi.mocked(net.fetch).mockImplementation((url) => {
      if (String(url).includes('/stall-body/')) {
        return Promise.resolve(
          new Response(new ReadableStream({ start() {} }), {
            status: 200,
            headers: { 'Content-Type': 'image/jpeg' },
          }),
        )
      }
      return Promise.resolve(
        new Response(PNG_MAGIC, {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        }),
      )
    })
    const stalled = Array.from({ length: 6 }, (_, i) =>
      civHandler(
        makeCivRequest(`https://image.civitai.com/stall-body/${i}.png`),
      ),
    )
    const good = civHandler(
      makeCivRequest('https://image.civitai.com/after-stall/7.png'),
    )
    const results = await Promise.all([...stalled, good])
    // 修复前：6 路停滞回源永久占满槽位，第 7 路排队挂死（用例超时失败）
    expect(results.slice(0, 6).every((r) => r.status === 502)).toBe(true)
    expect(results[6].status).toBe(200)
  })

  it('槽内磁盘缓存写入停滞：等待有界照常返回图片，槽位不阻塞后续回源', async () => {
    setCivimgCacheWriteTimeoutForTests(20)
    // 挂起盘形态：两次写入均永不 settle（Once 用尽后自动回落真实实现）
    vi.mocked(saveCivImageCache)
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementationOnce(() => new Promise(() => {}))
    vi.mocked(net.fetch).mockImplementation(() =>
      Promise.resolve(
        new Response(PNG_MAGIC, {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        }),
      ),
    )
    const first = await civHandler(
      makeCivRequest('https://image.civitai.com/hang-disk/1.png'),
    )
    expect(first.status).toBe(200)
    expect(Buffer.from(await first.arrayBuffer())).toEqual(PNG_MAGIC)
    // 槽位已随有界等待释放：第二个不同 URL 不被挂起的写入阻塞
    const second = await civHandler(
      makeCivRequest('https://image.civitai.com/hang-disk/2.png'),
    )
    expect(second.status).toBe(200)
  })
})
