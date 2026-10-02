import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fakeUserData } from './setup'

/**
 * covers.js 服务层单元测试（D2：此前仅 IPC 层有测试，服务层文件操作为盲区）。
 * electron 以最小桩提供，文件操作使用真实临时目录：
 * - 魔数校验（hasImageMagic）：伪装扩展名的非图片文件拒绝导入（文件外泄链防护）
 * - importCoverFromPath：扩展名 → 存在性 → 魔数 → 复制入 covers 目录
 * - deleteCoverFile：仅允许删除关联存储封面目录内的文件（越界拒绝）
 * - pruneOrphanCovers：孤儿封面清理与损坏重置保护（dataReset 跳过清理）
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  clipboard: { read: vi.fn() },
  dialog: { showOpenDialog: vi.fn() }
}))

import {
  deleteCoverFile,
  hasImageMagic,
  importCoverFromPath,
  pruneOrphanCovers
} from '../src/main/services/covers'
import { getCoversDir, loadData, setDataRoot, setModelMeta, wasDataReset } from '../src/main/services/store'
import { DATA_DIR, COVERS_DIR } from '../src/main/services/store'

/** 最小 PNG 文件头（魔数校验所需字节均在文件头 12 字节内） */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

let root
const roots = []

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-covers-'))
  roots.push(root)
  setDataRoot(root)
  await loadData()
})

afterEach(async () => {
  for (const dir of roots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('hasImageMagic（魔数校验）', () => {
  it('真实 PNG 头返回 true，文本内容返回 false', async () => {
    const png = path.join(root, 'a.png')
    await fs.writeFile(png, PNG_MAGIC)
    const txt = path.join(root, 'b.png')
    await fs.writeFile(txt, 'this is not an image')

    expect(await hasImageMagic(png)).toBe(true)
    expect(await hasImageMagic(txt)).toBe(false)
  })

  it('空文件返回 false；不存在的文件抛出 stat/open 错误', async () => {
    const empty = path.join(root, 'empty.png')
    await fs.writeFile(empty, Buffer.alloc(0))
    expect(await hasImageMagic(empty)).toBe(false)
    await expect(hasImageMagic(path.join(root, 'missing.png'))).rejects.toThrow()
  })
})

describe('importCoverFromPath', () => {
  it('不支持的扩展名直接拒绝', async () => {
    const src = path.join(root, 'evil.exe')
    await fs.writeFile(src, PNG_MAGIC)
    const res = await importCoverFromPath(src)
    expect(res.error).toContain('不支持的图片格式')
  })

  it('伪装成图片扩展名的非图片内容拒绝导入（文件外泄链防护）', async () => {
    const src = path.join(root, 'fake.png')
    await fs.writeFile(src, 'plain text pretending to be png')
    const res = await importCoverFromPath(src)
    expect(res.error).toContain('文件内容不是有效的图片')
    // 封面目录未被创建
    await expect(fs.access(getCoversDir())).rejects.toThrow()
  })

  it('真实图片复制进关联存储封面目录，返回绝对路径', async () => {
    const src = path.join(root, 'good.png')
    await fs.writeFile(src, PNG_MAGIC)
    const res = await importCoverFromPath(src)
    expect(res.cover).toBeTruthy()
    expect(res.cover.startsWith(getCoversDir())).toBe(true)
    // 文件名格式：{时间戳}-{基名}{扩展名}
    expect(path.basename(res.cover)).toMatch(/^-good\.png$|^\d+-good\.png$/)
    await expect(fs.access(res.cover)).resolves.toBeUndefined()
  })

  it('源文件不存在时返回错误', async () => {
    const res = await importCoverFromPath(path.join(root, 'missing.png'))
    expect(res.error).toBeTruthy()
  })
})

describe('deleteCoverFile（路径越界防护）', () => {
  it('仅允许删除封面目录内的文件，删除后文件消失', async () => {
    await fs.mkdir(getCoversDir(), { recursive: true })
    const cover = path.join(getCoversDir(), 'c1.png')
    await fs.writeFile(cover, PNG_MAGIC)
    expect(await deleteCoverFile(cover)).toBe(true)
    await expect(fs.access(cover)).rejects.toThrow()
  })

  it('封面目录外的文件拒绝删除（越界）', async () => {
    const model = path.join(root, 'model.safetensors')
    await fs.writeFile(model, 'x')
    expect(await deleteCoverFile(model)).toBe(false)
    await expect(fs.access(model)).resolves.toBeUndefined()
  })

  it('非法入参返回 false', async () => {
    expect(await deleteCoverFile('')).toBe(false)
    expect(await deleteCoverFile(null)).toBe(false)
  })
})

describe('pruneOrphanCovers（孤儿封面清理）', () => {
  it('清理不再被元数据引用的文件，保留被引用文件', async () => {
    const coversDir = path.join(root, DATA_DIR, COVERS_DIR)
    await fs.mkdir(coversDir, { recursive: true })
    const keep = path.join(coversDir, 'keep.png')
    const orphan = path.join(coversDir, 'orphan.png')
    await fs.writeFile(keep, PNG_MAGIC)
    await fs.writeFile(orphan, PNG_MAGIC)
    // 元数据引用 keep.png（模型文件仅需路径可换算，无需真实内容）
    setModelMeta(path.join(root, 'm.safetensors'), { cover: `${DATA_DIR}/${COVERS_DIR}/keep.png` })

    await pruneOrphanCovers()
    await expect(fs.access(keep)).resolves.toBeUndefined()
    await expect(fs.access(orphan)).rejects.toThrow()
  })

  it('元数据因损坏被重置时跳过清理（防止误删仍有价值的封面）', async () => {
    // 先写入损坏的 store.json 再加载，触发 dataReset
    const dataDir = path.join(root, DATA_DIR)
    await fs.mkdir(dataDir, { recursive: true })
    await fs.writeFile(path.join(dataDir, 'store.json'), '{corrupted!!')
    await loadData()
    expect(wasDataReset()).toBe(true)

    const coversDir = path.join(dataDir, COVERS_DIR)
    await fs.mkdir(coversDir, { recursive: true })
    const survivor = path.join(coversDir, 'survivor.png')
    await fs.writeFile(survivor, PNG_MAGIC)

    await pruneOrphanCovers()
    // 未被任何元数据引用（元数据已重置为空），但损坏保护使其保留
    await expect(fs.access(survivor)).resolves.toBeUndefined()
  })

  it('封面目录不存在时静默跳过（ENOENT 容错）', async () => {
    await expect(pruneOrphanCovers()).resolves.toBeUndefined()
  })
})
