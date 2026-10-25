import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fakeUserData } from './setup'

/**
 * 应用内更新下载/安装服务单元测试（F-6）：
 * - 校验和解析与资产提取（命名约定 + 白名单双校验）；
 * - 下载闭环：流式落盘 + SHA256 比对 + 已有包复用 + 损坏包拒绝；
 * - 安装：延迟拉起新 EXE（单实例锁竞争规避）并退出当前应用。
 * electron / child_process 由本文件提供最小桩。
 */
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => fakeUserData),
    isPackaged: true,
    getVersion: vi.fn(() => '0.1.0'),
    quit: vi.fn()
  },
  net: { fetch: vi.fn(), request: vi.fn() }
}))
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn(), once: vi.fn() }))
}))

import { app, net } from 'electron'
import { spawn } from 'node:child_process'
import {
  parseChecksumHash,
  findUpdateAssets,
  fetchAllowedUpdateUrl,
  setPendingUpdate,
  hasPendingUpdate,
  resetUpdateStateForTest,
  downloadUpdatePackage,
  cancelUpdateDownload,
  installUpdatePackage,
  normalizeThumbprint,
  evaluateUpdateSignature,
  verifyUpdateSignature,
  setAuthenticodeQueryForTests,
  setSignerThumbprintForTests
} from '../src/main/services/update-download'

const EXE_BYTES = Buffer.from('hello-exe')
/** 与 EXE_BYTES 一致的真实 SHA256（校验和闭环） */
const HASH = createHash('sha256').update(EXE_BYTES).digest('hex')
const CHECKSUM_BODY = `${HASH}  ModelVault-0.2.0.exe\n`

const ASSETS = {
  downloadUrl: 'https://github.com/Lireth/ModelVault/releases/download/v0.2.0/ModelVault-0.2.0.exe',
  checksumUrl:
    'https://github.com/Lireth/ModelVault/releases/download/v0.2.0/ModelVault-0.2.0.exe.sha256',
  size: EXE_BYTES.length
}
const RELEASE = {
  assets: [
    { name: 'ModelVault-0.2.0.exe', browser_download_url: ASSETS.downloadUrl, size: EXE_BYTES.length },
    {
      name: 'ModelVault-0.2.0.exe.sha256',
      browser_download_url: ASSETS.checksumUrl
    }
  ]
}

/** 更新目录（userData/update，fakeUserData 随测试文件自动清理） */
function updateDir() {
  return path.join(fakeUserData, 'update')
}

beforeEach(() => {
  // 隔离宿主环境变量：测试默认走「未配置指纹」的 SHA256 路径，
  // 验签用例通过 setSignerThumbprintForTests 显式开启
  delete process.env.MODELVAULT_SIGNER_THUMBPRINT
  vi.mocked(net.fetch).mockReset()
  vi.mocked(net.request).mockReset()
  vi.mocked(app.quit).mockClear()
  vi.mocked(spawn).mockClear()
  resetUpdateStateForTest()
})

afterEach(async () => {
  setAuthenticodeQueryForTests(null)
  setSignerThumbprintForTests('')
  await fs.rm(updateDir(), { recursive: true, force: true }).catch(() => {})
})

/** 按请求 URL 派发响应：校验和 / 更新包 */
function mockFetchFlow(exeBytes) {
  vi.mocked(net.fetch).mockImplementation((url) => {
    if (String(url).endsWith('.sha256')) {
      return Promise.resolve(new Response(CHECKSUM_BODY, { status: 200 }))
    }
    return Promise.resolve(
      new Response(exeBytes, {
        status: 200,
        headers: { 'content-length': String(exeBytes.length) }
      })
    )
  })
}

describe('parseChecksumHash（sha256sum 兼容解析）', () => {
  it('解析首个 64 位 hex token 并小写化', () => {
    expect(parseChecksumHash(`${'AB'.repeat(32)}  file.exe`)).toBe('ab'.repeat(32))
    expect(parseChecksumHash(`\n  ${HASH}  ModelVault-0.2.0.exe\n`)).toBe(HASH)
  })

  it('非法输入返回空串', () => {
    expect(parseChecksumHash('not-a-hash')).toBe('')
    expect(parseChecksumHash('')).toBe('')
    expect(parseChecksumHash(null)).toBe('')
    // 63 位长度不足
    expect(parseChecksumHash('a'.repeat(63))).toBe('')
  })
})

