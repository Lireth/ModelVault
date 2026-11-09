import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fakeUserData } from './setup'

/**
 * 应用内更新下载（update-download.js，F-6/OP-06/OPT-17/V-06/E1）单元测试：
 * - isSafeUpdateVersion / fetchAllowedUpdateUrl / findUpdateAssets：
 *   V-06 纯函数与白名单边界（文件名注入、逐跳主机白名单、资产命名约定）；
 * - downloadUpdatePackage 全分支：并发闸、无 pending、非法版本、校验和
 *   各失败态、本地完整包复用（含复用验签失败重下）、Range 续传三态
 *   （206 续传 / 416 无效 / 200 全量回退）、体积上限、边下边哈希不匹配、
 *   E1 验签失败删除分片、取消保留分片、瞬时错误单次重试、空闲超时中止；
 * - setPendingUpdate/getDownloadedFile/getUpdateDir 模块态契约
 *   （渲染层不可注入 URL 的结构性保证）。
 * 网络经 electron net.fetch 桩；update-verify 仅桩掉验签（校验和解析用
 * 真实实现）；utils 仅桩掉 raceIdleTimeout 的 60s 计时（缩短为 50ms 便于
 * 触发停滞分支），其余原语真实执行；文件 IO 全部落在每测试清空的
 * fakeUserData/update 临时目录。
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  net: { fetch: vi.fn(), request: vi.fn() },
}))

vi.mock('../src/main/services/update-verify', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, verifyUpdateSignature: vi.fn() }
})

vi.mock('../src/main/utils', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    // 空闲超时语义保留（TimeoutError + onCancel 先行落定），仅缩短计时
    raceIdleTimeout: (promise, _ms, message, onCancel) =>
      new Promise((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          reject(Object.assign(new Error(message), { name: 'TimeoutError' }))
          try {
            onCancel?.()
          } catch {
            /* 与真实实现一致：清理失败不影响中止 */
          }
        }, 50)
        promise.then(
          (v) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(v)
          },
          (e) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            reject(e)
          },
        )
      }),
  }
})

import { net } from 'electron'
import {
  isSafeUpdateVersion,
  fetchAllowedUpdateUrl,
  findUpdateAssets,
  setPendingUpdate,
  getUpdateDir,
  getDownloadedFile,
  downloadUpdatePackage,
  cancelUpdateDownload,
} from '../src/main/services/update-download'
import { verifyUpdateSignature } from '../src/main/services/update-verify'

const UPDATE_DIR = getUpdateDir()
const TARGET = path.join(UPDATE_DIR, 'ModelVault-9.9.9.exe')
const PART = `${TARGET}.download.part`

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex')

const EXE_URL =
  'https://github.com/Lireth/ModelVault/releases/download/v9.9.9/ModelVault-9.9.9.exe'
const SUM_URL = `${EXE_URL}.sha256`

/** 登记一次检查更新结果（下载入口的唯一合法 URL 来源） */
function armPending(size = 0) {
  setPendingUpdate(
    { downloadUrl: EXE_URL, checksumUrl: SUM_URL, size },
    '9.9.9',
  )
}

/**
 * 按 URL 路由 net.fetch 桩：checksum/download 各自可为 Response、
 * 拒绝错误或以 (url, options) 返回自定义 Promise。
 */
function routeFetches({ checksum, download } = {}) {
  vi.mocked(net.fetch).mockImplementation(async (url, options) => {
    const isSum = String(url).endsWith('.sha256')
    const handler = isSum ? checksum : download
    if (!handler) throw new Error(`未桩的 fetch: ${url}`)
    return typeof handler === 'function' ? await handler(url, options) : handler
  })
}

const checksumRes = (content) => new Response(String(content), { status: 200 })

beforeEach(async () => {
  vi.mocked(net.fetch).mockReset()
  vi.mocked(verifyUpdateSignature).mockReset()
  vi.mocked(verifyUpdateSignature).mockResolvedValue({
    ok: true,
    required: false,
  })
  setPendingUpdate(null, '')
  await fsp.rm(UPDATE_DIR, { recursive: true, force: true })
  await fsp.mkdir(UPDATE_DIR, { recursive: true })
})

