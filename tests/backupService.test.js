import { describe, it, expect, vi, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'
import { strToU8, zipSync, unzipSync } from 'fflate'
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  exportBackup,
  importBackup,
  parseBackupManifest,
  safeCoverName,
  unzipBackupAsync,
  zipBackupAsync
} from '../src/main/services/backup'
import { DATA_DIR, setDataRoot } from '../src/main/services/store'
import logger from '../src/main/logger'

/**
 * 备份服务测试（FEAT-3）：
 * - 纯函数：manifest 校验（格式/版本/损坏）与封面条目名安全（路径穿越防御）；
 * - exportBackup：设置 + 当前库 store.json/covers 打包、thumbs 不纳入、
 *   无关联数据时仅备份设置、用户取消；
 * - importBackup：设置与库数据恢复到目标文件夹、覆盖确认与 .bak 留存、
 *   取消覆盖时数据不动、危险条目跳过、无效备份拒绝。
 *
 * electron 在本文件内替换为带 dialog 桩的 mock（全局 setup.js 的 mock 无 dialog）。
 */

const { dialogMock, userData } = vi.hoisted(() => ({
  dialogMock: {
    showSaveDialog: vi.fn(),
    showOpenDialog: vi.fn(),
    showMessageBox: vi.fn()
  },
  // 临时用户数据目录（绝对路径；由 atomicWriteFile 按需创建）
  userData: `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/modelvault-backup-ud-${process.pid}-${Date.now()}`
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => userData),
    getVersion: vi.fn(() => '0.1.0'),
    isPackaged: true
  },
  dialog: dialogMock
}))

/** 本文件产生的临时目录（测试结束后统一清理） */
const tmpDirs = [userData]

function mkTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

/** 构造带关联存储的模型库（store.json + 2 张封面 + thumbs 缓存） */
function makeLibrary() {
  const root = mkTmp('modelvault-lib-')
  const dataDir = path.join(root, '.modelvault')
  fs.mkdirSync(path.join(dataDir, 'covers'), { recursive: true })
  fs.mkdirSync(path.join(dataDir, 'thumbs'), { recursive: true })
  fs.writeFileSync(
    path.join(dataDir, 'store.json'),
    JSON.stringify({
      version: 1,
      models: {
        'a.safetensors': { cover: '.modelvault/covers/c1.png' },
        'b.safetensors': {}
      }
    })
  )
  fs.writeFileSync(path.join(dataDir, 'covers', 'c1.png'), 'img1')
  fs.writeFileSync(path.join(dataDir, 'covers', 'c2.png'), 'img2')
  fs.writeFileSync(path.join(dataDir, 'thumbs', 't1.jpg'), 'thumb')
  return root
}

/** 构造备份 zip 文件 */
function makeBackupZip(filePath, { withLibrary = true, evilEntry = false } = {}) {
  const files = {
    'manifest.json': strToU8(
      JSON.stringify({
        app: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        createdAt: new Date().toISOString(),
        settings: true,
        library: withLibrary ? { root: 'D:\\old-lib', models: 1, covers: 1 } : undefined
      })
    ),
    'settings.json': strToU8(JSON.stringify({ theme: 'light', sortBy: 'size' }))
  }
  if (withLibrary) {
    files['library/store.json'] = strToU8(
      JSON.stringify({ version: 1, models: { 'x.safetensors': {} } })
    )
    files['library/covers/ok.png'] = strToU8('coverdata')
    if (evilEntry) files['library/covers/../evil.png'] = strToU8('evil')
  }
  fs.writeFileSync(filePath, zipSync(files))
  return filePath
}

/** 读取 zip 为 { 条目名: 解码文本 } */
function readZip(filePath) {
  const unzipped = unzipSync(new Uint8Array(fs.readFileSync(filePath)))
  const decoder = new TextDecoder()
  const out = {}
  for (const [name, data] of Object.entries(unzipped)) {
    out[name] = decoder.decode(data)
  }
  return out
}

