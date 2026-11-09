import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { fakeUserData } from './setup'

/**
 * 更新包校验（update-verify.js，E1）单元测试：
 * - parseChecksumHash / normalizeThumbprint：纯函数解析边界；
 * - evaluateUpdateSignature：策略评估（Valid + 指纹一致才放行）；
 * - verifyUpdateSignature：fail-closed 全分支（未配置退化 / 非法配置 /
 *   非 Windows / 非法路径 / PowerShell 子进程成功、异常退出、坏输出、
 *   超时、stdout 超限 kill）。
 * spawn 以 vi.mock 桩替换，子进程用 EventEmitter 模拟事件时序；
 * 平台判断经 defineProperty 临时改写，保证 Linux CI 同样覆盖 win32 分支。
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
}))

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

import { spawn } from 'node:child_process'
import {
  parseChecksumHash,
  normalizeThumbprint,
  evaluateUpdateSignature,
  verifyUpdateSignature,
} from '../src/main/services/update-verify'

/** 合法 SHA1 指纹（40 hex，带分隔符形态用于规范化测试） */
const EXPECTED_FP = '0123456789abcdef0123456789abcdef01234567'

/** 构造 PowerShell 子进程桩：microtask 内按序喂 stdout/stderr 后发 exit */
function fakeChild({ stdout = '', stderr = '', exitCode = 0 } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout))
    if (stderr) child.stderr.emit('data', Buffer.from(stderr))
    child.emit('exit', exitCode)
  })
  return child
}

/** 以 win32 平台执行 fn（验签子进程分支的跨 CI 平台覆盖） */
async function onWin32(fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', desc)
  }
}

let savedThumbprint
beforeEach(() => {
  savedThumbprint = process.env.MODELVAULT_SIGNER_THUMBPRINT
  vi.mocked(spawn).mockReset()
})
afterEach(() => {
  if (savedThumbprint === undefined) {
    delete process.env.MODELVAULT_SIGNER_THUMBPRINT
  } else {
    process.env.MODELVAULT_SIGNER_THUMBPRINT = savedThumbprint
  }
  vi.useRealTimers()
})

describe('parseChecksumHash（sha256sum 兼容解析）', () => {
  it('解析「<hash>  <文件名>」标准格式并统一小写', () => {
    expect(
      parseChecksumHash(
        '2CF24DBA77E4B1C4AB0667608CE113D499A6C2B6F5E49C67C6C5B34D8A1234AB  ModelVault-0.6.0.exe\n',
      ),
    ).toBe('2cf24dba77e4b1c4ab0667608ce113d499a6c2b6f5e49c67c6c5b34d8a1234ab')
  })

  it('多行内容取首个 64 位 hex token（兼容校验和文件带注释行）', () => {
    const hash = 'a'.repeat(64)
    expect(
      parseChecksumHash(`# checksums\n${hash}  ModelVault-0.6.0.exe`),
    ).toBe(hash)
  })

  it('非字符串/无合法 token/超长 hex 均返回空串', () => {
    expect(parseChecksumHash(null)).toBe('')
    expect(parseChecksumHash(undefined)).toBe('')
    expect(parseChecksumHash(123)).toBe('')
    expect(parseChecksumHash('not a checksum')).toBe('')
    // 65 位 hex 后无边界：\b 不成立（下一字符仍是 hex 类），拒绝
    expect(parseChecksumHash(`${'a'.repeat(64)}b  file`)).toBe('')
  })
})

describe('normalizeThumbprint（指纹规范化）', () => {
  it('去除分隔符并统一大写；空值返回空串', () => {
    expect(normalizeThumbprint('01 23-45:67')).toBe('01234567')
    expect(normalizeThumbprint(undefined)).toBe('')
    expect(normalizeThumbprint(null)).toBe('')
  })
})

