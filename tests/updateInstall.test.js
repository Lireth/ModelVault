import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fakeUserData } from './setup'

/**
 * 更新包安装（update-install.js，V-06/E1/P0-5）单元测试：
 * 安装入口的完整拒绝链与成功链——
 * - 未下载 / 路径越界（update 目录之外）/ 文件名不符版本白名单：拒绝执行；
 * - 文件不存在或不是普通文件：拒绝（异步 stat，P0-5 主线程零同步 IO）；
 * - 缺少 SHA256 基准 / 哈希与基准不一致（拒绝并清理）/ 哈希读取失败：拒绝；
 * - 安装前签名复核失败：拒绝（覆盖「下载后文件被替换」窗口）；
 * - 成功：spawn 直接传参（不经 shell）携带 --wait-for-pid=<pid>、
 *   detached+unref 不阻塞退出，500ms 后才 app.quit；
 * - spawn 同步抛错：错误文案返回、不安排退出；子进程 error 事件仅记日志。
 * update-download/update-verify 以模块桩隔离（安装模块只消费其导出）。
 */

const UPDATE_DIR = path.join(fakeUserData, 'update')
const TARGET = path.join(UPDATE_DIR, 'ModelVault-9.9.9.exe')
const FILE_CONTENT = 'EXE'
const FILE_CHECKSUM = createHash('sha256').update(FILE_CONTENT).digest('hex')

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => fakeUserData),
    isPackaged: true,
    quit: vi.fn(),
  },
}))

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

vi.mock('../src/main/services/update-download', () => ({
  getDownloadedFile: vi.fn(() => ''),
  getUpdateDir: vi.fn(() => UPDATE_DIR),
  getDownloadedChecksum: vi.fn(() => ''),
  hashFile: vi.fn(),
}))

vi.mock('../src/main/services/update-verify', () => ({
  verifyUpdateSignature: vi.fn(),
}))

import { app } from 'electron'
import { spawn } from 'node:child_process'
import {
  getDownloadedChecksum,
  getDownloadedFile,
  hashFile,
} from '../src/main/services/update-download'
import { verifyUpdateSignature } from '../src/main/services/update-verify'
import { installUpdatePackage } from '../src/main/services/update-install'

/** 构造 detached 子进程桩（unref + error 事件面） */
function fakeChild() {
  const child = new EventEmitter()
  child.unref = vi.fn()
  return child
}