afterAll(async () => {
  // exportBackup/importBackup 内部写日志会懒创建 logs 目录并打开写入流，
  // 不先关闭流，Windows 上句柄未释放会导致 rmSync 报 ENOTEMPTY
  logger.stream?.end()
  logger.stream = null
  for (const dir of tmpDirs) {
    // Windows 上句柄完全释放有延迟，失败时短暂重试
    for (let attempt = 0; ; attempt++) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
        break
      } catch (err) {
        if (attempt >= 9) throw err
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
  }
})

describe('备份异步压缩/解压（A-01）', () => {
  it('大体积高熵数据压缩期间事件循环保持响应（分片让出而非同步阻塞）', async () => {
    // 12MB 随机数据不可压缩，纯 JS deflate(level 6) 耗时数十毫秒量级；
    // 同步实现会在函数调用栈内一次跑完（1ms 探测时已完成），
    // 异步分片实现则在压缩进行中仍能响应定时器
    const files = {
      'library/covers/big.png': new Uint8Array(crypto.randomBytes(12 * 1024 * 1024))
    }

    let done = false
    const pending = zipBackupAsync(files).then((zipped) => {
      done = true
      return zipped
    })
    await new Promise((resolve) => setTimeout(resolve, 1))
    expect(done).toBe(false)

    const zipped = await pending
    expect(zipped).toBeInstanceOf(Uint8Array)
    expect(zipped.byteLength).toBeGreaterThan(0)
  })

  it('异步解压与同步实现内容一致（往返正确）', async () => {
    const files = {
      'a.txt': strToU8('hello-备份'),
      'b.bin': new Uint8Array([1, 2, 3, 4])
    }
    const unzipped = await unzipBackupAsync(zipSync(files))
    expect(new TextDecoder().decode(unzipped['a.txt'])).toBe('hello-备份')
    expect(Array.from(unzipped['b.bin'])).toEqual([1, 2, 3, 4])
  })

  it('压缩入参无效时 Promise reject（不吞错）', async () => {
    await expect(zipBackupAsync(null)).rejects.toThrow()
  })
})

