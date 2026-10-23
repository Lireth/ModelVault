import { describe, it, expect, vi, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'
import { strToU8, zipSync, unzipSync, Zip, ZipDeflate } from 'fflate'
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  PARTIAL_BACKUP_VERSION,
  exportBackup,
  importBackup,
  parseBackupManifest,
  safeCoverName,
  unzipBackupAsync,
  zipBackupAsync
} from '../src/main/services/backup'
import { DATA_DIR, getModelMeta, loadData, setDataRoot, setModelMeta } from '../src/main/services/store'
import { releaseMaintenance, tryAcquireMaintenance } from '../src/main/services/maintenance-lock'
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

/** 构造两个同名封面条目的备份 zip（fflate 同步 API 不能产出重复条目名） */
function makeDuplicateCoverZip(filePath) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const archive = new Zip((err, data, final) => {
      if (err) return reject(err)
      if (data) chunks.push(Buffer.from(data))
      if (final) {
        fs.writeFileSync(filePath, Buffer.concat(chunks))
        resolve(filePath)
      }
    })
    const addText = (name, text) => {
      const file = new ZipDeflate(name)
      archive.add(file)
      file.push(strToU8(text), true)
    }
    addText(
      'manifest.json',
      JSON.stringify({
        app: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        settings: true,
        library: { root: 'D:\\old-lib', models: 1, covers: 1 }
      })
    )
    addText('library/store.json', JSON.stringify({ version: 1, models: {} }))
    addText('library/covers/dup.png', 'one')
    addText('library/covers/dup.png', 'two')
    archive.end()
  })
}

