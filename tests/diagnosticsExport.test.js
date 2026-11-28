import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { exportDiagnostics } from '../src/main/services/diagnostics'
import {
  flushSettingsSave,
  loadData,
  loadSettings,
  setDataRoot,
} from '../src/main/services/store'
import logger from '../src/main/logger'

/**
 * 诊断包导出测试（#169）：
 * 此前导出对已存在目标先 rm 再 rename——rename 抛错（EPERM 目标被占用）时
 * 旧诊断包已删、新包未落位。修复后与 backup-export/auto-backup 的 zip 落点
 * 同一标准（tmp + renameReplacing 原子覆盖）：成功路径替换目标，失败路径
 * 旧包原样保留、仅清理本次 tmp。
 */

const { dialogMock, userData } = vi.hoisted(() => ({
  dialogMock: { showSaveDialog: vi.fn() },
  // 临时用户数据目录（logger/getSettings 的落点；由本文件清理）
  userData: `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/modelvault-diag-ud-${process.pid}-${Date.now()}`,
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => userData),
    getVersion: vi.fn(() => '0.8.0-test'),
    getName: vi.fn(() => 'ModelVault'),
    getLocale: vi.fn(() => 'zh-CN'),
    isPackaged: true,
  },
  dialog: dialogMock,
}))

let root

/** 本文件产生的临时目录（测试结束后统一清理） */
const tmpDirs = [userData]

function mkTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

beforeEach(async () => {
  root = mkTmp('modelvault-diag-lib-')
  setDataRoot(root)
  await loadSettings()
  await loadData()
})

afterEach(async () => {
  // 设置/元数据防抖链静止后再切根：迟到的落盘不写进后续用例的新根
  await Promise.allSettled([flushSettingsSave()])
  setDataRoot(null)
  await loadData()
})

afterAll(async () => {
  // 导出链路写日志会懒创建 logs 目录并打开写入流，Windows 上句柄未释放
  // 会导致 rmSync 报 ENOTEMPTY
  logger.stream?.end()
  logger.stream = null
  for (const dir of tmpDirs) {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        if (attempt >= 10) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
  }
})

describe('exportDiagnostics（诊断包导出，#169）', () => {
  it('目标已存在时经 renameReplacing 原子替换为完整新包，无 tmp 残留', async () => {
    const target = path.join(mkTmp('modelvault-diag-out-'), 'diag.zip')
    await fsp.writeFile(target, 'OLD-PACK')
    dialogMock.showSaveDialog.mockReset()
    dialogMock.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: target,
    })

    const res = await exportDiagnostics(null)

    expect(res.ok).toBe(true)
    expect(res.path).toBe(target)
    // 目标已是完整新 zip（PK 魔数），不再是旧内容
    const content = await fsp.readFile(target)
    expect(content.subarray(0, 2).toString('utf-8')).toBe('PK')
    expect(res.sizeBytes).toBe(content.length)
    // 原子替换后无 .tmp 残留
    expect(
      fs.readdirSync(path.dirname(target)).some((n) => n.includes('.tmp-')),
    ).toBe(false)
  })

  it('rename 持续失败（目标被占用）时既有诊断包不被先删', async () => {
    const target = path.join(mkTmp('modelvault-diag-out-'), 'diag.zip')
    await fsp.writeFile(target, 'OLD-PACK-VALUE')
    dialogMock.showSaveDialog.mockReset()
    dialogMock.showSaveDialog.mockResolvedValue({
      canceled: false,
      filePath: target,
    })
    // rename 恒 EPERM：模拟杀毒/索引器持续占用目标
    const eperm = new Error('EPERM: operation not permitted')
    eperm.code = 'EPERM'
    const spy = vi.spyOn(fsp, 'rename').mockImplementation(async () => {
      throw eperm
    })

    try {
      const res = await exportDiagnostics(null)

      expect(res.error).toContain('诊断包导出失败')
      // 旧包原样保留——未修复时 rm(target) 已先行删除它
      expect(await fsp.readFile(target, 'utf8')).toBe('OLD-PACK-VALUE')
      // 本次 tmp 已清理，不在输出目录留半成品
      expect(
        fs.readdirSync(path.dirname(target)).some((n) => n.includes('.tmp-')),
      ).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('取消保存对话框时不产出任何文件', async () => {
    const outDir = mkTmp('modelvault-diag-out-')
    dialogMock.showSaveDialog.mockReset()
    dialogMock.showSaveDialog.mockResolvedValue({ canceled: true })

    const res = await exportDiagnostics(null)

    expect(res).toEqual({ canceled: true })
    expect(fs.readdirSync(outDir)).toEqual([])
  })
})
