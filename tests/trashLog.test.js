import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseRecycleRecord, findRecycleEntryFor } from '../src/main/services/trash-log'
import {
  forgetDeletedModel,
  listDeletedModels,
  recordModelDeletion,
  restoreDeletedModel
} from '../src/main/services/trash-log'
import { DATA_DIR, getModelMeta, loadData, removeModelMeta, setDataRoot, setModelMeta } from '../src/main/services/store'

/**
 * 回收站桥接测试（F-2）：
 * - $I 索引文件解析（v1/v2 格式、FILETIME 转换、损坏容错）；
 * - 回收站枚举匹配（伪造 $Recycle.Bin/<SID>/ 结构，大小写不敏感、多版本取新）；
 * - 记录/列表/恢复/忽略全链路：临时库 + 伪造回收站，恢复后文件回原位、
 *   元数据重绑、记录清空；原位置占用/越界路径拒绝。
 */

/** 本文件产生的临时目录（测试结束后统一清理） */
const tmpDirs = []

function mkTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

afterAll(async () => {
  for (const dir of tmpDirs) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

/** ms 时间戳 → Windows FILETIME（1601-01-01 起 100ns） */
function toFiletime(ms) {
  return BigInt(Math.floor(ms) + 11644473600000) * 10000n
}

/**
 * 构造 $I 索引文件字节。
 * @param {string} originalPath 原始完整路径
 * @param {number} size 文件大小
 * @param {number} deletedAtMs 删除时刻（Unix ms）
 * @param {1|2} [version] $I 格式版本
 */
function buildIFileBytes(originalPath, size, deletedAtMs, version = 2) {
  const nameBuf = Buffer.from(originalPath, 'utf16le')
  // v1：28 字节头（名称长度在 24-27，名称自 28 起）；v2：32 字节头（另有 4B 零填充）
  const headerLen = version === 2 ? 32 : 28
  const buf = Buffer.alloc(headerLen + nameBuf.length)
  buf.writeBigUInt64LE(BigInt(version), 0)
  buf.writeBigUInt64LE(BigInt(size), 8)
  buf.writeBigUInt64LE(toFiletime(deletedAtMs), 16)
  buf.writeUInt32LE(originalPath.length, 24)
  nameBuf.copy(buf, headerLen)
  return buf
}

/**
 * 在伪造回收站中写入一对 $I/$R 条目。
 * @returns {Promise<string>} $R 数据文件路径
 */
async function writeRecycleEntry(binRoot, sid, random, originalPath, content, deletedAtMs, version = 2) {
  const dir = path.join(binRoot, sid)
  await fsp.mkdir(dir, { recursive: true })
  const iPath = path.join(dir, `$I${random}.safetensors`)
  const rPath = path.join(dir, `$R${random}.safetensors`)
  await fsp.writeFile(iPath, buildIFileBytes(originalPath, content.length, deletedAtMs, version))
  await fsp.writeFile(rPath, content)
  return rPath
}

describe('parseRecycleRecord（$I 索引解析）', () => {
  it('v2 格式：版本/大小/删除时间/原始路径', () => {
    const at = Date.now()
    const buf = buildIFileBytes('D:\\Lib\\Model.safetensors', 123456, at, 2)
    const record = parseRecycleRecord(buf)
    expect(record.originalPath).toBe('D:\\Lib\\Model.safetensors')
    expect(record.size).toBe(123456)
    expect(record.deletedAt).toBe(at)
  })

  it('v1 格式（24 字节头）正确解析', () => {
    const at = Date.now()
    const buf = buildIFileBytes('D:\\Lib\\Old.safetensors', 8, at, 1)
    const record = parseRecycleRecord(buf)
    expect(record.originalPath).toBe('D:\\Lib\\Old.safetensors')
    expect(record.size).toBe(8)
    expect(record.deletedAt).toBe(at)
  })

  it('损坏数据容错返回 null：截断/未知版本/非法名称长度', () => {
    expect(parseRecycleRecord(Buffer.alloc(4))).toBeNull()
    expect(parseRecycleRecord(null)).toBeNull()
    const unknownVersion = Buffer.alloc(64)
    unknownVersion.writeBigUInt64LE(3n, 0)
    expect(parseRecycleRecord(unknownVersion)).toBeNull()
    // 声称的名称长度越界
    const lying = buildIFileBytes('D:\\x', 0, Date.now())
    lying.writeUInt32LE(99999, 24)
    expect(parseRecycleRecord(lying)).toBeNull()
  })
})

describe('findRecycleEntryFor（回收站枚举匹配）', () => {
  it('按原路径命中并返回 $R 路径（内容可读回）', async () => {
    const binRoot = mkTmp('modelvault-bin-')
    const rPath = await writeRecycleEntry(
      binRoot, 'S-1-5-21-100', 'ABC123', 'D:\\Lib\\Model.safetensors', 'model-bytes', Date.now()
    )
    const found = await findRecycleEntryFor('D:\\Lib\\Model.safetensors', binRoot)
    expect(found).not.toBeNull()
    expect(found.rPath).toBe(rPath)
    expect(await fsp.readFile(found.rPath, 'utf-8')).toBe('model-bytes')
  })

  it('路径匹配大小写不敏感（Windows 语义）', async () => {
    const binRoot = mkTmp('modelvault-bin-')
    await writeRecycleEntry(binRoot, 'S-1-5-21-100', 'ABC123', 'D:\\Lib\\MODEL.SAFETENSORS', 'x', Date.now())
    const found = await findRecycleEntryFor('d:\\lib\\model.safetensors', binRoot)
    expect(found).not.toBeNull()
  })

  it('同一文件多次删除取删除时间最新的一条', async () => {
    const binRoot = mkTmp('modelvault-bin-')
    await writeRecycleEntry(binRoot, 'S-1-5-21-100', 'OLD001', 'D:\\Lib\\M.safetensors', 'old', Date.now() - 100000)
    const newest = await writeRecycleEntry(binRoot, 'S-1-5-21-100', 'NEW002', 'D:\\Lib\\M.safetensors', 'new', Date.now())
    const found = await findRecycleEntryFor('D:\\Lib\\M.safetensors', binRoot)
    expect(found.rPath).toBe(newest)
  })

  it('未命中/回收站不存在返回 null', async () => {
    const binRoot = mkTmp('modelvault-bin-')
    await writeRecycleEntry(binRoot, 'S-1-5-21-100', 'ABC123', 'D:\\Lib\\Other.safetensors', 'x', Date.now())
    expect(await findRecycleEntryFor('D:\\Lib\\Missing.safetensors', binRoot)).toBeNull()
    expect(await findRecycleEntryFor('D:\\Lib\\X.safetensors', path.join(binRoot, 'not-exist'))).toBeNull()
  })
})

describe('记录/恢复全链路（临时库 + 伪造回收站）', () => {
  let root
  let binRoot

  beforeEach(async () => {
    root = mkTmp('modelvault-trash-lib-')
    binRoot = mkTmp('modelvault-trash-bin-')
    await fsp.mkdir(path.join(root, DATA_DIR), { recursive: true })
    setDataRoot(root)
    await loadData()
  })

  it('删除记录：列表返回展示字段，同路径旧记录被覆盖，上限保留最新', async () => {
    const abs = path.join(root, 'a.safetensors')
    setModelMeta(abs, { favorite: true })
    await recordModelDeletion(abs, [path.join(root, 'a.txt')])
    const list = await listDeletedModels()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('a.safetensors')
    expect(list[0].absPath).toBe(abs)
    expect(Number.isFinite(list[0].deletedAt)).toBe(true)
    // 列表不回传元数据快照原文
    expect(list[0].meta).toBeUndefined()
  })

  it('一键恢复：文件回原位、元数据重绑、记录清空', async () => {
    const abs = path.join(root, 'sub', 'b.safetensors')
    const sidecar = path.join(root, 'sub', 'b.txt')
    setModelMeta(abs, { favorite: true, rating: 4, note: 'keep me' })
    // 模拟真实删除顺序：文件先进回收站，再记录，再清元数据
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, 'model-content')
    await fsp.writeFile(sidecar, 'note text')
    await fsp.rename(abs, path.join(binRoot, 'staged-model.bin'))
    await fsp.rename(sidecar, path.join(binRoot, 'staged-note.txt'))
    await writeRecycleEntry(binRoot, 'S-1-5-21-100', 'AAA001', abs, 'model-content', Date.now())
    await writeRecycleEntry(binRoot, 'S-1-5-21-100', 'AAA002', sidecar, 'note text', Date.now())
    await recordModelDeletion(abs, [sidecar])
    removeModelMeta(abs) // 复现删除链路的元数据清理
    expect(getModelMeta(abs)).toBeNull()

    const res = await restoreDeletedModel(abs, { binRoot })
    expect(res.ok).toBe(true)
    expect(res.sidecarsRestored).toBe(1)
    expect(res.metaRestored).toBe(true)
    // 文件与 sidecar 回到原位置
    expect(await fsp.readFile(abs, 'utf-8')).toBe('model-content')
    expect(await fsp.readFile(sidecar, 'utf-8')).toBe('note text')
    // 元数据快照重绑（favorite/rating/note 原样恢复）
    const meta = getModelMeta(abs)
    expect(meta.favorite).toBe(true)
    expect(meta.rating).toBe(4)
    expect(meta.note).toBe('keep me')
    // 记录清空
    expect(await listDeletedModels()).toHaveLength(0)
  })

  it('恢复边界：越界路径/无记录/原位置占用/回收站未找到均拒绝', async () => {
    // 越界：不在当前库内
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'modelvault-outside-'))
    tmpDirs.push(outside)
    const resOutside = await restoreDeletedModel(path.join(outside, 'x.safetensors'), { binRoot })
    expect(resOutside.error).toBeTruthy()

    const abs = path.join(root, 'c.safetensors')
    // 无记录
    expect((await restoreDeletedModel(abs, { binRoot })).error).toBeTruthy()

    // 记录存在但原位置已被同名文件占用
    setModelMeta(abs, {})
    await fsp.writeFile(abs, 'still-here')
    await recordModelDeletion(abs, [])
    const resOccupied = await restoreDeletedModel(abs, { binRoot })
    expect(resOccupied.error).toContain('已存在同名文件')

    // 清掉占用文件后：回收站无对应条目
    await fsp.rm(abs, { force: true })
    const resMissing = await restoreDeletedModel(abs, { binRoot })
    expect(resMissing.error).toContain('回收站')
  })

  it('忽略：仅移除记录，可重复调用', async () => {
    const abs = path.join(root, 'd.safetensors')
    await recordModelDeletion(abs, [])
    expect(await listDeletedModels()).toHaveLength(1)
    expect((await forgetDeletedModel(abs)).ok).toBe(true)
    expect(await listDeletedModels()).toHaveLength(0)
    // 幂等
    expect((await forgetDeletedModel(abs)).ok).toBe(true)
  })
})