describe('findUpdateAssets（命名约定 + 白名单双校验）', () => {
  it('命中命名约定的资产对返回下载/校验和地址与体积', () => {
    const assets = findUpdateAssets(RELEASE, '0.2.0')
    expect(assets).toEqual(ASSETS)
  })

  it('资产名与版本不一致 / 缺少校验和 / 地址不在白名单时返回 null', () => {
    expect(findUpdateAssets(RELEASE, '0.3.0')).toBeNull()
    expect(
      findUpdateAssets({ assets: RELEASE.assets.filter((a) => !a.name.endsWith('.sha256')) }, '0.2.0')
    ).toBeNull()
    expect(
      findUpdateAssets(
        {
          assets: [
            { name: 'ModelVault-0.2.0.exe', browser_download_url: 'https://evil.com/x.exe', size: 1 },
            { name: 'ModelVault-0.2.0.exe.sha256', browser_download_url: 'https://evil.com/x.sha256' }
          ]
        },
        '0.2.0'
      )
    ).toBeNull()
    expect(findUpdateAssets(null, '0.2.0')).toBeNull()
  })
})

describe('fetchAllowedUpdateUrl（Electron 重定向兼容层）', () => {
  /** 构造只发一次 redirect 事件的 net.request 桩（Electron manual 模式） */
  function fakeRedirectingRequest(target) {
    const calls = []
    const impl = (opts) => {
      expect(opts.redirect).toBe('manual')
      // 更新链路为公开资产下载，探测不携带会话 Cookie（与 net.fetch 默认
      // 凭据语义一致；区别于 civitai 探测桩的 useSessionCookies: true）
      expect(opts.useSessionCookies).toBe(false)
      const listeners = {}
      const req = {
        on: (evt, cb) => {
          ;(listeners[evt] ||= []).push(cb)
          return req
        },
        end: () => {
          queueMicrotask(() => {
            listeners.redirect?.[0]?.(302, 'GET', target, { Location: [target] })
          })
        },
        // ClientRequest 的真实取消方法是 abort（无 cancel/destroy）
        abort: () => calls.push('abort')
      }
      return req
    }
    impl.calls = calls
    return impl
  }

  it('Electron 不支持 manual 重定向时（Redirect was cancelled），经 net.request 探测目标并逐跳继续', async () => {
    // Electron 实际行为：net.fetch manual 模式遇 3xx 直接抛错而非返回 3xx 响应；
    // GitHub Release 资产必经 302 跳转 CDN，缺失该兜底时更新下载必然失败
    const cdnUrl = 'https://objects.githubusercontent.com/gh-release-assets/abc/ModelVault-0.2.0.exe'
    const requestStub = fakeRedirectingRequest(cdnUrl)
    vi.mocked(net.fetch).mockImplementation(async (url) => {
      if (String(url) === ASSETS.downloadUrl) {
        throw new Error('Redirect was cancelled')
      }
      return new Response(EXE_BYTES, { status: 200 })
    })
    vi.mocked(net.request).mockImplementation(requestStub)

    const res = await fetchAllowedUpdateUrl(ASSETS.downloadUrl, {})
    expect(res.status).toBe(200)
    expect(net.fetch).toHaveBeenCalledTimes(2)
    expect(net.fetch).toHaveBeenLastCalledWith(cdnUrl, { redirect: 'manual' })
    // 探测完成后经 abort 取消底层请求（ClientRequest 无 cancel/destroy 方法，
    // 回归防御：调用不存在的方法会在事件处理器内抛错并演变为致命错误）
    expect(requestStub.calls).toContain('abort')
  })

  it('探测到的重定向目标不在白名单时同样拒绝（探测路径保持 V-06 门禁）', async () => {
    vi.mocked(net.fetch).mockImplementation(async () => {
      throw new Error('Redirect was cancelled')
    })
    vi.mocked(net.request).mockImplementation(
      fakeRedirectingRequest('https://evil.example.com/x.exe')
    )

    await expect(fetchAllowedUpdateUrl(ASSETS.downloadUrl, {})).rejects.toThrow(
      '重定向目标不在 GitHub 白名单内'
    )
  })

  it('非重定向取消类错误原样抛出，不进入探测路径', async () => {
    vi.mocked(net.fetch).mockRejectedValue(new Error('net::ERR_CONNECTION_RESET'))

    await expect(fetchAllowedUpdateUrl(ASSETS.downloadUrl, {})).rejects.toThrow(
      'ERR_CONNECTION_RESET'
    )
    expect(net.request).not.toHaveBeenCalled()
  })
})

