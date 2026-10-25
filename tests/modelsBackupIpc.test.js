import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import { fakeUserData } from './setup'
import {
  getRegisteredHandler,
  makeEvent,
  makeWindow,
} from './helpers/modelsIpc'

/**
 * 备份域 IPC handler 测试（O7 补强：此前 handler 层近零覆盖，仅服务层被测）：
 * - exportBackup / importBackup 结果透传（成功/取消/错误三态）
 * - importBackup 恢复目标为当前激活库时的内存善后链（B1）：
 *   等待缩略图静止 → 重载内存元数据与库设置 → 失效装饰缓存 →
 *   清理延迟任务（磁盘 store.json 已被整目录替换，不重载会被旧内存回滚）
 * - 恢复目标非当前库（或失败/取消）时不做任何善后
 * 说明：services/backup 主链路由 backupService.test.js 覆盖，此处全 mock。
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  BrowserWindow: Object.assign(vi.fn(), {
    fromWebContents: vi.fn(),
    getAllWindows: vi.fn(() => []),
  }),
  clipboard: { read: vi.fn(), writeText: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  shell: { trashItem: vi.fn(), showItemInFolder: vi.fn() },
  net: { fetch: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
}))

vi.mock('../src/main/services/backup.js', () => ({
  exportBackup: vi.fn(),
  importBackup: vi.fn(),
}))

// 善后链可观测：重载函数以 spy 覆盖（getCurrentRoot/setDataRoot 保留真实实现）
vi.mock('../src/main/services/store.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    reloadCurrentRootData: vi.fn(async () => {}),
    reloadLibrarySettings: vi.fn(async () => {}),
  }
})

vi.mock('../src/main/ipc/models/model-state.js', () => ({
  resetDecorateCache: vi.fn(),
  awaitThumbDrain: vi.fn(async () => {}),
}))

vi.mock('../src/main/ipc/models/decorate.js', () => ({
  clearDeferredOwners: vi.fn(),
  resolveCoverSafe: vi.fn((p) => p || ''),
}))

vi.mock('../src/main/services/thumbs.js', () => ({
  clearDeferredJobs: vi.fn(),
}))

import { registerBackupHandlers } from '../src/main/ipc/models/backup'
import { exportBackup, importBackup } from '../src/main/services/backup'
import {
  reloadCurrentRootData,
  reloadLibrarySettings,
  setDataRoot,
} from '../src/main/services/store'
import {
  resetDecorateCache,
  awaitThumbDrain,
} from '../src/main/ipc/models/model-state'
import { clearDeferredOwners } from '../src/main/ipc/models/decorate'
import { clearDeferredJobs } from '../src/main/services/thumbs'

const roots = []
let root

/** 善后链六个动作均未被调用 */
function expectNoCleanup() {
  expect(awaitThumbDrain).not.toHaveBeenCalled()
  expect(reloadCurrentRootData).not.toHaveBeenCalled()
  expect(reloadLibrarySettings).not.toHaveBeenCalled()
  expect(resetDecorateCache).not.toHaveBeenCalled()
  expect(clearDeferredOwners).not.toHaveBeenCalled()
  expect(clearDeferredJobs).not.toHaveBeenCalled()
}

beforeEach(() => {
  vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(makeWindow())
  exportBackup.mockReset()
  importBackup.mockReset()
  vi.mocked(awaitThumbDrain).mockClear()
  vi.mocked(reloadCurrentRootData).mockClear()
  vi.mocked(reloadLibrarySettings).mockClear()
  vi.mocked(resetDecorateCache).mockClear()
  vi.mocked(clearDeferredOwners).mockClear()
  vi.mocked(clearDeferredJobs).mockClear()
  registerBackupHandlers()
})

afterAll(async () => {
  for (const dir of roots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('models:exportBackup', () => {
  it('成功结果透传（来源窗口经原生对话框链路传入服务层）', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-bak-ipc-'))
    roots.push(root)
    setDataRoot(root)
    const res = {
      path: 'D:\\bak.zip',
      sizeBytes: 10,
      library: root,
      models: 2,
      covers: 3,
    }
    exportBackup.mockResolvedValue(res)
    const out = await getRegisteredHandler('models:exportBackup')(makeEvent())
    expect(out).toEqual(res)
    expect(exportBackup).toHaveBeenCalledTimes(1)
    expect(exportBackup.mock.calls[0][0]).toBeTruthy()
  })

  it('取消与错误结果均透传（不抛异常）', async () => {
    exportBackup.mockResolvedValue({ canceled: true })
    expect(
      await getRegisteredHandler('models:exportBackup')(makeEvent()),
    ).toEqual({ canceled: true })
    exportBackup.mockResolvedValue({ error: '磁盘已满' })
    expect(
      await getRegisteredHandler('models:exportBackup')(makeEvent()),
    ).toEqual({ error: '磁盘已满' })
  })
})

describe('models:importBackup', () => {
  it('恢复目标为当前激活库时执行内存善后链（B1）', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-bak-ipc-'))
    roots.push(root)
    setDataRoot(root)
    // 恢复目标与激活库为同一路径的不同大小写写法：Windows 路径不区分大小写
    importBackup.mockResolvedValue({
      settingsRestored: true,
      libraryRestored: { root: root.toUpperCase() },
    })
    const out = await getRegisteredHandler('models:importBackup')(makeEvent())
    expect(out.settingsRestored).toBe(true)
    expect(awaitThumbDrain).toHaveBeenCalledTimes(1)
    expect(reloadCurrentRootData).toHaveBeenCalledTimes(1)
    expect(reloadLibrarySettings).toHaveBeenCalledWith(root.toUpperCase())
    expect(resetDecorateCache).toHaveBeenCalledWith(root.toUpperCase())
    expect(clearDeferredOwners).toHaveBeenCalledTimes(1)
    expect(clearDeferredJobs).toHaveBeenCalledTimes(1)
  })

  it('恢复目标非当前库时不做善后', async () => {
    setDataRoot(
      await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-bak-ipc-a-')),
    )
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-bak-ipc-b-'))
    roots.push(root)
    importBackup.mockResolvedValue({
      settingsRestored: true,
      libraryRestored: { root },
    })
    const out = await getRegisteredHandler('models:importBackup')(makeEvent())
    expect(out.settingsRestored).toBe(true)
    expectNoCleanup()
  })

  it('取消与错误结果透传且不做善后（libraryRestored 缺失）', async () => {
    importBackup.mockResolvedValue({ canceled: true })
    expect(
      await getRegisteredHandler('models:importBackup')(makeEvent()),
    ).toEqual({ canceled: true })
    importBackup.mockResolvedValue({ error: 'zip 损坏' })
    expect(
      await getRegisteredHandler('models:importBackup')(makeEvent()),
    ).toEqual({ error: 'zip 损坏' })
    expectNoCleanup()
  })
})