/** 构造选择性/元数据备份 zip（FN-08） */
function makePartialZip(filePath, { mode = 'selected', models = {}, covers = {} } = {}) {
  const files = {
    'manifest.json': strToU8(
      JSON.stringify({
        app: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        createdAt: new Date().toISOString(),
        settings: true,
        mode,
        partial: true,
        library: { root: 'D:\\source', models: Object.keys(models).length, covers: Object.keys(covers).length }
      })
    ),
    'settings.json': strToU8(JSON.stringify({ theme: 'light' })),
    'library/store.json': strToU8(JSON.stringify({ version: 1, models }))
  }
  for (const [name, data] of Object.entries(covers)) {
    files[`library/covers/${name}`] = strToU8(data)
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
      strToU8(JSON.stringify({ app: BACKUP_FORMAT, version: PARTIAL_BACKUP_VERSION + 1 }))
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
    await loadData()
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

  it('selected 模式只打包选中模型的标注与引用封面（FN-08）', async () => {
    const root = makeLibrary()
    setDataRoot(root)
    await loadData()
    const outZip = path.join(mkTmp('modelvault-out-'), 'backup.zip')
    dialogMock.showSaveDialog.mockResolvedValue({ canceled: false, filePath: outZip })

    const res = await exportBackup(null, {
      mode: 'selected',
      ids: [path.join(root, 'a.safetensors')]
    })

    expect(res.error).toBeUndefined()
    expect(res.mode).toBe('selected')
    expect(res.partial).toBe(true)
    expect(res.models).toBe(1)
    expect(res.covers).toBe(1)
    const zip = readZip(outZip)
    const manifest = JSON.parse(zip['manifest.json'])
    expect(manifest.version).toBe(PARTIAL_BACKUP_VERSION)
    expect(manifest.partial).toBe(true)
    expect(manifest.library.models).toBe(1)
    expect(Object.keys(JSON.parse(zip['library/store.json']).models)).toEqual(['a.safetensors'])
    expect(zip['library/covers/c1.png']).toBe('img1')
    expect(zip['library/covers/c2.png']).toBeUndefined()
  })

  it('metadata 模式包含全库标注但不含封面（FN-08）', async () => {
    const root = makeLibrary()
    setDataRoot(root)
    await loadData()
    const outZip = path.join(mkTmp('modelvault-out-'), 'backup.zip')
    dialogMock.showSaveDialog.mockResolvedValue({ canceled: false, filePath: outZip })

    const res = await exportBackup(null, { mode: 'metadata' })

    expect(res.error).toBeUndefined()
    expect(res.mode).toBe('metadata')
    expect(res.models).toBe(2)
    expect(res.covers).toBe(0)
    const zip = readZip(outZip)
    expect(Object.keys(JSON.parse(zip['library/store.json']).models)).toHaveLength(2)
    expect(Object.keys(zip).some((k) => k.startsWith('library/covers/'))).toBe(false)
  })

  it('selected 模式筛选结果无标注时返回明确错误', async () => {
    const root = makeLibrary()
    setDataRoot(root)
    await loadData()
    const outZip = path.join(mkTmp('modelvault-out-'), 'backup.zip')
    dialogMock.showSaveDialog.mockResolvedValue({ canceled: false, filePath: outZip })

    const res = await exportBackup(null, {
      mode: 'selected',
      ids: [path.join(root, 'missing.safetensors')]
    })

    expect(res.error).toContain('没有可备份的模型标注')
    expect(fs.existsSync(outZip)).toBe(false)
  })

  it('大封面跨多个读块流式写入后仍可正确解压', async () => {
    const root = makeLibrary()
    const big = Buffer.alloc(2 * 1024 * 1024, 0x5a)
    fs.writeFileSync(path.join(root, '.modelvault', 'covers', 'big.png'), big)
    setDataRoot(root)
    await loadData()
    const outZip = path.join(mkTmp('modelvault-out-'), 'backup.zip')
    dialogMock.showSaveDialog.mockResolvedValue({ canceled: false, filePath: outZip })

    const res = await exportBackup(null)

    expect(res.error).toBeUndefined()
    expect(res.covers).toBe(3)
    const zip = unzipSync(new Uint8Array(fs.readFileSync(outZip)))
    expect(Buffer.from(zip['library/covers/big.png']).equals(big)).toBe(true)
  })

  it('无关联数据时仅备份应用设置', async () => {
    const root = mkTmp('modelvault-empty-lib-')
    setDataRoot(root)
    await loadData()
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
    await loadData()
    dialogMock.showSaveDialog.mockResolvedValue({ canceled: true })
    const res = await exportBackup(null)
    expect(res.canceled).toBe(true)
  })

  it('导出前先 flush 防抖写入：刚修改的备注进入备份（B-02）', async () => {
    const root = makeLibrary()
    setDataRoot(root)
    await loadData()
    // 防抖窗口内（500ms 未到）立即导出：不 flush 时备份读到旧磁盘内容
    setModelMeta(path.join(root, 'a.safetensors'), { note: '刚修改的备注' })
    const outZip = path.join(mkTmp('modelvault-out-'), 'backup.zip')
    dialogMock.showSaveDialog.mockResolvedValue({ canceled: false, filePath: outZip })

    const res = await exportBackup(null)

    expect(res.error).toBeUndefined()
    const store = JSON.parse(readZip(outZip)['library/store.json'])
    expect(store.models['a.safetensors'].note).toBe('刚修改的备注')
  })

  it('库内无 covers 目录时按零封面导出，不中断备份', async () => {
    const root = mkTmp('modelvault-lib-')
    fs.mkdirSync(path.join(root, '.modelvault'), { recursive: true })
    fs.writeFileSync(
      path.join(root, '.modelvault', 'store.json'),
      JSON.stringify({ version: 1, models: { 'a.safetensors': {} } })
    )
    setDataRoot(root)
    await loadData()
    const outZip = path.join(mkTmp('modelvault-out-'), 'backup.zip')
    dialogMock.showSaveDialog.mockResolvedValue({ canceled: false, filePath: outZip })

    const res = await exportBackup(null)

    expect(res.error).toBeUndefined()
    expect(res.library).toBe(true)
    expect(res.covers).toBe(0)
  })

  it('关联存储读取失败时返回明确错误，不产出半成品备份', async () => {
    const root = mkTmp('modelvault-lib-')
    // store.json 为目录：readFile 必然失败（EISDIR），触发导出前的读取兜底
    fs.mkdirSync(path.join(root, '.modelvault', 'store.json'), { recursive: true })
    setDataRoot(root)
    const outZip = path.join(mkTmp('modelvault-out-'), 'backup.zip')
    dialogMock.showSaveDialog.mockResolvedValue({ canceled: false, filePath: outZip })

    const res = await exportBackup(null)

    expect(res.error).toContain('读取关联存储失败')
    expect(fs.existsSync(outZip)).toBe(false)
  })

  it('备份写入失败时清理半成品并返回错误', async () => {
    const root = makeLibrary()
    setDataRoot(root)
    await loadData()
    // 保存路径指向已存在目录：createWriteStream 必然报错（EISDIR/EPERM）
    const badPath = mkTmp('modelvault-out-')
    dialogMock.showSaveDialog.mockResolvedValue({ canceled: false, filePath: badPath })

    const res = await exportBackup(null)

    expect(res.error).toContain('备份写入失败')
  })
})