describe('downloadUpdatePackage（下载 + SHA256 校验闭环）', () => {
  it('成功下载并通过校验，重复下载复用已有完整包', async () => {
    mockFetchFlow(EXE_BYTES)
    setPendingUpdate(ASSETS, '0.2.0')
    expect(hasPendingUpdate()).toBe(true)

    const res = await downloadUpdatePackage()
    expect(res.error).toBeUndefined()
    expect(res.path).toContain(path.join('update', 'ModelVault-0.2.0.exe'))
    expect(res.size).toBe(EXE_BYTES.length)
    const saved = await fs.readFile(res.path)
    expect(saved).toEqual(EXE_BYTES)
    // 无残留临时文件
    const names = await fs.readdir(updateDir())
    expect(names.every((n) => !n.endsWith('.part'))).toBe(true)

    // 第二次调用：本地完整包哈希命中，直接复用（仍需校验和请求，共 3 次网络请求）
    const res2 = await downloadUpdatePackage()
    expect(res2.reused).toBe(true)
    expect(res2.path).toBe(res.path)
  })

  it('中断后保留 .part，再次下载以 Range 续传并完成校验（OP-06）', async () => {
    const partPath = path.join(updateDir(), 'ModelVault-0.2.0.exe.download.part')
    await fs.mkdir(updateDir(), { recursive: true })
    // 预置前 5 字节（模拟上次中断）
    await fs.writeFile(partPath, EXE_BYTES.subarray(0, 5))

    vi.mocked(net.fetch).mockImplementation((url, options) => {
      if (String(url).endsWith('.sha256')) {
        return Promise.resolve(new Response(CHECKSUM_BODY, { status: 200 }))
      }
      expect(options.headers.Range).toBe('bytes=5-')
      const rest = EXE_BYTES.subarray(5)
      return Promise.resolve(
        new Response(rest, {
          status: 206,
          headers: { 'content-length': String(rest.length) }
        })
      )
    })
    setPendingUpdate(ASSETS, '0.2.0')

    const res = await downloadUpdatePackage()
    expect(res.error).toBeUndefined()
    expect(await fs.readFile(res.path)).toEqual(EXE_BYTES)
    const names = await fs.readdir(updateDir())
    expect(names.every((n) => !n.endsWith('.part'))).toBe(true)
  })

  it('服务端忽略 Range（200 全量）时丢弃旧分片从头覆盖', async () => {
    const partPath = path.join(updateDir(), 'ModelVault-0.2.0.exe.download.part')
    await fs.mkdir(updateDir(), { recursive: true })
    await fs.writeFile(partPath, Buffer.from('garbage'))

    vi.mocked(net.fetch).mockImplementation((url, options) => {
      if (String(url).endsWith('.sha256')) {
        return Promise.resolve(new Response(CHECKSUM_BODY, { status: 200 }))
      }
      expect(options.headers.Range).toBe('bytes=7-')
      return Promise.resolve(
        new Response(EXE_BYTES, {
          status: 200,
          headers: { 'content-length': String(EXE_BYTES.length) }
        })
      )
    })
    setPendingUpdate(ASSETS, '0.2.0')

    const res = await downloadUpdatePackage()
    expect(res.error).toBeUndefined()
    expect(await fs.readFile(res.path)).toEqual(EXE_BYTES)
  })

  it('网络失败保留已下载分片供下次续传', async () => {
    const partPath = path.join(updateDir(), 'ModelVault-0.2.0.exe.download.part')
    await fs.mkdir(updateDir(), { recursive: true })
    await fs.writeFile(partPath, EXE_BYTES.subarray(0, 5))

    vi.mocked(net.fetch).mockImplementation((url) => {
      if (String(url).endsWith('.sha256')) {
        return Promise.resolve(new Response(CHECKSUM_BODY, { status: 200 }))
      }
      return Promise.reject(new Error('network down'))
    })
    setPendingUpdate(ASSETS, '0.2.0')

    const res = await downloadUpdatePackage()
    expect(res.error).toContain('network down')
    await expect(fs.stat(partPath)).resolves.toBeTruthy()
  })

  it('校验和不匹配时拒绝落盘并清理临时文件', async () => {
    // 内容与校验和不符（'world...' 的 SHA256 ≠ HASH）
    mockFetchFlow(Buffer.from('world-exe'))
    setPendingUpdate(ASSETS, '0.2.0')
    const res = await downloadUpdatePackage()
    expect(res.error).toContain('校验和不匹配')
    const names = await fs.readdir(updateDir())
    expect(names.length).toBe(0)
  })

  it('无可用更新信息时拒绝；空闲取消为 no-op', async () => {
    expect(await downloadUpdatePackage()).toEqual({ error: '没有可用的更新信息，请先检查更新' })
    expect(cancelUpdateDownload()).toEqual({ ok: true })
  })

  it('下载进行中（busy）拒绝并发请求；完成后第一个请求正常落盘', async () => {
    setPendingUpdate(ASSETS, '0.2.0')
    // 更新包请求挂起直到放行：期间 downloadAbort 已置位，并发请求被拒
    let releaseFetch
    const gate = new Promise((resolve) => {
      releaseFetch = resolve
    })
    vi.mocked(net.fetch).mockImplementation((url) => {
      if (String(url).endsWith('.sha256')) {
        return Promise.resolve(new Response(CHECKSUM_BODY, { status: 200 }))
      }
      return gate.then(
        () =>
          new Response(EXE_BYTES, {
            status: 200,
            headers: { 'content-length': String(EXE_BYTES.length) }
          })
      )
    })
    const first = downloadUpdatePackage()
    // 并发闸在函数入口同步置位（首个 await 之前）：第二个调用必然立即被拒
    const second = await downloadUpdatePackage()
    expect(second).toEqual({ error: '更新包正在下载中，请稍候' })

    releaseFetch()
    await expect(first).resolves.toMatchObject({ size: EXE_BYTES.length })
  })

  it('下载被中止（AbortError）返回 canceled', async () => {
    setPendingUpdate(ASSETS, '0.2.0')
    vi.mocked(net.fetch).mockImplementation((url) => {
      if (String(url).endsWith('.sha256')) {
        return Promise.resolve(new Response(CHECKSUM_BODY, { status: 200 }))
      }
      const err = new Error('aborted')
      err.name = 'AbortError'
      return Promise.reject(err)
    })
    await expect(downloadUpdatePackage()).resolves.toEqual({ canceled: true })
  })

  it('版本号非法时拒绝下载，不发起网络请求（V-06 路径注入防护）', async () => {
    setPendingUpdate(ASSETS, '../../evil')
    const res = await downloadUpdatePackage()
    expect(res.error).toContain('版本号非法')
    expect(net.fetch).not.toHaveBeenCalled()
  })

  it('校验和重定向到 GitHub 白名单外主机时拒绝（V-06）', async () => {
    vi.mocked(net.fetch).mockResolvedValue(
      new Response('', { status: 302, headers: { Location: 'https://evil.example.com/x' } })
    )
    setPendingUpdate(ASSETS, '0.2.0')
    const res = await downloadUpdatePackage()
    expect(res.error).toContain('重定向目标不在 GitHub 白名单')
  })

  it('校验和文件超过 64KB 上限时拒绝', async () => {
    vi.mocked(net.fetch).mockResolvedValue(
      new Response('x', {
        status: 200,
        headers: { 'Content-Length': String(65 * 1024) }
      })
    )
    setPendingUpdate(ASSETS, '0.2.0')
    const res = await downloadUpdatePackage()
    expect(res.error).toContain('校验和文件过大')
  })

  it('更新包 Content-Length 超过 600MB 时在落盘前拒绝', async () => {
    vi.mocked(net.fetch).mockImplementation((url) => {
      if (String(url).endsWith('.sha256')) {
        return Promise.resolve(new Response(CHECKSUM_BODY, { status: 200 }))
      }
      return Promise.resolve(
        new Response('x', {
          status: 200,
          headers: { 'Content-Length': String(601 * 1024 * 1024) }
        })
      )
    })
    setPendingUpdate(ASSETS, '0.2.0')
    const res = await downloadUpdatePackage()
    expect(res.error).toContain('体积异常')
  })
})