describe('parseBackupManifest', () => {
  it('接受当前版本的有效清单', () => {
    const res = parseBackupManifest(
      strToU8(JSON.stringify({ app: BACKUP_FORMAT, version: BACKUP_VERSION }))
    )
    expect(res.ok).toBe(true)
    expect(res.manifest.app).toBe(BACKUP_FORMAT)
  })

  it('拒绝非本应用格式与缺失/损坏内容', () => {
    expect(parseBackupManifest(strToU8(JSON.stringify({ app: 'other' }))).ok).toBe(false)
    expect(parseBackupManifest(null).error).toContain('manifest.json')
    expect(parseBackupManifest(strToU8('not-json')).ok).toBe(false)
  })

  it('拒绝高于当前版本的备份（提示升级应用）', () => {
    const res = parseBackupManifest(
      strToU8(JSON.stringify({ app: BACKUP_FORMAT, version: BACKUP_VERSION + 1 }))
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain('版本过新')
  })
})

describe('safeCoverName', () => {
  it('接受普通文件名', () => {
    expect(safeCoverName('library/covers/1728-cover.png')).toBe('1728-cover.png')
  })

  it('拒绝路径穿越、子目录、驱动器前缀与非 covers 条目', () => {
    expect(safeCoverName('library/covers/../evil.png')).toBe('')
    expect(safeCoverName('library/covers/sub/x.png')).toBe('')
    expect(safeCoverName('library/covers/C:x.png')).toBe('')
    expect(safeCoverName('library/covers/..')).toBe('')
    expect(safeCoverName('settings.json')).toBe('')
  })
})

describe('exportBackup', () => {
  it('打包设置与当前库的 store.json/covers，thumbs 不纳入', async () => {
    const root = makeLibrary()
    setDataRoot(root)
    const outZip = path.join(mkTmp('modelvault-out-'), 'backup.zip')
    dialogMock.showSaveDialog.mockResolvedValue({ canceled: false, filePath: outZip })

    const res = await exportBackup(null)

    expect(res.error).toBeUndefined()
    expect(res.library).toBe(true)
    expect(res.models).toBe(2)
    expect(res.covers).toBe(2)
    const zip = readZip(outZip)
    const manifest = JSON.parse(zip['manifest.json'])
    expect(manifest.app).toBe(BACKUP_FORMAT)
    expect(manifest.version).toBe(BACKUP_VERSION)
    expect(manifest.library.models).toBe(2)
    expect(manifest.library.covers).toBe(2)
    expect(JSON.parse(zip['settings.json'])).toBeTruthy()
    const store = JSON.parse(zip['library/store.json'])
    expect(Object.keys(store.models)).toHaveLength(2)
    expect(zip['library/covers/c1.png']).toBe('img1')
    expect(zip['library/covers/c2.png']).toBe('img2')
    // thumbs 为可再生缓存，不纳入备份
    expect(Object.keys(zip).some((k) => k.includes('thumbs'))).toBe(false)
  })

  it('无关联数据时仅备份应用设置', async () => {
    const root = mkTmp('modelvault-empty-lib-')
    setDataRoot(root)
    const outZip = path.join(mkTmp('modelvault-out-'), 'backup.zip')
    dialogMock.showSaveDialog.mockResolvedValue({ canceled: false, filePath: outZip })

    const res = await exportBackup(null)

    expect(res.library).toBe(false)
    expect(res.models).toBe(0)
    const zip = readZip(outZip)
    expect(zip['library/store.json']).toBeUndefined()
    expect(JSON.parse(zip['manifest.json']).library).toBeUndefined()
    expect(zip['settings.json']).toBeTruthy()
  })

  it('用户取消保存对话框时返回 canceled', async () => {
    setDataRoot(makeLibrary())
    dialogMock.showSaveDialog.mockResolvedValue({ canceled: true })
    const res = await exportBackup(null)
    expect(res.canceled).toBe(true)
  })
})

describe('importBackup', () => {
  it('恢复设置与库数据到目标文件夹', async () => {
    const zipPath = makeBackupZip(path.join(mkTmp('modelvault-out-'), 'backup.zip'))
    const target = mkTmp('modelvault-target-')
    dialogMock.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [zipPath] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [target] })

    const res = await importBackup(null)

    expect(res.error).toBeUndefined()
    expect(res.settingsRestored).toBe(true)
    expect(res.libraryRestored.root).toBe(target)
    expect(res.libraryRestored.models).toBe(1)
    expect(res.libraryRestored.covers).toBe(1)
    // 库数据落盘
    const store = JSON.parse(
      fs.readFileSync(path.join(target, '.modelvault', 'store.json'), 'utf8')
    )
    expect(store.models['x.safetensors']).toBeDefined()
    expect(
      fs.readFileSync(path.join(target, '.modelvault', 'covers', 'ok.png'), 'utf8')
    ).toBe('coverdata')
    // 设置写盘（userData/settings.json）
    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'))
    expect(saved.theme).toBe('light')
  })

  it('目标已有 .modelvault 时确认后覆盖并留存 .bak', async () => {
    const zipPath = makeBackupZip(path.join(mkTmp('modelvault-out-'), 'backup.zip'))
    const target = mkTmp('modelvault-target-')
    const dataDir = path.join(target, '.modelvault')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'store.json'), 'OLD')
    dialogMock.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [zipPath] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [target] })
    dialogMock.showMessageBox.mockResolvedValue({ response: 1 })

    const res = await importBackup(null)

    expect(res.libraryRestored.root).toBe(target)
    const store = JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8'))
    expect(store.models['x.safetensors']).toBeDefined()
    const baks = fs.readdirSync(target).filter((n) => n.startsWith('.modelvault.bak-'))
    expect(baks).toHaveLength(1)
    expect(fs.readFileSync(path.join(target, baks[0], 'store.json'), 'utf8')).toBe('OLD')
  })

  it('覆盖确认取消时保留现有数据（设置已恢复、库数据未动）', async () => {
    const zipPath = makeBackupZip(path.join(mkTmp('modelvault-out-'), 'backup.zip'))
    const target = mkTmp('modelvault-target-')
    const dataDir = path.join(target, '.modelvault')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'store.json'), 'OLD')
    dialogMock.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [zipPath] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [target] })
    dialogMock.showMessageBox.mockResolvedValue({ response: 0 })

    const res = await importBackup(null)

    expect(res.error).toContain('已取消覆盖恢复')
    expect(res.settingsRestored).toBe(true)
    expect(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8')).toBe('OLD')
  })

  it('跳过路径穿越的封面条目（恢复后目标目录外无文件写入）', async () => {
    const zipPath = makeBackupZip(path.join(mkTmp('modelvault-out-'), 'backup.zip'), {
      evilEntry: true
    })
    const target = mkTmp('modelvault-target-')
    dialogMock.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [zipPath] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [target] })

    const res = await importBackup(null)

    expect(res.libraryRestored.covers).toBe(1)
    expect(res.libraryRestored.skipped).toBe(1)
    expect(fs.existsSync(path.join(target, 'evil.png'))).toBe(false)
    expect(fs.existsSync(path.join(path.dirname(target), 'evil.png'))).toBe(false)
    // 恢复用的临时目录已清理
    expect(fs.readdirSync(target).some((n) => n.includes('.restore-'))).toBe(false)
  })

  it('拒绝无效备份：无 manifest 与 manifest 格式不符分别给出明确原因', async () => {
    // 场景一：zip 内没有 manifest.json
    const noManifest = path.join(mkTmp('modelvault-out-'), 'no-manifest.zip')
    fs.writeFileSync(noManifest, zipSync({ 'readme.txt': strToU8('hi') }))
    dialogMock.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [noManifest]
    })
    const res1 = await importBackup(null)
    expect(res1.error).toContain('备份文件缺少 manifest.json')

    // 场景二：manifest 存在但格式标识不符
    const wrongFormat = path.join(mkTmp('modelvault-out-'), 'wrong-format.zip')
    fs.writeFileSync(
      wrongFormat,
      zipSync({ 'manifest.json': strToU8(JSON.stringify({ app: 'other-app', version: 1 })) })
    )
    dialogMock.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [wrongFormat]
    })
    const res2 = await importBackup(null)
    expect(res2.error).toContain('不是有效的 ModelVault 备份文件')
  })

  it('取消选择备份文件时返回 canceled', async () => {
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: true })
    const res = await importBackup(null)
    expect(res.canceled).toBe(true)
  })

  it('仅含设置的备份：不弹出目标文件夹选择', async () => {
    const zipPath = makeBackupZip(path.join(mkTmp('modelvault-out-'), 'backup.zip'), {
      withLibrary: false
    })
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [zipPath] })

    const res = await importBackup(null)

    expect(res.error).toBeUndefined()
    expect(res.settingsRestored).toBe(true)
    expect(res.libraryRestored).toBeUndefined()
    // 仅调用一次对话框（选文件）
    expect(dialogMock.showOpenDialog).toHaveBeenCalledTimes(1)
  })
})

