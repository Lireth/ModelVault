import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  flushStoreSave,
  loadData,
  setDataRoot,
  setModelMeta,
  getModelMeta,
  setFlushAwaitTimeoutForTests,
} from '../src/main/services/store'
import {
  checkLibraryHealth,
  repairLibraryHealth,
} from '../src/main/services/library-health'
import {
  getMaintenanceState,
  releaseMaintenance,
  tryAcquireMaintenance,
} from '../src/main/services/maintenance-lock'
import { metaState } from '../src/main/services/store-meta-state'

// B3（issue #40）：atomicWriteFile 可按目录前缀挂起（模拟挂起磁盘上内核层
// 阻塞的原子写），其余调用透传真实实现；挂起的写入在用例收尾统一释放，
// 绝不遗留永久 pending 阻塞后续用例的写盘链
const { awHook } = vi.hoisted(() => ({
  awHook: { hangPrefix: null, pending: [] },
}))
vi.mock('../src/main/services/atomic-write', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    atomicWriteFile: (file, content, opts) => {
      if (awHook.hangPrefix && String(file).startsWith(awHook.hangPrefix)) {
        return new Promise((resolve, reject) => {
          awHook.pending.push({ resolve, reject })
        })
      }
      return actual.atomicWriteFile(file, content, opts)
    },
  }
})

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
    cover: '.modelvault/covers/a.jpg',
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
    expect(report.missingFiles.map((x) => x.rel)).toContain(
      'missing.safetensors',
    )
    expect(report.brokenCovers).toContainEqual(
      expect.objectContaining({
        cover: '.modelvault/covers/missing.jpg',
        reason: 'missing-file',
      }),
    )
    expect(report.orphanCovers.map((x) => x.name)).toEqual(['orphan.jpg'])
    expect(report.duplicateHashes).toHaveLength(1)
    expect(report.duplicateHashes[0].models).toEqual([
      'lora/b.safetensors',
      'lora/c.safetensors',
    ])
    expect(report.summary).toMatchObject({
      missingFiles: 1,
      brokenCovers: 1,
      orphanCovers: 1,
      duplicateHashes: 1,
      repairable: 3,
    })
    // 只读：幽灵标注仍在
    expect(getModelMeta(missing)).toBeTruthy()
    // 孤儿封面文件未被移动
    await expect(
      fs.access(path.join(root, '.modelvault', 'covers', 'orphan.jpg')),
    ).resolves.toBeUndefined()
  })

  it('模型文件完整性：0 字节/头部非法/数据区截断，并复用索引快照（FEAT-01）', async () => {
    // 0 字节（非 safetensors 也会命中）
    const empty = await touchModel('empty.ckpt', '')
    setModelMeta(empty, { note: '空文件' })

    // 头部垃圾（不可解析）
    const bad = await touchModel('bad.safetensors', 'garbage — not safetensors')
    setModelMeta(bad, { note: '坏头' })

    // 头部声明数据区到 16 字节，实际只有 4 字节（下载中断典型形态）
    const header = JSON.stringify({
      __metadata__: { 'modelspec.title': '截断模型' },
      'model.weight': { dtype: 'F32', shape: [2, 2], data_offsets: [0, 16] },
    })
    const lenBuf = Buffer.alloc(8)
    lenBuf.writeUInt32LE(Buffer.byteLength(header), 0)
    const truncatedRel = 'truncated.safetensors'
    const truncated = await touchModel(
      truncatedRel,
      Buffer.concat([lenBuf, Buffer.from(header), Buffer.alloc(4)]),
    )
    setModelMeta(truncated, { note: '截断' })

    // 索引快照：文件实际是垃圾字节，但索引声明 suspect + 数据区越界。
    // 若走实时解析会得到 invalid-header；命中索引快照应得到 truncated
    const snapRel = 'snap.safetensors'
    const snapAbs = await touchModel(snapRel, 'garbage snapshot')
    const snapStat = await fs.stat(snapAbs)
    await fs.mkdir(path.join(root, '.modelvault'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.modelvault', 'index.json'),
      JSON.stringify({
        version: 1,
        root,
        savedAt: 1,
        durationMs: 42,
        models: [
          {
            id: snapAbs,
            name: 'snap',
            type: 'lora',
            ext: '.safetensors',
            size: snapStat.size,
            mtimeMs: snapStat.mtimeMs,
            relDir: '',
            autoInfo: { expectedMinBytes: snapStat.size + 10 },
            suspect: true,
          },
        ],
      }),
    )

    const res = await checkLibraryHealth()

    expect(res.report.modelSource).toBe('index')
    expect(res.report.indexSavedAt).toBe(1)
    expect(res.report.checkedModels).toBe(4)
    expect(res.report.brokenModels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rel: 'empty.ckpt', reason: 'zero-size' }),
        expect.objectContaining({
          rel: 'bad.safetensors',
          reason: 'invalid-header',
        }),
        expect.objectContaining({
          rel: truncatedRel,
          reason: 'truncated',
        }),
        expect.objectContaining({ rel: snapRel, reason: 'truncated' }),
      ]),
    )
    expect(res.report.summary.brokenModels).toBe(4)
    // 模型文件损坏不进入自动修复范围（不能替用户删除/改写模型文件）
    expect(res.report.summary.repairable).toBe(0)
  })

  it('无问题时报告为空且 repairable=0', async () => {
    // .ckpt 不做头部结构判定：非空即视为健康（避免把无结构校验能力的格式误报）
    const a = await touchModel('ok.ckpt')
    setModelMeta(a, { note: 'ok' })

    const res = await checkLibraryHealth()

    expect(res.report.summary).toMatchObject({
      missingFiles: 0,
      brokenModels: 0,
      brokenCovers: 0,
      orphanCovers: 0,
      duplicateHashes: 0,
      repairable: 0,
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
      movedOrphanCovers: 1,
    })
    expect(res.backupPath).toContain(path.join('.modelvault', 'backups'))
    await expect(fs.access(res.backupPath)).resolves.toBeUndefined()

    // 幽灵标注已移除
    expect(getModelMeta(missing)).toBeNull()
    // 失效引用被清理，默认封面回退到仍存在的 a.jpg
    expect(getModelMeta(a)).toMatchObject({
      covers: ['.modelvault/covers/a.jpg'],
      cover: '.modelvault/covers/a.jpg',
    })
    // 孤儿封面已移动（保留可恢复性），封面目录只剩有效文件
    await expect(
      fs.access(path.join(root, '.modelvault', 'covers', 'orphan.jpg')),
    ).rejects.toThrow()
    const covers = await fs.readdir(path.join(root, '.modelvault', 'covers'))
    expect(covers).toEqual(['a.jpg'])
    const trashRoots = await fs.readdir(path.join(root, '.modelvault', 'trash'))
    expect(trashRoots).toHaveLength(1)
    const trashed = await fs.readdir(
      path.join(root, '.modelvault', 'trash', trashRoots[0]),
    )
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
      movedOrphanCovers: 0,
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

  it('在途写盘挂起时按注入上限超时继续修复并释放维护锁（B3）', async () => {
    await seedProblemLibrary()
    setFlushAwaitTimeoutForTests(50)
    // 修复入口的 flush 触发落盘并令其挂起：runSave 置 saving=true 后阻塞
    awHook.hangPrefix = path.join(root, '.modelvault')

    const started = Date.now()
    const res = await repairLibraryHealth()
    // 挂起磁盘场景下按注入上限返回，不再永久持有 'repair' 维护锁
    expect(Date.now() - started).toBeLessThan(2000)
    expect(res.error).toBeUndefined()
    // 修复语义不受挂起影响（内存操作照常完成）
    expect(res.repaired).toMatchObject({
      removedMetadata: 1,
      fixedCoverModels: 1,
      removedCoverRefs: 1,
      movedOrphanCovers: 1,
    })
    expect(getMaintenanceState()).toBeNull()

    // 收尾：释放挂起写入（错误降级为日志），等待补写落定后清理重试定时器
    awHook.hangPrefix = null
    for (const p of awHook.pending.splice(0)) {
      p.reject(new Error('用例收尾：释放挂起写入'))
    }
    setFlushAwaitTimeoutForTests()
    await new Promise((resolve) => setImmediate(resolve))
    await flushStoreSave()
    if (metaState.offlineRetryTimer) {
      clearTimeout(metaState.offlineRetryTimer)
      metaState.offlineRetryTimer = null
    }
    metaState.saveRetryFailures = 0
  })
})