describe('isSafeUpdateVersion（V-06 文件名注入面）', () => {
  it('仅接受纯数字三段版本号', () => {
    expect(isSafeUpdateVersion('0.6.0')).toBe(true)
    expect(isSafeUpdateVersion('99999.1.1')).toBe(true)
    expect(isSafeUpdateVersion('v0.6.0')).toBe(false)
    expect(isSafeUpdateVersion('0.6')).toBe(false)
    expect(isSafeUpdateVersion('0.6.0.1')).toBe(false)
    expect(isSafeUpdateVersion('100000.1.1')).toBe(false)
    expect(isSafeUpdateVersion('../evil')).toBe(false)
    expect(isSafeUpdateVersion(null)).toBe(false)
    expect(isSafeUpdateVersion(123)).toBe(false)
  })
})

describe('fetchAllowedUpdateUrl（逐跳白名单入口）', () => {
  it('GitHub API/页面/资产 CDN 主机放行，其余主机与非 https 拒绝', async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response('ok', { status: 200 }))
    for (const host of [
      'api.github.com',
      'github.com',
      'objects.githubusercontent.com',
      'release-assets.githubusercontent.com',
      'github-releases.githubusercontent.com',
    ]) {
      const res = await fetchAllowedUpdateUrl(`https://${host}/x`, {})
      expect(res.status).toBe(200)
    }
    await expect(
      fetchAllowedUpdateUrl('https://evil.com/x', {}),
    ).rejects.toThrow('更新下载地址不在白名单内')
    await expect(
      fetchAllowedUpdateUrl('http://github.com/x', {}),
    ).rejects.toThrow('更新下载地址不在白名单内')
    await expect(
      fetchAllowedUpdateUrl('https://github.com.evil.com/x', {}),
    ).rejects.toThrow('更新下载地址不在白名单内')
  })
})

describe('findUpdateAssets（命名约定 + 白名单双校验）', () => {
  const asset = (name, url, size) => ({
    name,
    browser_download_url: url,
    size,
  })
  const release = (assets) => ({ assets })

  it('exe 与 sha256 成对命中且地址合规：返回三元组', () => {
    expect(
      findUpdateAssets(
        release([
          asset('ModelVault-9.9.9.exe', EXE_URL, 456),
          asset('ModelVault-9.9.9.exe.sha256', SUM_URL, 100),
        ]),
        '9.9.9',
      ),
    ).toEqual({ downloadUrl: EXE_URL, checksumUrl: SUM_URL, size: 456 })
  })

  it('任一资产缺失/命名不符/版本不符：返回 null（回退下载页引导）', () => {
    const pair = [
      asset('ModelVault-9.9.9.exe', EXE_URL, 1),
      asset('ModelVault-9.9.9.exe.sha256', SUM_URL, 1),
    ]
    expect(findUpdateAssets(release([pair[0]]), '9.9.9')).toBeNull()
    expect(
      findUpdateAssets(
        release([asset('ModelVault-9.9.9.zip', EXE_URL, 1), pair[1]]),
        '9.9.9',
      ),
    ).toBeNull()
    expect(findUpdateAssets(release(pair), '0.6.0')).toBeNull()
    expect(findUpdateAssets(null, '9.9.9')).toBeNull()
    expect(findUpdateAssets(release(pair), '../x')).toBeNull()
  })

  it('下载地址不在外链白名单（含 CDN 域名与 http）：返回 null', () => {
    const pair = [
      asset(
        'ModelVault-9.9.9.exe',
        'https://objects.githubusercontent.com/x/ModelVault-9.9.9.exe',
        1,
      ),
      asset('ModelVault-9.9.9.exe.sha256', SUM_URL, 1),
    ]
    expect(findUpdateAssets(release(pair), '9.9.9')).toBeNull()
    pair[0] = asset('ModelVault-9.9.9.exe', 'http://github.com/a.exe', 1)
    expect(findUpdateAssets(release(pair), '9.9.9')).toBeNull()
  })

  it('size 非法（缺失/负数/NaN）归零，其余字段照常返回', () => {
    const r = findUpdateAssets(
      release([
        asset('ModelVault-9.9.9.exe', EXE_URL, -5),
        asset('ModelVault-9.9.9.exe.sha256', SUM_URL, 1),
      ]),
      '9.9.9',
    )
    expect(r.size).toBe(0)
  })
})