describe('evaluateUpdateSignature（策略评估，纯函数）', () => {
  it('查询结果为 null 时 fail-closed（PowerShell 不可用/超时文案）', () => {
    const r = evaluateUpdateSignature(null, EXPECTED_FP.toUpperCase())
    expect(r.ok).toBe(false)
    expect(r.required).toBe(true)
    expect(r.error).toContain('无法读取更新包数字签名')
  })

  it('状态非 Valid 一律拒绝，错误文案携带实际状态', () => {
    const r = evaluateUpdateSignature(
      { status: 'NotSigned', thumbprint: '', subject: '' },
      EXPECTED_FP.toUpperCase(),
    )
    expect(r.ok).toBe(false)
    expect(r.error).toContain('NotSigned')
  })

  it('Valid 但指纹缺失或不一致均拒绝', () => {
    const expected = EXPECTED_FP.toUpperCase()
    expect(
      evaluateUpdateSignature({ status: 'Valid', thumbprint: '' }, expected).ok,
    ).toBe(false)
    expect(
      evaluateUpdateSignature(
        { status: 'Valid', thumbprint: 'f'.repeat(40) },
        expected,
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining('不一致') })
  })

  it('Valid 且指纹一致放行；subject 非字符串时归一为空串', () => {
    const r = evaluateUpdateSignature(
      { status: 'Valid', thumbprint: EXPECTED_FP, subject: 'CN=ModelVault' },
      EXPECTED_FP.toUpperCase(),
    )
    expect(r).toEqual({
      ok: true,
      required: true,
      thumbprint: EXPECTED_FP.toUpperCase(),
      subject: 'CN=ModelVault',
    })
    expect(
      evaluateUpdateSignature(
        { status: 'Valid', thumbprint: EXPECTED_FP },
        EXPECTED_FP.toUpperCase(),
      ).subject,
    ).toBe('')
  })
})