beforeEach(async () => {
  vi.mocked(spawn).mockReset()
  vi.mocked(app.quit).mockReset()
  vi.mocked(getDownloadedFile).mockReset()
  vi.mocked(getDownloadedFile).mockReturnValue(TARGET)
  vi.mocked(verifyUpdateSignature).mockReset()
  vi.mocked(verifyUpdateSignature).mockResolvedValue({
    ok: true,
    required: false,
  })
  await fsp.rm(UPDATE_DIR, { recursive: true, force: true })
  await fsp.mkdir(UPDATE_DIR, { recursive: true })
  await fsp.writeFile(TARGET, FILE_CONTENT)
  vi.mocked(getDownloadedChecksum).mockReset()
  vi.mocked(getDownloadedChecksum).mockReturnValue(FILE_CHECKSUM)
  vi.mocked(hashFile).mockReset()
  vi.mocked(hashFile).mockResolvedValue(FILE_CHECKSUM)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('installUpdatePackage（拒绝链）', () => {
  it('尚未下载更新包：拒绝且不触 stat/spawn', async () => {
    vi.mocked(getDownloadedFile).mockReturnValue('')
    const r = await installUpdatePackage()
    expect(r).toEqual({ error: expect.stringContaining('尚未下载') })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('下载来源路径位于 update 目录之外：拒绝执行（防目录外注入）', async () => {
    vi.mocked(getDownloadedFile).mockReturnValue(
      path.join(os.tmpdir(), 'ModelVault-9.9.9.exe'),
    )
    const r = await installUpdatePackage()
    expect(r).toEqual({ error: expect.stringContaining('路径异常') })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('update 目录内但文件名不符合版本白名单：拒绝执行', async () => {
    const evil = path.join(UPDATE_DIR, 'ModelVault-9.9.exe')
    await fsp.writeFile(evil, 'EXE')
    vi.mocked(getDownloadedFile).mockReturnValue(evil)
    const r = await installUpdatePackage()
    expect(r.error).toContain('路径异常')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('文件不存在：拒绝（异步 stat 异常兜底）', async () => {
    await fsp.rm(TARGET, { force: true })
    const r = await installUpdatePackage()
    expect(r).toEqual({ error: expect.stringContaining('不存在') })
  })

  it('目标不是普通文件（同名目录）：拒绝', async () => {
    await fsp.rm(TARGET, { recursive: true, force: true })
    await fsp.mkdir(TARGET)
    const r = await installUpdatePackage()
    expect(r.error).toContain('不存在')
  })

  it('安装前签名复核失败：拒绝拉起（E1 防下载后被替换）', async () => {
    vi.mocked(verifyUpdateSignature).mockResolvedValue({
      ok: false,
      required: true,
      error: '更新包数字签名无效（HashMismatch）',
    })
    const r = await installUpdatePackage()
    expect(r.error).toBe('更新包数字签名无效（HashMismatch）')
    expect(spawn).not.toHaveBeenCalled()
    expect(verifyUpdateSignature).toHaveBeenCalledWith(path.resolve(TARGET))
  })

  it('缺少 SHA256 校验和基准：拒绝安装（防模块态脱钩时静默放行）', async () => {
    vi.mocked(getDownloadedChecksum).mockReturnValue('')
    const r = await installUpdatePackage()
    expect(r.error).toContain('完整性基准')
    expect(spawn).not.toHaveBeenCalled()
    expect(verifyUpdateSignature).not.toHaveBeenCalled()
  })

  it('文件哈希与下载时基准不一致：拒绝安装并清理（未配置指纹时的完整性防线）', async () => {
    vi.mocked(hashFile).mockResolvedValue('a'.repeat(64))
    const r = await installUpdatePackage()
    expect(r.error).toContain('校验和不一致')
    expect(spawn).not.toHaveBeenCalled()
    await expect(fsp.access(TARGET)).rejects.toThrow()
  })

  it('文件哈希读取失败：拒绝安装', async () => {
    vi.mocked(hashFile).mockRejectedValue(new Error('EIO'))
    const r = await installUpdatePackage()
    expect(r.error).toContain('无法读取')
    expect(spawn).not.toHaveBeenCalled()
  })
})

describe('installUpdatePackage（成功链与退出时序）', () => {
  it('成功：直接传参拉起新实例（不经 shell）+ --wait-for-pid + 延迟退出', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child)
    const r = await installUpdatePackage()
    expect(r).toEqual({ ok: true })
    expect(spawn).toHaveBeenCalledWith(
      path.resolve(TARGET),
      [`--wait-for-pid=${process.pid}`],
      { windowsHide: true, detached: true, stdio: 'ignore' },
    )
    expect(child.unref).toHaveBeenCalled()
    // 500ms 前不得退出（给 spawn 完成进程创建留时间）
    await vi.advanceTimersByTimeAsync(499)
    expect(app.quit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(app.quit).toHaveBeenCalledTimes(1)
  })

  it('spawn 同步抛错：返回失败文案且不安排退出', async () => {
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error('CreateProcess failed')
    })
    const r = await installUpdatePackage()
    expect(r.error).toContain('启动更新程序失败')
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('子进程异步 error 事件：仅记日志，结果仍为成功（已 detached 交由系统）', async () => {
    vi.useFakeTimers() // 吞掉 500ms 退出定时器，避免泄漏到后续用例
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child)
    const r = await installUpdatePackage()
    expect(r).toEqual({ ok: true })
    // error 事件在监听注册后到达：被 once 处理器消费，不得演变为未捕获异常
    child.emit('error', new Error('spawn later failed'))
    expect(app.quit).not.toHaveBeenCalled()
  })
})