describe('模块态（渲染层不可注入 URL 的结构性保证）', () => {
  it('getUpdateDir 指向 userData/update；setPendingUpdate(null) 即清空', () => {
    expect(UPDATE_DIR).toBe(path.join(fakeUserData, 'update'))
    armPending(1)
    expect(getDownloadedFile()).toBe('')
  })
})

describe('downloadUpdatePackage（前置闸门）', () => {
  it('无检查更新结果：拒绝且不触网', async () => {
    const r = await downloadUpdatePackage()
    expect(r).toEqual({ error: expect.stringContaining('请先检查更新') })
    expect(net.fetch).not.toHaveBeenCalled()
  })

  it('pending 版本号非法（V-06 兜底）：拒绝并引导手动更新', async () => {
    setPendingUpdate(
      { downloadUrl: EXE_URL, checksumUrl: SUM_URL, size: 0 },
      '9.9.9/../evil',
    )
    const r = await downloadUpdatePackage()
    expect(r.error).toContain('版本号非法')
    expect(net.fetch).not.toHaveBeenCalled()
  })

  it('下载进行中拒绝并发请求；取消后闸门释放（OP-06 分片保留语义）', async () => {
    const content = Buffer.from('ABCDEFGHIJ')
    armPending(content.length)
    routeFetches({
      checksum: checksumRes(`${sha256Hex(content)}  ModelVault-9.9.9.exe`),
      download: (_url, options) =>
        new Promise((_, rej) => {
          options.signal.addEventListener('abort', () =>
            rej(new DOMException('已终止', 'AbortError')),
          )
        }),
    })
    const p = downloadUpdatePackage()
    await vi.waitFor(() => expect(net.fetch).toHaveBeenCalledTimes(2))
    const busy = await downloadUpdatePackage()
    expect(busy).toEqual({ error: expect.stringContaining('正在下载中') })
    expect(cancelUpdateDownload()).toEqual({ ok: true })
    expect(await p).toEqual({ canceled: true })
    // 闸门已在 finally 释放：空闲时取消为 no-op
    expect(cancelUpdateDownload()).toEqual({ ok: true })
  })
})

describe('downloadUpdatePackage（校验和阶段）', () => {
  it('校验和 HTTP 错误透传状态码', async () => {
    armPending()
    routeFetches({ checksum: new Response('', { status: 500 }) })
    const r = await downloadUpdatePackage()
    expect(r.error).toContain('校验和下载失败（HTTP 500）')
  })

  it('校验和请求超时映射专用文案', async () => {
    armPending()
    routeFetches({
      checksum: () => {
        const err = new Error('timed out')
        err.name = 'TimeoutError'
        throw err
      },
    })
    const r = await downloadUpdatePackage()
    expect(r.error).toContain('校验和下载超时')
  })

  it('校验和内容无合法 64 位 hex：格式异常', async () => {
    armPending()
    routeFetches({ checksum: checksumRes('deadbeef  short') })
    const r = await downloadUpdatePackage()
    expect(r.error).toContain('校验和文件格式异常')
  })
})

