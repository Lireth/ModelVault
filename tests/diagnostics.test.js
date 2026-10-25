import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { dialog } from 'electron'
import { unzipSync } from 'fflate'
import { fakeUserData } from './setup'

/**
 * 诊断包导出（FN-05）：
 * - 报告只读聚合（版本/库/缓存/元数据概要），不触碰用户数据；
 * - zip 内含 diagnostics.json 与最近日志；
 * - 取消保存不产生文件。
 */

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => fakeUserData),
    isPackaged: true,
    getName: vi.fn(() => 'ModelVault'),
    getVersion: vi.fn(() => '0.4.0'),
    getLocale: vi.fn(() => 'zh-CN'),
  },
  dialog: { showSaveDialog: vi.fn() },
}))

import {
  DIAGNOSTICS_JSON_ENTRY,
  exportDiagnostics,
  summarizeMetadata,
} from '../src/main/services/diagnostics'
import { setDataRoot } from '../src/main/services/store-paths'

const roots = []
const outputs = []
let root

beforeEach(async () => {
  vi.mocked(dialog.showSaveDialog).mockReset()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-diag-'))
  roots.push(root)
  setDataRoot(root)
  await fs.mkdir(path.join(root, '.modelvault', 'covers'), { recursive: true })
  await fs.mkdir(path.join(root, '.modelvault', 'thumbs'), { recursive: true })
  await fs.mkdir(path.join(root, '.modelvault', 'civcache'), {
    recursive: true,
  })
  await fs.writeFile(path.join(root, '.modelvault', 'covers', 'a.jpg'), 'cover')
  await fs.writeFile(
    path.join(root, '.modelvault', 'thumbs', 'a-1.jpg'),
    'thumb',
  )
  await fs.writeFile(path.join(root, '.modelvault', 'civcache', 'b.jpg'), 'civ')

  const logDir = path.join(fakeUserData, 'logs')
  await fs.mkdir(logDir, { recursive: true })
  await fs.writeFile(
    path.join(logDir, 'modelvault-2026-10-23.log'),
    '[2026-10-23 10:00:00] [INFO] 诊断测试日志\n'.repeat(20),
  )
})

afterAll(async () => {
  for (const dir of roots)
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  for (const file of outputs) await fs.rm(file, { force: true }).catch(() => {})
})

describe('summarizeMetadata', () => {
  it('按字段统计有封面/标签/参数/备注/哈希的模型数', () => {
    const summary = summarizeMetadata({
      a: {
        covers: ['x'],
        tags: ['t'],
        params: { steps: 20 },
        note: 'n',
        hash: 'h',
      },
      b: { covers: [], tags: [], params: null, note: '  ', hash: '' },
      c: null,
    })
    expect(summary).toEqual({
      models: 2,
      withCovers: 1,
      withTags: 1,
      withParams: 1,
      withNote: 1,
      withHash: 1,
    })
  })
})

describe('exportDiagnostics', () => {
  it('生成含报告与最近日志的 zip，且只读统计缓存体积', async () => {
    const target = path.join(os.tmpdir(), `modelvault-diag-${Date.now()}.zip`)
    outputs.push(target)
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({
      canceled: false,
      filePath: target,
    })

    const res = await exportDiagnostics(null)
    expect(res.ok).toBe(true)
    expect(res.logs).toBeGreaterThanOrEqual(1)

    const bytes = await fs.readFile(target)
    const entries = unzipSync(new Uint8Array(bytes))
    expect(entries[DIAGNOSTICS_JSON_ENTRY]).toBeTruthy()
    expect(Object.keys(entries).some((name) => name.startsWith('logs/'))).toBe(
      true,
    )

    const report = JSON.parse(
      new TextDecoder().decode(entries[DIAGNOSTICS_JSON_ENTRY]),
    )
    expect(report.format).toBe('modelvault-diagnostics')
    expect(report.version).toBe(1)
    expect(report.app.version).toBe('0.4.0')
    expect(report.activeLibrary).toBe(root)
    expect(report.libraries.some((lib) => lib.root === root)).toBe(true)
    expect(report.caches.covers.files).toBe(1)
    expect(report.caches.thumbs.files).toBe(1)
    expect(report.caches.civcache.files).toBe(1)
    expect(report.metadata.models).toBe(0)
  })

  it('用户取消保存时不写出文件', async () => {
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: true })
    const res = await exportDiagnostics(null)
    expect(res).toEqual({ canceled: true })
  })
})
