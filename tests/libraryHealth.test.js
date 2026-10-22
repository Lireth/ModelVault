import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  loadData,
  setDataRoot,
  setModelMeta,
  getModelMeta
} from '../src/main/services/store'
import { checkLibraryHealth, repairLibraryHealth } from '../src/main/services/library-health'
import {
  releaseMaintenance,
  tryAcquireMaintenance
} from '../src/main/services/maintenance-lock'

/**
 * 模型库体检与修复（V-07）测试：
 * - 报告缺失模型文件、失效封面引用、孤儿封面、重复哈希；
 * - 修复仅移除幽灵标注/失效引用，孤儿封面移入 trash 而非删除；
 * - 修复前生成 store.json 备份；
 * - 与全局维护锁互斥。
 */

let root
const roots = []
const HASH_A = 'a'.repeat(64)

async function touchModel(rel, content = 'x') {
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content)
  return abs
}

async function touchCover(name) {
  const dir = path.join(root, '.modelvault', 'covers')
  await fs.mkdir(dir, { recursive: true })
  const abs = path.join(dir, name)
  await fs.writeFile(abs, 'img')
  return abs
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-health-'))
  roots.push(root)
  setDataRoot(root)
  await loadData()
})

afterAll(async () => {
  for (const dir of roots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

/** 构造一个包含各类问题的库 */
async function seedProblemLibrary() {
  const a = await touchModel('a.safetensors')
  await touchCover('a.jpg')
  setModelMeta(a, {
    covers: ['.modelvault/covers/a.jpg', '.modelvault/covers/missing.jpg'],
    cover: '.modelvault/covers/a.jpg'
  })

  const b = await touchModel('lora/b.safetensors')
  setModelMeta(b, { hash: HASH_A })
  const c = await touchModel('lora/c.safetensors')
  setModelMeta(c, { hash: HASH_A })

  const missing = path.join(root, 'missing.safetensors')
  setModelMeta(missing, { note: '幽灵标注' })
  await touchCover('orphan.jpg')

  return { a, b, c, missing }
}

describe('checkLibraryHealth（只读体检）', () => {
  it('报告缺失文件、失效封面、孤儿封面与重复哈希', async () => {
    const { missing } = await seedProblemLibrary()

    const res = await checkLibraryHealth()

    expect(res.error).toBeUndefined()
    const report = res.report
    expect(report.totalModels).toBe(4)
    expect(report.missingFiles.map((x) => x.rel)).toContain('missing.safetensors')
    expect(report.brokenCovers).toContainEqual(
      expect.objectContaining({ cover: '.modelvault/covers/missing.jpg', reason: 'missing-file' })
    )
    expect(report.orphanCovers.map((x) => x.name)).toEqual(['orphan.jpg'])
    expect(report.duplicateHashes).toHaveLength(1)
    expect(report.duplicateHashes[0].models).toEqual(['lora/b.safetensors', 'lora/c.safetensors'])
    expect(report.summary).toMatchObject({
      missingFiles: 1,
      brokenCovers: 1,
      orphanCovers: 1,
      duplicateHashes: 1,
      repairable: 3
    })
    // 只读：幽灵标注仍在
    expect(getModelMeta(missing)).toBeTruthy()
    // 孤儿封面文件未被移动
    await expect(
      fs.access(path.join(root, '.modelvault', 'covers', 'orphan.jpg'))
    ).resolves.toBeUndefined()
  })

  it('无问题时报告为空且 repairable=0', async () => {
    const a = await touchModel('ok.safetensors')
    setModelMeta(a, { note: 'ok' })

    const res = await checkLibraryHealth()

    expect(res.report.summary).toMatchObject({
      missingFiles: 0,
      brokenCovers: 0,
      orphanCovers: 0,
      duplicateHashes: 0,
      repairable: 0
    })
  })
})

describe('repairLibraryHealth（一键修复）', () => {
  it('移除幽灵标注、清理失效引用、孤儿封面移入 trash，并备份元数据', async () => {
    const { a, missing } = await seedProblemLibrary()

    const res = await repairLibraryHealth()

    expect(res.error).toBeUndefined()
    expect(res.repaired).toMatchObject({
      removedMetadata: 1,
      fixedCoverModels: 1,
      removedCoverRefs: 1,
      movedOrphanCovers: 1
    })
    expect(res.backupPath).toContain(path.join('.modelvault', 'backups'))
    await expect(fs.access(res.backupPath)).resolves.toBeUndefined()

    // 幽灵标注已移除
    expect(getModelMeta(missing)).toBeNull()
    // 失效引用被清理，默认封面回退到仍存在的 a.jpg
    expect(getModelMeta(a)).toMatchObject({
      covers: ['.modelvault/covers/a.jpg'],
      cover: '.modelvault/covers/a.jpg'
    })
    // 孤儿封面已移动（保留可恢复性），封面目录只剩有效文件
    await expect(
      fs.access(path.join(root, '.modelvault', 'covers', 'orphan.jpg'))
    ).rejects.toThrow()
    const covers = await fs.readdir(path.join(root, '.modelvault', 'covers'))
    expect(covers).toEqual(['a.jpg'])
    const trashRoots = await fs.readdir(path.join(root, '.modelvault', 'trash'))
    expect(trashRoots).toHaveLength(1)
    const trashed = await fs.readdir(path.join(root, '.modelvault', 'trash', trashRoots[0]))
    expect(trashed).toContain('orphan.jpg')
  })

  it('没有可修复问题时不做备份与修改', async () => {
    const a = await touchModel('ok.safetensors')
    setModelMeta(a, { note: 'ok' })

    const res = await repairLibraryHealth()

    expect(res.repaired).toMatchObject({
      removedMetadata: 0,
      fixedCoverModels: 0,
      removedCoverRefs: 0,
      movedOrphanCovers: 0
    })
    expect(res.backupPath).toBe('')
  })

  it('无权限/占用错误标记为“无法访问”，绝不进入自动修复', async () => {
    const locked = await touchModel('locked.safetensors')
    setModelMeta(locked, { note: '必须保留' })
    const realStat = fs.stat.bind(fs)
    const spy = vi.spyOn(fs, 'stat').mockImplementation(async (target) => {
      if (String(target) === locked) {
        const err = new Error('denied')
        err.code = 'EACCES'
        throw err
      }
      return realStat(target)
    })
    try {
      const check = await checkLibraryHealth()
      expect(check.report.summary.inaccessible).toBe(1)
      expect(check.report.missingFiles).toHaveLength(0)

      const repair = await repairLibraryHealth()
      expect(repair.repaired.removedMetadata).toBe(0)
      expect(getModelMeta(locked)).toBeTruthy()
    } finally {
      spy.mockRestore()
    }
  })

  it('维护操作进行中时返回忙提示，不做任何修改（V-02/V-07）', async () => {
    const { missing } = await seedProblemLibrary()
    const token = tryAcquireMaintenance('scan', root)
    expect(token).toBeTruthy()
    try {
      const res = await repairLibraryHealth()
      expect(res.error).toContain('正在扫描中')
      expect(getModelMeta(missing)).toBeTruthy()
    } finally {
      releaseMaintenance(token)
    }
  })
})