describe('downloadUpdatePackage（下载主链路）', () => {
  it('完整包已存在且哈希命中+验签通过：直接复用不重复下载', async () => {
    const content = Buffer.from('ALREADY-HERE')
    await fsp.writeFile(TARGET, content)
    armPending(content.length)
    routeFetches({
      checksum: checksumRes(`${sha256Hex(content)}  ModelVault-9.9.9.exe`),
    })
    const r = await downloadUpdatePackage()
    expect(r).toEqual({ path: TARGET, size: content.length, reused: true })
    expect(getDownloadedFile()).toBe(TARGET)
    expect(net.fetch).toHaveBeenCalledTimes(1)
    expect(verifyUpdateSignature).toHaveBeenCalledWith(TARGET)
  })

  it('复用命中但验签失败：删除旧包后重新下载（防本地被替换）', async () => {
    const content = Buffer.from('STALE-OK-HASH')
    await fsp.writeFile(TARGET, content)
    armPending(content.length)
    routeFetches({
      checksum: checksumRes(`${sha256Hex(content)}  ModelVault-9.9.9.exe`),
      download: () => new Response(content, { status: 200 }),
    })
    vi.mocked(verifyUpdateSignature)
      .mockResolvedValueOnce({
        ok: false,
        required: true,
        error: '更新包数字签名无效（HashMismatch）',
      })
      .mockResolvedValueOnce({ ok: true, required: false })
    const r = await downloadUpdatePackage()
    expect(r.path).toBe(TARGET)
    expect(r.reused).toBeUndefined()
    expect(net.fetch).toHaveBeenCalledTimes(2)
  })

  it('happy path：边下边哈希通过、原子改名、进度回调、分片清理', async () => {
    const content = Buffer.from('MODELVAULT-EXE-BYTES')
    armPending(content.length)
    routeFetches({
      checksum: checksumRes(`${sha256Hex(content)}  ModelVault-9.9.9.exe`),
      download: () =>
        new Response(content, {
          status: 200,
          headers: { 'content-length': String(content.length) },
        }),
    })
    const onProgress = vi.fn()
    const r = await downloadUpdatePackage(onProgress)
    expect(r).toEqual({ path: TARGET, size: content.length })
    await expect(fsp.readFile(TARGET)).resolves.toEqual(content)
    await expect(fsp.stat(PART)).rejects.toThrow()
    expect(getDownloadedFile()).toBe(TARGET)
    expect(onProgress).toHaveBeenCalledWith({
      received: content.length,
      total: content.length,
    })
  })

  it('哈希不匹配：删除分片并放弃本次下载（损坏/篡改语义）', async () => {
    const content = Buffer.from('CORRUPTED')
    armPending(content.length)
    routeFetches({
      checksum: checksumRes(`${'f'.repeat(64)}  ModelVault-9.9.9.exe`),
      download: () => new Response(content, { status: 200 }),
    })
    const r = await downloadUpdatePackage()
    expect(r.error).toContain('校验和不匹配')
    await expect(fsp.stat(PART)).rejects.toThrow()
    await expect(fsp.stat(TARGET)).rejects.toThrow()
  })

  it('哈希通过但 E1 验签失败：删除分片、错误文案透传', async () => {
    const content = Buffer.from('SIGN-BAD')
    armPending(content.length)
    routeFetches({
      checksum: checksumRes(`${sha256Hex(content)}  ModelVault-9.9.9.exe`),
      download: () => new Response(content, { status: 200 }),
    })
    vi.mocked(verifyUpdateSignature).mockResolvedValue({
      ok: false,
      required: true,
      error: '更新包签名者与预期发布者不一致',
    })
    const r = await downloadUpdatePackage()
    expect(r.error).toBe('更新包签名者与预期发布者不一致')
    await expect(fsp.stat(PART)).rejects.toThrow()
  })

  it('响应声明体积超 600MB 上限：拒绝下载并清理分片（V-06）', async () => {
    armPending()
    routeFetches({
      checksum: checksumRes(`${'a'.repeat(64)}  x`),
      download: () => ({
        ok: true,
        status: 200,
        headers: new Headers({
          'content-length': String(601 * 1024 * 1024),
        }),
        body: { getReader: () => ({ read: async () => ({ done: true }) }) },
      }),
    })
    const r = await downloadUpdatePackage()
    expect(r.error).toContain('超过 600MB')
    await expect(fsp.stat(PART)).rejects.toThrow()
  })

  it('连接级瞬时错误自动重试一次（幂等：响应未建立、零字节落盘）', async () => {
    const content = Buffer.from('RETRY-ONCE')
    armPending(content.length)
    let downloadCalls = 0
    routeFetches({
      checksum: checksumRes(`${sha256Hex(content)}  ModelVault-9.9.9.exe`),
      download: () => {
        downloadCalls += 1
        if (downloadCalls === 1) {
          throw Object.assign(new Error('connect ECONNRESET'), {
            code: 'ECONNRESET',
          })
        }
        return new Response(content, { status: 200 })
      },
    })
    const r = await downloadUpdatePackage()
    expect(r.path).toBe(TARGET)
    expect(downloadCalls).toBe(2)
  })

  it('下载停滞触发空闲超时：保留分片供续传（OPT-17①）', async () => {
    const content = Buffer.from('HALF-THEN-STALL')
    armPending(content.length)
    let first = true
    routeFetches({
      checksum: checksumRes(`${sha256Hex(content)}  ModelVault-9.9.9.exe`),
      download: () => {
        const body = new ReadableStream({
          pull(controller) {
            if (first) {
              first = false
              controller.enqueue(content.subarray(0, 4))
              return
            }
            // 第二段永不到达：模拟 TCP 停滞（桩 raceIdleTimeout 50ms 判死）
            return new Promise(() => {})
          },
        })
        return new Response(body, { status: 200 })
      },
    })
    const r = await downloadUpdatePackage()
    expect(r.error).toContain('无数据，已中止')
    const part = await fsp.readFile(PART)
    expect(part.length).toBeGreaterThan(0)
  })
})