describe('E1 Authenticode 更新包验签', () => {
  const THUMB = 'A'.repeat(40)

  it('指纹规范化与签名结果判定（Valid + 指纹一致才通过）', () => {
    expect(normalizeThumbprint('aa bb:cc-dd')).toBe('AABBCCDD')
    expect(evaluateUpdateSignature(null, THUMB)).toMatchObject({ ok: false })
    expect(
      evaluateUpdateSignature({ status: 'NotSigned', thumbprint: '' }, THUMB)
    ).toMatchObject({ ok: false, error: expect.stringContaining('NotSigned') })
    expect(
      evaluateUpdateSignature({ status: 'Valid', thumbprint: 'B'.repeat(40) }, THUMB)
    ).toMatchObject({ ok: false, error: expect.stringContaining('不一致') })
    expect(
      evaluateUpdateSignature(
        { status: 'Valid', thumbprint: THUMB, subject: 'CN=ModelVault' },
        THUMB
      )
    ).toEqual({
      ok: true,
      required: true,
      thumbprint: THUMB,
      subject: 'CN=ModelVault'
    })
  })

  it('配置发布者指纹后，下载必须验签通过才落盘', async () => {
    setSignerThumbprintForTests(THUMB)
    setAuthenticodeQueryForTests(async () => ({
      status: 'Valid',
      thumbprint: THUMB,
      subject: 'CN=ModelVault'
    }))
    mockFetchFlow(EXE_BYTES)
    setPendingUpdate(ASSETS, '0.2.0')

    const res = await downloadUpdatePackage()

    expect(res.error).toBeUndefined()
    await expect(fs.access(res.path)).resolves.toBeUndefined()
    const sig = await verifyUpdateSignature(res.path)
    expect(sig).toMatchObject({ ok: true, required: true })
  })

  it('验签失败时拒绝下载并删除临时文件', async () => {
    setSignerThumbprintForTests(THUMB)
    setAuthenticodeQueryForTests(async () => ({ status: 'HashMismatch', thumbprint: THUMB }))
    mockFetchFlow(EXE_BYTES)
    setPendingUpdate(ASSETS, '0.2.0')

    const res = await downloadUpdatePackage()

    expect(res.error).toContain('数字签名无效')
    await expect(
      fs.access(path.join(updateDir(), 'ModelVault-0.2.0.exe'))
    ).rejects.toThrow()
  })

  it('安装前复验失败时拒绝执行（防止下载后文件被替换）', async () => {
    setSignerThumbprintForTests(THUMB)
    let valid = true
    setAuthenticodeQueryForTests(async () =>
      valid
        ? { status: 'Valid', thumbprint: THUMB }
        : { status: 'HashMismatch', thumbprint: THUMB }
    )
    mockFetchFlow(EXE_BYTES)
    setPendingUpdate(ASSETS, '0.2.0')
    const res = await downloadUpdatePackage()
    expect(res.error).toBeUndefined()

    valid = false
    const install = await installUpdatePackage()

    expect(install.error).toContain('数字签名无效')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('配置值非法时 fail-closed，不退化为仅 SHA256', async () => {
    setSignerThumbprintForTests('not-a-thumbprint')
    await expect(verifyUpdateSignature('/tmp/x.exe')).resolves.toMatchObject({
      ok: false,
      error: '发布者签名指纹配置无效'
    })
  })

  it('未配置发布者指纹时跳过 Authenticode 查询（SHA256 闭环不变）', async () => {
    const query = vi.fn()
    setAuthenticodeQueryForTests(query)
    mockFetchFlow(EXE_BYTES)
    setPendingUpdate(ASSETS, '0.2.0')

    const res = await downloadUpdatePackage()

    expect(res.error).toBeUndefined()
    expect(query).not.toHaveBeenCalled()
  })
})

describe('installUpdatePackage（拉起新版本并等待旧实例退出）', () => {
  it('未下载更新包时拒绝', async () => {
    expect(await installUpdatePackage()).toEqual({ error: '尚未下载更新包，请先下载更新' })
  })

  it('直接拉起新 EXE（带 --wait-for-pid），不经 shell，并退出当前应用', async () => {
    vi.useFakeTimers()
    try {
      mockFetchFlow(EXE_BYTES)
      setPendingUpdate(ASSETS, '0.2.0')
      const res = await downloadUpdatePackage()
      expect(res.error).toBeUndefined()

      const install = await installUpdatePackage()
      expect(install).toEqual({ ok: true })
      expect(spawn).toHaveBeenCalledTimes(1)
      const [exe, args, options] = vi.mocked(spawn).mock.calls[0]
      // 路径作为 spawn 参数直接传递：不经过 cmd/start，无命令拼接注入面
      expect(String(exe)).toContain('ModelVault-0.2.0.exe')
      expect(String(exe).toLowerCase()).not.toContain('cmd.exe')
      expect(args).toEqual([`--wait-for-pid=${process.pid}`])
      expect(options).toEqual(expect.objectContaining({ detached: true, windowsHide: true }))
      // 立即拉起新实例；500ms 后退出当前实例释放单实例锁
      expect(app.quit).not.toHaveBeenCalled()
      vi.advanceTimersByTime(600)
      expect(app.quit).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