describe('importBackup 残留治理（OPT-18）', () => {
  /** 注入「临时目录上位」rename 故障（回滚与其他 rename 放行） */
  function failFinalRename() {
    const originalRename = fsp.rename.bind(fsp)
    const spy = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      // 仅拦截 .restore-* → .modelvault 的上位 rename；
      // 回滚（.bak-* → .modelvault）与 settings 等写入不受影响
      if (String(from).includes('.restore-') && String(to).endsWith(`${path.sep}${DATA_DIR}`)) {
        throw new Error('磁盘错误')
      }
      return originalRename(from, to)
    })
    return spy
  }

  it('恢复失败时清理本次临时目录，不在模型目录留垃圾', async () => {
    const zipPath = makeBackupZip(path.join(mkTmp('modelvault-out-'), 'backup.zip'))
    const target = mkTmp('modelvault-target-')
    dialogMock.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [zipPath] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [target] })
    const spy = failFinalRename()

    const res = await importBackup(null)
    spy.mockRestore()

    expect(res.error).toContain('库数据恢复失败')
    // 无 .restore-* 残留，也未留下半成品 .modelvault
    const left = fs.readdirSync(target)
    expect(left.some((n) => n.includes('.restore-'))).toBe(false)
    expect(left).toEqual([])
  })

  it('交换上位失败时回滚既有数据并清理临时目录', async () => {
    const zipPath = makeBackupZip(path.join(mkTmp('modelvault-out-'), 'backup.zip'))
    const target = mkTmp('modelvault-target-')
    const dataDir = path.join(target, DATA_DIR)
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'store.json'), 'OLD')
    dialogMock.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [zipPath] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [target] })
    dialogMock.showMessageBox.mockResolvedValue({ response: 1 })
    const spy = failFinalRename()

    const res = await importBackup(null)
    spy.mockRestore()

    expect(res.error).toContain('库数据恢复失败')
    // 既有数据经回滚完好无损
    expect(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8')).toBe('OLD')
    // 无 .bak 残留（已随回滚改回）、无 .restore 残留
    const left = fs.readdirSync(target)
    expect(left.some((n) => n.startsWith(`${DATA_DIR}.bak-`))).toBe(false)
    expect(left.some((n) => n.includes('.restore-'))).toBe(false)
  })

  it('覆盖恢复成功后仅保留最新一份 .bak，更早的自动清理', async () => {
    const target = mkTmp('modelvault-target-')
    const dataDir = path.join(target, DATA_DIR)
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'store.json'), 'OLD-1')
    dialogMock.showMessageBox.mockResolvedValue({ response: 1 })
    // 第一次覆盖恢复
    const zip1 = makeBackupZip(path.join(mkTmp('modelvault-out-'), 'b1.zip'))
    dialogMock.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [zip1] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [target] })
    await importBackup(null)
    // 间隔确保两次恢复时间戳不同（.bak 目录名不冲突）
    await new Promise((resolve) => setTimeout(resolve, 5))
    // 第一次恢复后的数据被用户改动，作为第二次恢复的「旧数据」
    fs.writeFileSync(path.join(dataDir, 'store.json'), 'OLD-2')
    const zip2 = makeBackupZip(path.join(mkTmp('modelvault-out-'), 'b2.zip'))
    dialogMock.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [zip2] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [target] })

    const res = await importBackup(null)

    expect(res.libraryRestored.root).toBe(target)
    const baks = fs.readdirSync(target).filter((n) => n.startsWith(`${DATA_DIR}.bak-`))
    expect(baks).toHaveLength(1)
    // 留存的是第二次恢复生成的 .bak（内容为改动后的 OLD-2）
    expect(fs.readFileSync(path.join(target, baks[0], 'store.json'), 'utf8')).toBe('OLD-2')
    // 当前生效数据为恢复内容
    const store = JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8'))
    expect(store.models['x.safetensors']).toBeDefined()
  })

  it('恢复成功时清理历史残留的 .restore 临时目录', async () => {
    const target = mkTmp('modelvault-target-')
    // 模拟上次异常中断遗留的临时目录
    const stale = path.join(target, `${DATA_DIR}.restore-111`)
    fs.mkdirSync(path.join(stale, 'covers'), { recursive: true })
    fs.writeFileSync(path.join(stale, 'store.json'), '残留')
    const zipPath = makeBackupZip(path.join(mkTmp('modelvault-out-'), 'backup.zip'))
    dialogMock.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [zipPath] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [target] })

    const res = await importBackup(null)

    expect(res.libraryRestored.root).toBe(target)
    const left = fs.readdirSync(target)
    expect(left.some((n) => n.startsWith(`${DATA_DIR}.restore-`))).toBe(false)
    expect(left).toContain(DATA_DIR)
  })
})