describe('downloadUpdatePackage（OP-06 Range 续传三态）', () => {
  const full = Buffer.from('MODELVAULT-RESUME-CONTENT-0123456789')
  const half = full.subarray(0, 16)
  const rest = full.subarray(16)

  it('分片小于声明体积：携带 Range 续传，206 补齐后整体哈希通过', async () => {
    await fsp.writeFile(PART, half)
    armPending(full.length)
    routeFetches({
      checksum: checksumRes(`${sha256Hex(full)}  ModelVault-9.9.9.exe`),
      download: (_url, options) => {
        expect(options.headers.Range).toBe(`bytes=${half.length}-`)
        return new Response(rest, {
          status: 206,
          headers: { 'content-length': String(rest.length) },
        })
      },
    })
    const r = await downloadUpdatePackage()
    expect(r.path).toBe(TARGET)
    await expect(fsp.readFile(TARGET)).resolves.toEqual(full)
  })

  it('服务端返回 416：清理分片并提示重试', async () => {
    await fsp.writeFile(PART, half)
    armPending(full.length)
    routeFetches({
      checksum: checksumRes(`${sha256Hex(full)}  ModelVault-9.9.9.exe`),
      download: () => new Response('', { status: 416 }),
    })
    const r = await downloadUpdatePackage()
    expect(r.error).toContain('断点续传位置无效')
    await expect(fsp.stat(PART)).rejects.toThrow()
  })

  it('服务端忽略 Range 返回 200 全量：丢弃旧分片从头覆盖', async () => {
    await fsp.writeFile(PART, half)
    armPending(full.length)
    routeFetches({
      checksum: checksumRes(`${sha256Hex(full)}  ModelVault-9.9.9.exe`),
      download: () => new Response(full, { status: 200 }),
    })
    const r = await downloadUpdatePackage()
    expect(r.path).toBe(TARGET)
    await expect(fsp.readFile(TARGET)).resolves.toEqual(full)
  })

  it('分片不小于声明体积：视为陈旧残留，清理后从头下载', async () => {
    await fsp.writeFile(PART, full)
    armPending(half.length)
    routeFetches({
      checksum: checksumRes(`${sha256Hex(half)}  ModelVault-9.9.9.exe`),
      download: (_url, options) => {
        expect(options.headers).toBeUndefined()
        return new Response(half, { status: 200 })
      },
    })
    const r = await downloadUpdatePackage()
    expect(r.path).toBe(TARGET)
    await expect(fsp.readFile(TARGET)).resolves.toEqual(half)
  })
})