describe('verifyUpdateSignature（入口策略与子进程链路）', () => {
  it('未配置预期指纹时退化为仅 SHA256（ok 且 required=false，不拉起子进程）', async () => {
    delete process.env.MODELVAULT_SIGNER_THUMBPRINT
    const r = await verifyUpdateSignature('C:\\tmp\\ModelVault-0.7.0.exe')
    expect(r).toEqual({ ok: true, required: false })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('配置值规范化后非 40/64 位 hex：fail-closed「配置无效」', async () => {
    process.env.MODELVAULT_SIGNER_THUMBPRINT = 'zzz-not-hex-zzz'
    const r = await verifyUpdateSignature('C:\\tmp\\a.exe')
    expect(r).toMatchObject({ ok: false, required: true })
    expect(r.error).toContain('配置无效')
  })

  it('非 Windows 平台拒绝验签（不拉起子进程）', async () => {
    const desc = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      process.env.MODELVAULT_SIGNER_THUMBPRINT = EXPECTED_FP
      const r = await verifyUpdateSignature('/tmp/a.exe')
      expect(r.error).toContain('仅支持 Windows')
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', desc)
    }
  })

  it('路径为空或非字符串拒绝', async () => {
    await onWin32(async () => {
      process.env.MODELVAULT_SIGNER_THUMBPRINT = EXPECTED_FP
      expect((await verifyUpdateSignature('')).error).toContain('路径无效')
      expect((await verifyUpdateSignature(undefined)).error).toContain(
        '路径无效',
      )
    })
  })

  it('win32 正常链路：PowerShell 输出 JSON（含 BOM）解析后放行', async () => {
    await onWin32(async () => {
      process.env.MODELVAULT_SIGNER_THUMBPRINT = EXPECTED_FP
      vi.mocked(spawn).mockReturnValue(
        fakeChild({
          stdout:
            '﻿{"status":"Valid","thumbprint":"' +
            EXPECTED_FP.toUpperCase() +
            '","subject":"CN=ModelVault Team"}',
        }),
      )
      const r = await verifyUpdateSignature('C:\\tmp\\ModelVault-0.7.0.exe')
      expect(r).toMatchObject({
        ok: true,
        required: true,
        thumbprint: EXPECTED_FP.toUpperCase(),
        subject: 'CN=ModelVault Team',
      })
      // 路径经环境变量传入脚本，杜绝命令拼接注入
      const [cmd, args, opts] = vi.mocked(spawn).mock.calls[0]
      expect(cmd).toBe('powershell.exe')
      expect(args).toContain('-NoProfile')
      expect(args).toContain('-NonInteractive')
      expect(opts.env.MODELVAULT_VERIFY_PATH).toBe(
        'C:\\tmp\\ModelVault-0.7.0.exe',
      )
      expect(args.join(' ')).not.toContain('ModelVault-0.7.0.exe')
    })
  })

  it('签名状态 NotSigned：拒绝且文案透传', async () => {
    await onWin32(async () => {
      process.env.MODELVAULT_SIGNER_THUMBPRINT = EXPECTED_FP
      vi.mocked(spawn).mockReturnValue(
        fakeChild({
          stdout: '{"status":"NotSigned","thumbprint":"","subject":""}',
        }),
      )
      const r = await verifyUpdateSignature('C:\\tmp\\a.exe')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('NotSigned')
    })
  })

  it('spawn 同步抛错（PowerShell 不存在）：fail-closed「无法读取」', async () => {
    await onWin32(async () => {
      process.env.MODELVAULT_SIGNER_THUMBPRINT = EXPECTED_FP
      vi.mocked(spawn).mockImplementation(() => {
        throw new Error('spawn powershell.exe ENOENT')
      })
      const r = await verifyUpdateSignature('C:\\tmp\\a.exe')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('无法读取更新包数字签名')
    })
  })

  it('子进程 error 事件（退出前崩溃）：fail-closed', async () => {
    await onWin32(async () => {
      process.env.MODELVAULT_SIGNER_THUMBPRINT = EXPECTED_FP
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = vi.fn()
      vi.mocked(spawn).mockReturnValue(child)
      const p = verifyUpdateSignature('C:\\tmp\\a.exe')
      queueMicrotask(() => child.emit('error', new Error('boom')))
      expect((await p).error).toContain('无法读取')
    })
  })

  it('非零退出码 + stderr 输出：fail-closed（消费 stderr 防管道阻塞）', async () => {
    await onWin32(async () => {
      process.env.MODELVAULT_SIGNER_THUMBPRINT = EXPECTED_FP
      vi.mocked(spawn).mockReturnValue(
        fakeChild({ exitCode: 1, stderr: 'Get-AuthenticodeSignature : 错误' }),
      )
      const r = await verifyUpdateSignature('C:\\tmp\\a.exe')
      expect(r.ok).toBe(false)
    })
  })

  it('stdout 非法 JSON：fail-closed', async () => {
    await onWin32(async () => {
      process.env.MODELVAULT_SIGNER_THUMBPRINT = EXPECTED_FP
      vi.mocked(spawn).mockReturnValue(fakeChild({ stdout: 'not-json' }))
      const r = await verifyUpdateSignature('C:\\tmp\\a.exe')
      expect(r.error).toContain('无法读取')
    })
  })

  it('stdout 超过 256KB：立即 kill 子进程并 fail-closed', async () => {
    await onWin32(async () => {
      process.env.MODELVAULT_SIGNER_THUMBPRINT = EXPECTED_FP
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = vi.fn()
      vi.mocked(spawn).mockReturnValue(child)
      const p = verifyUpdateSignature('C:\\tmp\\a.exe')
      await new Promise((r) => queueMicrotask(r))
      child.stdout.emit('data', Buffer.alloc(300 * 1024, 0x61))
      expect(child.kill).toHaveBeenCalled()
      expect((await p).error).toContain('无法读取')
    })
  })

  it('子进程挂起：20s 空闲超时后 kill 并 fail-closed', async () => {
    vi.useFakeTimers()
    await onWin32(async () => {
      process.env.MODELVAULT_SIGNER_THUMBPRINT = EXPECTED_FP
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = vi.fn()
      vi.mocked(spawn).mockReturnValue(child)
      const p = verifyUpdateSignature('C:\\tmp\\a.exe')
      await vi.advanceTimersByTimeAsync(20001)
      const r = await p
      expect(child.kill).toHaveBeenCalled()
      expect(r.error).toContain('无法读取更新包数字签名')
    })
  })
})