describe('importBackup', () => {
  it('选择性备份合并到当前库：新增/更新/封面，不替换目录与设置（FN-08）', async () => {
    const root = makeLibrary()
    setDataRoot(root)
    await loadData()
    setModelMeta(path.join(root, 'a.safetensors'), { note: '旧备注' })
    setModelMeta(path.join(root, 'b.safetensors'), { note: '保留备注' })

    const zipPath = makePartialZip(path.join(mkTmp('modelvault-out-'), 'selected.zip'), {
      mode: 'selected',
      models: {
        'a.safetensors': { note: '新备注' },
        'c.safetensors': { note: '新增备注' }
      },
      covers: { 'new.png': 'new-cover' }
    })
    dialogMock.showOpenDialog.mockReset()
    dialogMock.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [zipPath] })
    dialogMock.showMessageBox.mockResolvedValue({ response: 1 })

    const res = await importBackup(null)

    expect(res.error).toBeUndefined()
    expect(res.libraryRestored.partial).toBe(true)
    expect(res.libraryRestored.added).toBe(1)
    expect(res.libraryRestored.updated).toBe(1)
    expect(res.libraryRestored.covers).toBe(1)
    expect(getModelMeta(path.join(root, 'a.safetensors'))?.note).toBe('新备注')
    expect(getModelMeta(path.join(root, 'c.safetensors'))?.note).toBe('新增备注')
    // 原有其他模型保留
    expect(getModelMeta(path.join(root, 'b.safetensors'))?.note).toBe('保留备注')
    // 新封面写入当前库，且未做目录交换（无 .bak）
    expect(fs.readFileSync(path.join(root, DATA_DIR, 'covers', 'new.png'), 'utf8')).toBe(
      'new-cover'
    )
    expect(fs.readdirSync(root).some((n) => n.startsWith('.modelvault.bak-'))).toBe(false)
    // 恢复前快照写入 backups/
    expect(fs.readdirSync(path.join(root, DATA_DIR, 'backups')).length).toBeGreaterThan(0)
    // 部分恢复不覆盖库设置
    expect(fs.existsSync(path.join(root, DATA_DIR, 'settings.json'))).toBe(false)
  })

  it('metadata 备份合并时清空封面引用，避免指向不存在的文件（FN-08）', async () => {
    const root = makeLibrary()
    setDataRoot(root)
    await loadData()
    const zipPath = makePartialZip(path.join(mkTmp('modelvault-out-'), 'metadata.zip'), {
      mode: 'metadata',
      models: {
        'a.safetensors': {
          note: '仅标注',
          cover: '.modelvault/covers/c1.png',
          covers: ['.modelvault/covers/c1.png']
        }
      }
    })
    dialogMock.showOpenDialog.mockReset()
    dialogMock.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [zipPath] })
    dialogMock.showMessageBox.mockResolvedValue({ response: 1 })

    const res = await importBackup(null)

    expect(res.libraryRestored.partial).toBe(true)
    const meta = getModelMeta(path.join(root, 'a.safetensors'))
    expect(meta.note).toBe('仅标注')
    expect(meta.cover).toBe('')
    expect(meta.covers).toEqual([])
  })

  it('取消合并恢复时不修改任何数据（FN-08）', async () => {
    const root = makeLibrary()
    setDataRoot(root)
    await loadData()
    const zipPath = makePartialZip(path.join(mkTmp('modelvault-out-'), 'cancel.zip'), {
      models: { 'a.safetensors': { note: '不应写入' } }
    })
    dialogMock.showOpenDialog.mockReset()
    dialogMock.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [zipPath] })
    dialogMock.showMessageBox.mockResolvedValue({ response: 0 })

    const res = await importBackup(null)

    expect(res.error).toContain('已取消合并恢复')
    expect(getModelMeta(path.join(root, 'a.safetensors'))?.note || '').not.toBe('不应写入')
  })

  it('选择性备份缺少库元数据时拒绝，并清理本次写入的封面（FN-08）', async () => {
    const root = makeLibrary()
    setDataRoot(root)
    await loadData()
    const zipPath = path.join(mkTmp('modelvault-out-'), 'broken-partial.zip')
    fs.writeFileSync(
      zipPath,
      zipSync({
        'manifest.json': strToU8(
          JSON.stringify({
            app: BACKUP_FORMAT,
            version: PARTIAL_BACKUP_VERSION,
            settings: true,
            partial: true,
            mode: 'selected',
            library: { root: 'D:\\x', models: 1, covers: 1 }
          })
        ),
        'library/covers/leak.png': strToU8('leak')
      })
    )
    dialogMock.showOpenDialog.mockReset()
    dialogMock.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [zipPath] })
    dialogMock.showMessageBox.mockResolvedValue({ response: 1 })

    const res = await importBackup(null)

    expect(res.error).toContain('备份缺少库元数据')
    // 失败时删除本次写入的封面，不在库内留半成品
    expect(fs.existsSync(path.join(root, DATA_DIR, 'covers', 'leak.png'))).toBe(false)
  })

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
    // 库设置随备份恢复（写入目标库 .modelvault/settings.json，引导字段不入包）
    const saved = JSON.parse(
      fs.readFileSync(path.join(target, '.modelvault', 'settings.json'), 'utf8')
    )
    expect(saved.theme).toBe('light')
    expect(saved.sortBy).toBe('size')
    expect(saved.modelsFolder).toBeUndefined()
  })

  it('大封面跨解压分块仍逐张写入目标目录（含空封面条目）', async () => {
    const zipPath = path.join(mkTmp('modelvault-out-'), 'big-cover.zip')
    // store（level 0）写入不可压缩数据：解压时按读块分批回调，覆盖多块合并路径；
    // 零字节条目则覆盖「无数据块」路径
    const big = crypto.randomBytes(2 * 1024 * 1024)
    fs.writeFileSync(
      zipPath,
      zipSync({
        'manifest.json': strToU8(
          JSON.stringify({
            app: BACKUP_FORMAT,
            version: BACKUP_VERSION,
            settings: true,
            library: { root: 'D:\\old-lib', models: 1, covers: 2 }
          })
        ),
        'settings.json': strToU8(JSON.stringify({ theme: 'light' })),
        'library/store.json': strToU8(
          JSON.stringify({ version: 1, models: { 'x.safetensors': {} } })
        ),
        'library/covers/big.png': [new Uint8Array(big), { level: 0 }],
        'library/covers/empty.png': [new Uint8Array(0), { level: 0 }]
      })
    )
    const target = mkTmp('modelvault-target-')
    dialogMock.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [zipPath] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [target] })

    const res = await importBackup(null)

    expect(res.error).toBeUndefined()
    expect(res.libraryRestored.covers).toBe(2)
    const coversDir = path.join(target, '.modelvault', 'covers')
    expect(fs.readFileSync(path.join(coversDir, 'big.png')).equals(big)).toBe(true)
    expect(fs.statSync(path.join(coversDir, 'empty.png')).size).toBe(0)
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

  it('恢复到当前激活根时，恢复前的在途防抖保存不覆盖恢复结果（B1）', async () => {
    // 恢复目标即当前激活根：内存持有该根的旧数据
    const target = mkTmp('modelvault-target-')
    setDataRoot(target)
    await loadData()
    // 恢复前的最后一次修改：防抖 500ms 后才落盘（恢复流程中最危险的在途写入）
    setModelMeta(path.join(target, 'stale.safetensors'), { note: '恢复前的旧数据' })

    const zipPath = makeBackupZip(path.join(mkTmp('modelvault-out-'), 'backup.zip'))
    dialogMock.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [zipPath] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [target] })
    // restoreLibrary 先静止写盘链：旧数据落盘会创建 .modelvault，恢复走覆盖分支
    dialogMock.showMessageBox.mockResolvedValue({ response: 1 })

    const res = await importBackup(null)
    expect(res.libraryRestored.root).toBe(target)

    // 越过防抖延迟：未静止写盘链时，迟到的防抖会用恢复前的旧内存
    // 原子覆盖刚恢复的 store.json（恢复被静默回滚）
    await new Promise((resolve) => setTimeout(resolve, 700))
    const store = JSON.parse(
      fs.readFileSync(path.join(target, '.modelvault', 'store.json'), 'utf8')
    )
    expect(store.models['x.safetensors']).toBeDefined()
    expect(store.models['stale.safetensors']).toBeUndefined()
    // 清理内存态，避免影响后续用例（setDataRoot 指向已恢复的旧内存数据）
    setDataRoot(null)
    await loadData()
  })

  it('覆盖确认取消时保留现有数据（设置与库数据均未恢复）', async () => {
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
    // 库设置随库恢复：未发生目录交换，设置同样未落盘
    expect(res.settingsRestored).toBe(false)
    expect(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8')).toBe('OLD')
    expect(fs.existsSync(path.join(dataDir, 'settings.json'))).toBe(false)
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

  it('备份中的危险元数据键被清洗，不写入目标库（B-04）', async () => {
    const zipPath = path.join(mkTmp('modelvault-out-'), 'evil-meta.zip')
    fs.writeFileSync(
      zipPath,
      zipSync({
        'manifest.json': strToU8(
          JSON.stringify({
            app: BACKUP_FORMAT,
            version: BACKUP_VERSION,
            settings: true,
            library: { root: 'D:\\old-lib', models: 2, covers: 0 }
          })
        ),
        'library/store.json': strToU8(
          '{"version":1,"models":{"__proto__":{"alias":"pwn"},' +
            '"ok.safetensors":{"note":"ok"}}}'
        )
      })
    )
    const target = mkTmp('modelvault-target-')
    dialogMock.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [zipPath] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [target] })

    const res = await importBackup(null)

    expect(res.error).toBeUndefined()
    // 危险键被剔除，只保留合法条目
    expect(res.libraryRestored.models).toBe(1)
    const disk = JSON.parse(
      fs.readFileSync(path.join(target, '.modelvault', 'store.json'), 'utf8')
    )
    expect(Object.prototype.hasOwnProperty.call(disk.models, '__proto__')).toBe(false)
    expect(disk.models['ok.safetensors'].note).toBe('ok')
    expect({}.alias).toBeUndefined()
  })

  it('单条封面解压后超限时拒绝恢复，不创建目标目录（B-04 压缩炸弹防护）', async () => {
    const zipPath = path.join(mkTmp('modelvault-out-'), 'bomb.zip')
    // 65MB 零字节覆盖 64MB 单条上限。以 store（level 0）写入：deflate 这 65MB
    // 在 v8 覆盖率插桩下有数秒开销，CI 高并发下会触发 5s 默认超时；
    // 头部声明的解压后大小仍为 65MB，恢复顺序（manifest 先行 → 条目大小校验）
    // 与防护语义不变
    const huge = new Uint8Array(65 * 1024 * 1024)
    fs.writeFileSync(
      zipPath,
      zipSync({
        'manifest.json': strToU8(
          JSON.stringify({
            app: BACKUP_FORMAT,
            version: BACKUP_VERSION,
            settings: true,
            library: { root: 'D:\\old-lib', models: 0, covers: 1 }
          })
        ),
        'library/store.json': strToU8(JSON.stringify({ version: 1, models: {} })),
        'library/covers/huge.png': [huge, { level: 0 }]
      })
    )
    const target = mkTmp('modelvault-target-')
    // 流式恢复先确认目标目录，再在维护锁内解压；超限错误发生在临时目录阶段
    dialogMock.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [zipPath] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [target] })

    const res = await importBackup(null)

    expect(res.error).toContain('超过 64MB 上限')
    expect(fs.existsSync(path.join(target, '.modelvault'))).toBe(false)
  })

  it('维护操作进行中时拒绝恢复，不触碰目标目录（V-02）', async () => {
    const zipPath = makeBackupZip(path.join(mkTmp('modelvault-out-'), 'backup.zip'))
    const target = mkTmp('modelvault-target-')
    dialogMock.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [zipPath] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [target] })
    // 模拟扫描正在持有全局维护锁
    const token = tryAcquireMaintenance('scan', 'D:\\scanning-root')
    expect(token).toBeTruthy()
    try {
      const res = await importBackup(null)
      expect(res.error).toContain('正在扫描中')
      expect(fs.existsSync(path.join(target, '.modelvault'))).toBe(false)
    } finally {
      releaseMaintenance(token)
    }
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

  it('仅含设置的备份：写入当前激活库，不弹出目标文件夹选择', async () => {
    const lib = makeLibrary()
    setDataRoot(lib)
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
    // 库设置随库落盘（引导字段剥离）
    const saved = JSON.parse(
      fs.readFileSync(path.join(lib, '.modelvault', 'settings.json'), 'utf8')
    )
    expect(saved.theme).toBe('light')
    expect(saved.sortBy).toBe('size')
    expect(saved.modelsFolder).toBeUndefined()
  })

  it('备份文件无法读取时返回读取失败原因（不进入解压）', async () => {
    const missing = path.join(mkTmp('modelvault-out-'), 'not-here.zip')
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [missing] })

    const res = await importBackup(null)

    expect(res.error).toContain('备份文件读取失败')
  })

  it('含库数据但取消选择目标文件夹时不做任何恢复', async () => {
    const zipPath = makeBackupZip(path.join(mkTmp('modelvault-out-'), 'backup.zip'))
    dialogMock.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [zipPath] })
      .mockResolvedValueOnce({ canceled: true })

    const res = await importBackup(null)

    expect(res.error).toContain('已取消选择目标文件夹')
    expect(res.settingsRestored).toBe(false)
    expect(res.partial).toBe(true)
  })

  it('备份缺少库元数据时拒绝恢复，不创建目标目录', async () => {
    const zipPath = path.join(mkTmp('modelvault-out-'), 'no-store.zip')
    fs.writeFileSync(
      zipPath,
      zipSync({
        'manifest.json': strToU8(
          JSON.stringify({
            app: BACKUP_FORMAT,
            version: BACKUP_VERSION,
            settings: true,
            library: { root: 'D:\\old-lib', models: 1, covers: 0 }
          })
        ),
        'settings.json': strToU8(JSON.stringify({ theme: 'light' }))
      })
    )
    const target = mkTmp('modelvault-target-')
    dialogMock.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [zipPath] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [target] })

    const res = await importBackup(null)

    expect(res.error).toContain('备份缺少库元数据')
    expect(fs.existsSync(path.join(target, DATA_DIR))).toBe(false)
  })

  it('封面条目重复时拒绝恢复（同名条目会产生覆盖歧义）', async () => {
    const zipPath = await makeDuplicateCoverZip(
      path.join(mkTmp('modelvault-out-'), 'dup.zip')
    )
    const target = mkTmp('modelvault-target-')
    dialogMock.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [zipPath] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [target] })

    const res = await importBackup(null)

    expect(res.error).toContain('备份包含重复条目')
    expect(fs.existsSync(path.join(target, DATA_DIR))).toBe(false)
  })

  it('仅设置的备份：封面条目连解压都跳过', async () => {
    const lib = makeLibrary()
    setDataRoot(lib)
    const zipPath = path.join(mkTmp('modelvault-out-'), 'settings-with-cover.zip')
    fs.writeFileSync(
      zipPath,
      zipSync({
        'manifest.json': strToU8(
          JSON.stringify({ app: BACKUP_FORMAT, version: BACKUP_VERSION, settings: true })
        ),
        'settings.json': strToU8(JSON.stringify({ theme: 'light' })),
        'library/covers/ignored.png': strToU8('not-needed')
      })
    )
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [zipPath] })

    const res = await importBackup(null)

    expect(res.error).toBeUndefined()
    expect(res.settingsRestored).toBe(true)
    expect(res.libraryRestored).toBeUndefined()
  })

  it('仅设置的备份中 settings.json 损坏时返回明确错误', async () => {
    const zipPath = path.join(mkTmp('modelvault-out-'), 'bad-settings.zip')
    fs.writeFileSync(
      zipPath,
      zipSync({
        'manifest.json': strToU8(
          JSON.stringify({ app: BACKUP_FORMAT, version: BACKUP_VERSION, settings: true })
        ),
        'settings.json': strToU8('not-json')
      })
    )
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [zipPath] })

    const res = await importBackup(null)

    expect(res.error).toContain('备份中的设置数据损坏')
  })

  it('仅设置的备份在当前无激活库时不恢复设置', async () => {
    setDataRoot(null)
    await loadData()
    const zipPath = makeBackupZip(path.join(mkTmp('modelvault-out-'), 'backup.zip'), {
      withLibrary: false
    })
    dialogMock.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [zipPath] })

    const res = await importBackup(null)

    expect(res.error).toBeUndefined()
    expect(res.settingsRestored).toBe(false)
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
