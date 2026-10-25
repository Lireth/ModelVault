import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fakeUserData } from './setup'

/**
 * auto-backup.js 服务层单元测试（OPT-07 自动定期元数据备份）：
 * - 到期门槛：设置关闭 / 无激活库 / 24h 内已备份 / 库无标注 → 静默跳过
 * - 备份产出：metadata 模式 zip 写入 .modelvault/backups/auto-<stamp>.zip
 * - 滚动保留：超出的最旧备份被清理（时间戳命名，字典序即时间序）
 * electron 最小桩；store 走真实临时目录；zip 写入为真实实现（fflate）。
 */

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => fakeUserData),
    isPackaged: true,
    getVersion: vi.fn(() => '0.5.0'),
  },
}))

import {
  resetAutoBackupForTests,
  runAutoBackupIfDue,
} from '../src/main/services/auto-backup'
import {
  flushStoreSave,
  loadData,
  loadSettings,
  setDataRoot,
  setModelMeta,
  updateSettings,
} from '../src/main/services/store'
import { getDataDir } from '../src/main/services/store-paths'

let root
const roots = []
const DAY_MS = 24 * 60 * 60 * 1000

/** 备份目录路径（当前根） */
function backupsDir() {
  return path.join(getDataDir(), 'backups')
}

/** 列出备份目录内的 auto-*.zip 文件名（升序） */
async function listAutoBackups() {
  try {
    return (await fs.readdir(backupsDir()))
      .filter((n) => n.startsWith('auto-') && n.endsWith('.zip'))
      .sort()
  } catch {
    return []
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  resetAutoBackupForTests()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-autobk-'))
  roots.push(root)
  setDataRoot(root)
  await loadData()
  // 重载库层设置并显式恢复默认开启：引导文件的 legacy 布局会把上一用例
  // 关闭的 autoBackup 经种子迁移带入新库（真实场景默认值语义正确，
  // 这里只需隔离用例间的内存/磁盘残留）
  await loadSettings()
  await updateSettings({ autoBackup: true })
})

afterEach(async () => {
  resetAutoBackupForTests()
  // 先静止元数据的防抖落盘链再切根：挂起的保存定时器若在根切换后触发，
  // 会把上一用例的数据写进下一用例的新根（正是 B-02 防的场景）
  await Promise.allSettled([flushStoreSave()])
  setDataRoot(null)
  for (const dir of roots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('runAutoBackupIfDue（到期判定与跳过）', () => {
  it('设置关闭时静默跳过（触发时刻读设置，关闭即时生效）', async () => {
    setModelMeta(path.join(root, 'a.safetensors'), { alias: 'a' })
    await updateSettings({ autoBackup: false })
    const res = await runAutoBackupIfDue()
    expect(res).toEqual({ skipped: 'disabled' })
    expect(await listAutoBackups()).toEqual([])
  })

  it('无激活库时跳过', async () => {
    setDataRoot(null)
    const res = await runAutoBackupIfDue()
    expect(res).toEqual({ skipped: 'no-root' })
  })

  it('库尚无标注时跳过（刚建库是正常状态，不产出空备份）', async () => {
    const res = await runAutoBackupIfDue()
    expect(res.skipped).toBe('empty')
    expect(await listAutoBackups()).toEqual([])
  })

  it('24h 内已备份过时跳过（recent）', async () => {
    setModelMeta(path.join(root, 'a.safetensors'), { alias: 'a' })
    const t0 = 1_700_000_000_000
    const first = await runAutoBackupIfDue(t0)
    expect(first.skipped).toBeUndefined()
    expect(first.models).toBe(1)
    // 同日再触发：静默跳过；跨天（+25h）后重新备份
    expect(await runAutoBackupIfDue(t0 + 60_000)).toMatchObject({
      skipped: 'recent',
    })
    const second = await runAutoBackupIfDue(t0 + 25 * 60 * 60 * 1000)
    expect(second.skipped).toBeUndefined()
    expect(await listAutoBackups()).toHaveLength(2)
  })
})

describe('备份产出与滚动保留', () => {
  it('备份写入 .modelvault/backups/auto-<stamp>.zip（metadata 模式，无封面）', async () => {
    setModelMeta(path.join(root, 'a.safetensors'), { alias: 'a' })
    setModelMeta(path.join(root, 'b.safetensors'), { rating: 5 })
    const now = 1_700_000_123_456
    const res = await runAutoBackupIfDue(now)
    expect(res.path).toBe(path.join(backupsDir(), `auto-${now}.zip`))
    expect(res.models).toBe(2)
    const stat = await fs.stat(res.path)
    expect(stat.size).toBeGreaterThan(0)
    // 不触碰封面目录（metadata 模式无封面，亦不应误建 covers）
  })

  it('滚动保留最近 5 份：超出的最旧备份被清理', async () => {
    setModelMeta(path.join(root, 'a.safetensors'), { alias: 'a' })
    const now = 1_700_000_000_000
    // 预置 5 份历史备份（每天一份）
    await fs.mkdir(backupsDir(), { recursive: true })
    for (let i = 5; i >= 1; i--) {
      await fs.writeFile(
        path.join(backupsDir(), `auto-${now - i * DAY_MS}.zip`),
        'old',
      )
    }
    const res = await runAutoBackupIfDue(now)
    expect(res.skipped).toBeUndefined()
    const names = await listAutoBackups()
    expect(names).toHaveLength(5)
    // 最旧（now-5d）被清理，保留 now-4d..now-1d 与本次 now
    expect(names[0]).toBe(`auto-${now - 4 * DAY_MS}.zip`)
    expect(names[names.length - 1]).toBe(`auto-${now}.zip`)
  })
})
