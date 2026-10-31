import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fakeUserData } from './setup'

/**
 * hash-warmup.js 服务层单元测试（Civitai 识别加速的后台哈希预热）：
 * electron 以全局最小桩提供，store 服务走真实临时目录，
 * 仅 mock computeFileHash（控制哈希结果与调用计数，避免真实大文件哈希）：
 * - computeAndCacheHash：写缓存时合并既有元数据、并发同 mtime 共享计算
 * - requestHashWarmup：缓存有效跳过、文件缺失跳过、去重、优先插队
 * - 暂停/恢复：扫描期间不取队，恢复后继续
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
}))

vi.mock('../src/main/services/civitai', () => ({
  computeFileHash: vi.fn(),
}))

import { computeFileHash } from '../src/main/services/civitai'
import {
  computeAndCacheHash,
  pauseHashWarmup,
  requestHashWarmup,
  resetHashWarmupForTests,
  resumeHashWarmup,
  setHashFailRetryBaseForTests,
  setHashRetryDelayForTests,
  setWarmupProgressListener,
  whenWarmupIdle,
} from '../src/main/services/hash-warmup'
import {
  getModelMeta,
  loadData,
  setDataRoot,
  setModelMeta,
} from '../src/main/services/store'

/** 64 位十六进制假哈希（按调用序号变化便于区分） */
function fakeHash(n) {
  return n.toString(16).padStart(4, '0') + 'a'.repeat(60)
}

let root
const roots = []

beforeEach(async () => {
  vi.clearAllMocks()
  resetHashWarmupForTests()
  setHashRetryDelayForTests(0)
  setWarmupProgressListener(null)
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-warmup-'))
  roots.push(root)
  setDataRoot(root)
  await loadData()
})

afterEach(async () => {
  resetHashWarmupForTests()
  setHashRetryDelayForTests(300)
  for (const dir of roots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

/** 在临时根目录创建模型文件并返回绝对路径（模型 id） */
async function makeModel(name, content = 'x'.repeat(1024)) {
  const id = path.join(root, name)
  await fs.writeFile(id, content)
  return id
}

describe('computeAndCacheHash', () => {
  it('计算哈希并回写缓存，保留哈希期间已有的其他元数据字段', async () => {
    const id = await makeModel('a.safetensors')
    const { mtimeMs } = await fs.stat(id)
    // 模拟用户在元数据中已有标注（并发保存场景）
    setModelMeta(id, { note: '用户备注' })
    computeFileHash.mockResolvedValue(fakeHash(1))

    const hash = await computeAndCacheHash(id, mtimeMs)
    expect(hash).toBe(fakeHash(1))
    expect(computeFileHash).toHaveBeenCalledTimes(1)
    const meta = getModelMeta(id)
    expect(meta.hash).toBe(fakeHash(1))
    expect(meta.hashMtime).toBe(mtimeMs)
    expect(meta.note).toBe('用户备注')
  })

  it('同 id 同 mtime 的并发调用共享同一计算（只读盘一次）', async () => {
    const id = await makeModel('b.safetensors')
    const { mtimeMs } = await fs.stat(id)
    // 受控延迟：两个调用落在计算完成之前
    let release
    computeFileHash.mockReturnValue(
      new Promise((r) => {
        release = () => r(fakeHash(2))
      }),
    )

    const p1 = computeAndCacheHash(id, mtimeMs)
    const p2 = computeAndCacheHash(id, mtimeMs)
    release()
    expect(await p1).toBe(fakeHash(2))
    expect(await p2).toBe(fakeHash(2))
    expect(computeFileHash).toHaveBeenCalledTimes(1)
  })

  it('mtime 变化（文件更新后）重新计算', async () => {
    const id = await makeModel('c.safetensors')
    const t1 = (await fs.stat(id)).mtimeMs
    computeFileHash.mockResolvedValueOnce(fakeHash(1))
    await computeAndCacheHash(id, t1)
    // 文件被覆盖更新：显式前移 mtime（NTFS 对快速连续写入的 mtime 更新
    // 是惰性的，utimes 保证确定性）
    await fs.writeFile(id, 'z'.repeat(2048))
    await fs.utimes(id, new Date(), new Date(Date.now() + 8000))
    const t2 = (await fs.stat(id)).mtimeMs
    expect(t2).not.toBe(t1)
    computeFileHash.mockResolvedValueOnce(fakeHash(2))
    await computeAndCacheHash(id, t2)
    expect(computeFileHash).toHaveBeenCalledTimes(2)
    expect(getModelMeta(id).hashMtime).toBe(t2)
  })

  it('计算失败时拒绝且不写缓存', async () => {
    const id = await makeModel('d.safetensors')
    computeFileHash.mockRejectedValueOnce(new Error('磁盘错误'))
    await expect(computeAndCacheHash(id, 1000)).rejects.toThrow('磁盘错误')
    expect(getModelMeta(id)?.hash).toBeUndefined()
  })

  it('priority 透传到线程池前台通道', async () => {
    const id = await makeModel('priority.safetensors')
    const { mtimeMs } = await fs.stat(id)
    computeFileHash.mockResolvedValue(fakeHash(30))
    await computeAndCacheHash(id, mtimeMs, { priority: true })
    expect(computeFileHash).toHaveBeenCalledWith(
      id,
      undefined,
      expect.any(Function),
      { priority: true },
    )
  })

  it('OPT-05：线程池临时崩溃后自动重试并完成，进度在重试前复位', async () => {
    const id = await makeModel('retry-crash.safetensors')
    const { mtimeMs } = await fs.stat(id)
    const crash = Object.assign(new Error('worker crashed'), {
      name: 'WorkerCrashError',
    })
    computeFileHash
      .mockRejectedValueOnce(crash)
      .mockResolvedValueOnce(fakeHash(40))
    const events = []
    setWarmupProgressListener((p) => events.push({ ...p }))

    await expect(computeAndCacheHash(id, mtimeMs)).resolves.toBe(fakeHash(40))
    expect(computeFileHash).toHaveBeenCalledTimes(2)
    expect(getModelMeta(id).hash).toBe(fakeHash(40))
    // 重试前推送 active + percent=0，避免界面停在失败尝试的旧百分比
    expect(
      events.some((e) => e.active === true && e.id === id && e.percent === 0),
    ).toBe(true)
  })

  it('OPT-05：线程池持续不可用时重试耗尽，失败且不写缓存', async () => {
    const id = await makeModel('retry-exhausted.safetensors')
    const { mtimeMs } = await fs.stat(id)
    const crash = Object.assign(new Error('worker unavailable'), {
      name: 'WorkerUnavailableError',
    })
    computeFileHash.mockRejectedValue(crash)

    await expect(computeAndCacheHash(id, mtimeMs)).rejects.toMatchObject({
      name: 'WorkerUnavailableError',
    })
    // 初始 1 次 + 重试 2 次
    expect(computeFileHash).toHaveBeenCalledTimes(3)
    expect(getModelMeta(id)?.hash).toBeUndefined()
  })

  it('版本竞态：计算期间文件被覆盖（mtime 前移）时抛错且不写缓存', async () => {
    const id = await makeModel('race-overwrite.safetensors')
    const { mtimeMs } = await fs.stat(id)
    // 在「哈希计算」内部模拟同名覆盖写入——此时算得的哈希对应旧版本或
    // 新旧混合内容，写入缓存会让识别链路反查到错误的模型版本。
    // utimes 显式前移 mtime（NTFS 快速连续写入的 mtime 更新是惰性的）
    computeFileHash.mockImplementation(async () => {
      await fs.writeFile(id, 'y'.repeat(4096))
      await fs.utimes(id, new Date(), new Date(Date.now() + 10000))
      return fakeHash(50)
    })

    await expect(computeAndCacheHash(id, mtimeMs)).rejects.toThrow('文件被修改')
    expect(getModelMeta(id)?.hash).toBeUndefined()
    expect(getModelMeta(id)?.hashMtime).toBeUndefined()
  })

  it('版本竞态：计算期间文件被删除时同样丢弃结果不写缓存', async () => {
    const id = await makeModel('race-delete.safetensors')
    const { mtimeMs } = await fs.stat(id)
    computeFileHash.mockImplementation(async () => {
      await fs.rm(id)
      return fakeHash(51)
    })

    await expect(computeAndCacheHash(id, mtimeMs)).rejects.toThrow('移动或删除')
    expect(getModelMeta(id)?.hash).toBeUndefined()
  })

  it('版本竞态：调用方传入的 mtime 已过期时拒绝写缓存（修复前会落盘旧版本哈希）', async () => {
    const id = await makeModel('race-stale.safetensors')
    const { mtimeMs } = await fs.stat(id)
    computeFileHash.mockResolvedValue(fakeHash(52))

    await expect(computeAndCacheHash(id, mtimeMs + 5000)).rejects.toThrow(
      '文件被修改',
    )
    expect(getModelMeta(id)?.hash).toBeUndefined()
  })
})

describe('requestHashWarmup（队列消费）', () => {
  it('预热缺失缓存的模型：计算并回写缓存', async () => {
    const a = await makeModel('w1.safetensors')
    computeFileHash.mockImplementation(async () => fakeHash(1))
    requestHashWarmup([a], { delayMs: 0 })
    await whenWarmupIdle()
    expect(computeFileHash).toHaveBeenCalledTimes(1)
    expect(getModelMeta(a).hash).toBe(fakeHash(1))
  })

  it('缓存有效的模型跳过计算', async () => {
    const a = await makeModel('w2.safetensors')
    const { mtimeMs } = await fs.stat(a)
    setModelMeta(a, { hash: fakeHash(9), hashMtime: mtimeMs })
    requestHashWarmup([a], { delayMs: 0 })
    await whenWarmupIdle()
    expect(computeFileHash).not.toHaveBeenCalled()
  })

  it('full 模式携带 mtime 的缓存有效条目免入队（零 stat，P1-2）', async () => {
    const a = await makeModel('w2b.safetensors')
    const b = await makeModel('w2c.safetensors')
    const sa = await fs.stat(a)
    const sb = await fs.stat(b)
    // a 缓存有效；b 无缓存——只有 b 应入队计算
    setModelMeta(a, { hash: fakeHash(11), hashMtime: sa.mtimeMs })
    computeFileHash.mockResolvedValue(fakeHash(12))
    const statSpy = vi.spyOn(fs, 'stat')
    try {
      requestHashWarmup(
        [
          { id: a, size: sa.size, mtimeMs: sa.mtimeMs },
          { id: b, size: sb.size, mtimeMs: sb.mtimeMs },
        ],
        { mode: 'full', full: true, delayMs: 0 },
      )
      await whenWarmupIdle()
      expect(computeFileHash).toHaveBeenCalledTimes(1)
      expect(computeFileHash.mock.calls[0][0]).toBe(b)
      // 缓存有效的 a 在入队侧被过滤：drain 不再为其发起 stat 复核；
      // b 的两次 stat 分别来自 drain 出队复核与 computeAndCacheHash
      // 完成后的版本竞态复查（mtime 未变 → 缓存写入）
      expect(statSpy.mock.calls.map((c) => c[0])).toEqual([b, b])
    } finally {
      statSpy.mockRestore()
    }
  })

  it('裸 id（mtime 未知）在 full 模式仍保守入队，由 drain stat 复核（P1-2 行为锁定）', async () => {
    const a = await makeModel('w2d.safetensors')
    const { mtimeMs } = await fs.stat(a)
    setModelMeta(a, { hash: fakeHash(13), hashMtime: mtimeMs })
    const statSpy = vi.spyOn(fs, 'stat')
    try {
      requestHashWarmup([a], { mode: 'full', full: true, delayMs: 0 })
      await whenWarmupIdle()
      // 无 mtime 信息时不能断言缓存有效：入队后经实时 stat 复核跳过
      expect(statSpy.mock.calls.map((c) => c[0])).toEqual([a])
      expect(computeFileHash).not.toHaveBeenCalled()
    } finally {
      statSpy.mockRestore()
    }
  })

  it('文件已删除的模型静默跳过，不中断队列', async () => {
    const gone = path.join(root, 'gone.safetensors')
    const alive = await makeModel('alive.safetensors')
    computeFileHash.mockResolvedValue(fakeHash(3))
    requestHashWarmup([gone, alive], { delayMs: 0 })
    await whenWarmupIdle()
    expect(getModelMeta(alive).hash).toBe(fakeHash(3))
  })

  it('重复入队去重，同一模型只计算一次', async () => {
    const a = await makeModel('w4.safetensors')
    computeFileHash.mockResolvedValue(fakeHash(4))
    requestHashWarmup([a, a, a], { delayMs: 0 })
    await whenWarmupIdle()
    expect(computeFileHash).toHaveBeenCalledTimes(1)
  })

  it('优先任务插队：详情页打开的模型先于批量队列处理', async () => {
    const batch = []
    for (let i = 0; i < 3; i++)
      batch.push(await makeModel(`batch${i}.safetensors`))
    const hot = await makeModel('hot.safetensors')
    computeFileHash.mockImplementation(async () => fakeHash(5))
    requestHashWarmup(batch, { delayMs: 0 })
    requestHashWarmup([hot], { priority: true })
    await whenWarmupIdle()
    const firstComputed = computeFileHash.mock.calls[0][0]
    expect(firstComputed).toBe(hot)
    expect(computeFileHash).toHaveBeenCalledTimes(4)
  })

  it('预热与识别链路共享进行中任务：不重复计算', async () => {
    const a = await makeModel('w6.safetensors')
    const { mtimeMs } = await fs.stat(a)
    let release
    computeFileHash.mockImplementation(
      () =>
        new Promise((r) => {
          release = () => r(fakeHash(6))
        }),
    )
    // 识别链路先发起计算（进行中），随后批量预热入队同一模型
    const identifyPromise = computeAndCacheHash(a, mtimeMs)
    requestHashWarmup([a], { delayMs: 0 })
    release()
    await identifyPromise
    await whenWarmupIdle()
    expect(computeFileHash).toHaveBeenCalledTimes(1)
    expect(getModelMeta(a).hash).toBe(fakeHash(6))
  })
})

describe('预热并发（OPT-3）', () => {
  /** 挂起式 computeFileHash 替身：resolve 时机由用例控制 */
  function deferredHash() {
    let resolve
    const promise = new Promise((r) => {
      resolve = r
    })
    return { promise, resolve }
  }

  it('concurrency=2 时两条 lane 并行消费，且不超过并发上限', async () => {
    const a = await makeModel('cc-a.safetensors')
    const b = await makeModel('cc-b.safetensors')
    const c = await makeModel('cc-c.safetensors')
    const d1 = deferredHash()
    const d2 = deferredHash()
    const d3 = deferredHash()
    const deferreds = [d1, d2, d3]
    let call = 0
    computeFileHash.mockImplementation(() => deferreds[call++].promise)

    requestHashWarmup([a, b, c], {
      mode: 'full',
      concurrency: 2,
      delayMs: 0,
    })
    // 两条 lane 同时取队：前两个计算启动，第三个受并发上限约束不启动
    await vi.waitFor(() => expect(computeFileHash).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r, 20))
    expect(computeFileHash).toHaveBeenCalledTimes(2)

    // 任一 lane 完成（d1 供第一个启动的计算）后，第三个任务立即补位
    deferreds[0].resolve(fakeHash(1))
    await vi.waitFor(() => expect(computeFileHash).toHaveBeenCalledTimes(3))
    deferreds[1].resolve(fakeHash(2))
    deferreds[2].resolve(fakeHash(3))
    await whenWarmupIdle()
    expect(getModelMeta(a).hash).toBeTruthy()
    expect(getModelMeta(b).hash).toBeTruthy()
    expect(getModelMeta(c).hash).toBe(fakeHash(3))
  })

  it('缺省（未传 concurrency）保持串行：前一计算未完成时后续不启动', async () => {
    const a = await makeModel('cs-a.safetensors')
    const b = await makeModel('cs-b.safetensors')
    const d1 = deferredHash()
    const d2 = deferredHash()
    const deferreds = [d1, d2]
    let call = 0
    computeFileHash.mockImplementation(() => deferreds[call++].promise)

    requestHashWarmup([a, b], { mode: 'full', delayMs: 0 })
    await vi.waitFor(() => expect(computeFileHash).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 20))
    expect(computeFileHash).toHaveBeenCalledTimes(1)

    d1.resolve(fakeHash(1))
    await vi.waitFor(() => expect(computeFileHash).toHaveBeenCalledTimes(2))
    d2.resolve(fakeHash(2))
    await whenWarmupIdle()
    expect(getModelMeta(b).hash).toBe(fakeHash(2))
  })
})

describe('哈希预热策略（O1：体积预筛 + 按需计算）', () => {
  it('candidates：只计算同尺寸模型，体积唯一的模型不读盘哈希', async () => {
    const a = await makeModel('c1.safetensors', 'a'.repeat(1024))
    const b = await makeModel('c2.safetensors', 'b'.repeat(1024))
    const unique = await makeModel('c3.safetensors', 'u'.repeat(2048))
    computeFileHash.mockResolvedValue(fakeHash(11))
    const stats = await Promise.all([a, b, unique].map((id) => fs.stat(id)))

    requestHashWarmup(
      [
        { id: a, size: stats[0].size, mtimeMs: stats[0].mtimeMs },
        { id: b, size: stats[1].size, mtimeMs: stats[1].mtimeMs },
        { id: unique, size: stats[2].size, mtimeMs: stats[2].mtimeMs },
      ],
      { mode: 'candidates', full: true, delayMs: 0 },
    )
    await whenWarmupIdle()

    expect(computeFileHash).toHaveBeenCalledTimes(2)
    expect(computeFileHash.mock.calls.map((call) => call[0]).sort()).toEqual(
      [a, b].sort(),
    )
    expect(getModelMeta(unique)).toBeNull()
  })

  it('candidates：后续请求发现同尺寸文件时，补算先前因体积唯一而跳过的模型', async () => {
    const a = await makeModel('c4.safetensors', 'a'.repeat(1024))
    const b = await makeModel('c5.safetensors', 'b'.repeat(1024))
    computeFileHash.mockResolvedValue(fakeHash(12))
    const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)])

    // 第一次请求：体积唯一，不产生哈希任务
    requestHashWarmup([{ id: a, size: sa.size, mtimeMs: sa.mtimeMs }], {
      mode: 'candidates',
      full: true,
      delayMs: 0,
    })
    await whenWarmupIdle()
    expect(computeFileHash).not.toHaveBeenCalled()

    // 第二次请求：同尺寸文件出现，两份都应补算
    requestHashWarmup([{ id: b, size: sb.size, mtimeMs: sb.mtimeMs }], {
      mode: 'candidates',
      full: false,
      delayMs: 0,
    })
    await whenWarmupIdle()

    expect(computeFileHash).toHaveBeenCalledTimes(2)
    expect(getModelMeta(a).hash).toBe(fakeHash(12))
    expect(getModelMeta(b).hash).toBe(fakeHash(12))
  })

  it('off：后台不入队，但详情页优先任务仍按需计算', async () => {
    const a = await makeModel('c6.safetensors', 'a'.repeat(1024))
    const b = await makeModel('c7.safetensors', 'b'.repeat(1024))
    computeFileHash.mockResolvedValue(fakeHash(13))

    requestHashWarmup([a, b], { mode: 'off', full: true, delayMs: 0 })
    await whenWarmupIdle()
    expect(computeFileHash).not.toHaveBeenCalled()

    requestHashWarmup([a], { priority: true })
    await whenWarmupIdle()
    expect(computeFileHash).toHaveBeenCalledTimes(1)
    expect(computeFileHash.mock.calls[0][0]).toBe(a)
  })

  it('candidates：体积未知时先 stat 再判定（同尺寸计算、唯一跳过）', async () => {
    const a = await makeModel('c12.safetensors', 'a'.repeat(1024))
    const b = await makeModel('c13.safetensors', 'b'.repeat(1024))
    const unique = await makeModel('c14.safetensors', 'u'.repeat(2048))
    computeFileHash.mockResolvedValue(fakeHash(16))

    requestHashWarmup([a, b, unique], {
      mode: 'candidates',
      full: true,
      delayMs: 0,
    })
    await whenWarmupIdle()

    expect(computeFileHash).toHaveBeenCalledTimes(2)
    expect(computeFileHash.mock.calls.map((call) => call[0]).sort()).toEqual(
      [a, b].sort(),
    )
    expect(getModelMeta(unique)).toBeNull()
  })

  it('candidates：缓存有效的同尺寸伙伴不再重复计算', async () => {
    const a = await makeModel('c15.safetensors', 'a'.repeat(1024))
    const b = await makeModel('c16.safetensors', 'b'.repeat(1024))
    const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)])
    setModelMeta(a, { hash: fakeHash(17), hashMtime: sa.mtimeMs })
    computeFileHash.mockResolvedValue(fakeHash(18))

    requestHashWarmup(
      [
        { id: a, size: sa.size, mtimeMs: sa.mtimeMs },
        { id: b, size: sb.size, mtimeMs: sb.mtimeMs },
      ],
      { mode: 'candidates', full: true, delayMs: 0 },
    )
    await whenWarmupIdle()

    expect(computeFileHash).toHaveBeenCalledTimes(1)
    expect(computeFileHash.mock.calls[0][0]).toBe(b)
    expect(getModelMeta(a).hash).toBe(fakeHash(17))
  })

  it('未知策略值回退 full（服务层兼容既有调用方）', async () => {
    const a = await makeModel('c17.safetensors', 'a'.repeat(1024))
    computeFileHash.mockResolvedValue(fakeHash(19))

    requestHashWarmup([a], { mode: 'turbo', full: true, delayMs: 0 })
    await whenWarmupIdle()

    expect(computeFileHash).toHaveBeenCalledTimes(1)
  })

  it('全量快照作废后台任务时保留详情页优先任务', async () => {
    const hot = await makeModel('c18.safetensors', 'h'.repeat(1024))
    computeFileHash.mockResolvedValue(fakeHash(20))

    pauseHashWarmup()
    requestHashWarmup([hot], { priority: true })
    // 新的全量快照（空列表 + 关闭策略）只应清掉普通后台任务
    requestHashWarmup([], { mode: 'off', full: true })
    resumeHashWarmup(0)
    await whenWarmupIdle()

    expect(computeFileHash).toHaveBeenCalledTimes(1)
    expect(computeFileHash.mock.calls[0][0]).toBe(hot)
  })

  it('后台任务被前台抢占后重新入队，最终仍完成且不记为失败', async () => {
    const a = await makeModel('p1.safetensors')
    const b = await makeModel('p2.safetensors')
    let firstA = true
    computeFileHash.mockImplementation(async (file) => {
      if (file === a && firstA) {
        firstA = false
        const err = new Error('让路')
        err.name = 'PreemptedError'
        throw err
      }
      return file === a ? fakeHash(31) : fakeHash(32)
    })

    requestHashWarmup([a, b], { mode: 'full', full: true, delayMs: 0 })
    await whenWarmupIdle()

    // a 第一次被抢占 → 重新入队到队尾；b 先完成，随后 a 重算完成
    expect(computeFileHash).toHaveBeenCalledTimes(3)
    expect(getModelMeta(a).hash).toBe(fakeHash(31))
    expect(getModelMeta(b).hash).toBe(fakeHash(32))
  })

  it('单个模型哈希失败只记录日志，队列继续处理后续模型', async () => {
    const bad = await makeModel('c19.safetensors', 'a'.repeat(1024))
    const good = await makeModel('c20.safetensors', 'b'.repeat(1024))
    computeFileHash
      .mockRejectedValueOnce(new Error('磁盘读取失败'))
      .mockResolvedValueOnce(fakeHash(21))

    requestHashWarmup([bad, good], { mode: 'full', full: true, delayMs: 0 })
    await whenWarmupIdle()

    expect(computeFileHash).toHaveBeenCalledTimes(2)
    expect(getModelMeta(good).hash).toBe(fakeHash(21))
  })

  it('切换到 off 的全量请求会作废旧策略尚未开始的排队任务', async () => {
    const a = await makeModel('c10.safetensors', 'a'.repeat(1024))
    const b = await makeModel('c11.safetensors', 'b'.repeat(1024))
    computeFileHash.mockResolvedValue(fakeHash(15))

    pauseHashWarmup()
    requestHashWarmup([a, b], { mode: 'full', full: true, delayMs: 0 })
    // 用户切换为关闭：新的全量请求应丢弃上一策略的后台排队项
    requestHashWarmup([a, b], { mode: 'off', full: true, delayMs: 0 })
    resumeHashWarmup(0)
    await whenWarmupIdle()

    expect(computeFileHash).not.toHaveBeenCalled()
  })

  it('full：体积唯一也全部计算（显式选择旧行为）', async () => {
    const a = await makeModel('c8.safetensors', 'a'.repeat(1024))
    const b = await makeModel('c9.safetensors', 'b'.repeat(2048))
    computeFileHash.mockResolvedValue(fakeHash(14))

    requestHashWarmup([a, b], { mode: 'full', full: true, delayMs: 0 })
    await whenWarmupIdle()
    expect(computeFileHash).toHaveBeenCalledTimes(2)
  })
})

describe('扫描期间暂停/恢复', () => {
  it('暂停期间不入队消费，恢复后继续处理', async () => {
    const a = await makeModel('p1.safetensors')
    const b = await makeModel('p2.safetensors')
    computeFileHash.mockResolvedValue(fakeHash(7))
    pauseHashWarmup()
    requestHashWarmup([a, b], { delayMs: 0 })
    await new Promise((r) => setTimeout(r, 20))
    expect(computeFileHash).not.toHaveBeenCalled()
    resumeHashWarmup(0)
    await whenWarmupIdle()
    expect(computeFileHash).toHaveBeenCalledTimes(2)
    expect(getModelMeta(a).hash).toBe(fakeHash(7))
    expect(getModelMeta(b).hash).toBe(fakeHash(7))
  })
})

describe('进度事件推送', () => {
  /** 临时挂载监听器并收集事件（afterEach 前手动还原） */
  function collectEvents() {
    const events = []
    setWarmupProgressListener((p) => events.push(p))
    return events
  }

  it('computeAndCacheHash 推送开始/进度/完成事件（含百分比与字节数）', async () => {
    const events = collectEvents()
    const id = await makeModel('e1.safetensors')
    const { mtimeMs } = await fs.stat(id)
    computeFileHash.mockImplementation(async (_p, _s, onProgress) => {
      onProgress(100, 200) // 50% 时刻（首个 tick 不节流，必达）
      onProgress(200, 200) // 该 tick 被节流吞掉（间隔 < 300ms）
      return fakeHash(8)
    })
    await computeAndCacheHash(id, mtimeMs)
    // 事件序列：开始（active）→ 进度 tick → 完成（inactive）
    expect(events.length).toBe(3)
    expect(events[0]).toMatchObject({ active: true, id, percent: 0, hash: '' })
    expect(events[1]).toMatchObject({
      active: true,
      id,
      percent: 50,
      hashedBytes: 100,
      totalBytes: 200,
    })
    // FEAT-1：完成事件携带算得的哈希，渲染层据此回填模型对象
    expect(events[2]).toMatchObject({ active: false, id, hash: fakeHash(8) })
  })

  it('预热队列消费时推送队列计数（done 递增 / remaining 递减，清空后归零）', async () => {
    const events = collectEvents()
    const a = await makeModel('e2.safetensors')
    const b = await makeModel('e3.safetensors')
    computeFileHash.mockResolvedValue(fakeHash(9))
    requestHashWarmup([a, b], { delayMs: 0 })
    await whenWarmupIdle()
    // 入队事件（remaining=2）→ 完成事件（done=2, remaining=0）→ 清空事件（done=2）
    expect(events[0]).toMatchObject({ active: false, done: 0, remaining: 2 })
    const afterDrain = events.filter((e) => e.done === 2 && e.remaining === 0)
    expect(afterDrain.length).toBeGreaterThanOrEqual(1)
    // 队列清空后 done 归零，供下一轮批量从 0 计数
    expect(events[events.length - 1]).toMatchObject({
      active: false,
      done: 2,
      remaining: 0,
    })
  })

  it('未注册监听器时推送静默忽略，不影响预热', async () => {
    const id = await makeModel('e4.safetensors')
    computeFileHash.mockResolvedValue(fakeHash(10))
    requestHashWarmup([id], { delayMs: 0 })
    await whenWarmupIdle()
    expect(getModelMeta(id).hash).toBe(fakeHash(10))
  })
})

describe('哈希失败负缓存（OPT-6）', () => {
  it('失败后同版本批量预热静默期内不再读盘重试', async () => {
    const id = await makeModel('bad.safetensors')
    computeFileHash.mockRejectedValue(new Error('EACCES: 文件被占用'))
    await requestHashWarmup([id], { delayMs: 0 })
    await whenWarmupIdle()
    expect(computeFileHash).toHaveBeenCalledTimes(1)

    // 再次全量预热：负缓存命中（同版本静默期未到），不重复读盘——
    // 旧实现每次全量扫描都会把损坏/被占用的 10GB 文件完整读盘失败一遍
    await requestHashWarmup([id], { delayMs: 0, full: true })
    await whenWarmupIdle()
    expect(computeFileHash).toHaveBeenCalledTimes(1)
  })

  it('文件被修改（mtime 变化）后记录自动失效，新版本恢复预热资格', async () => {
    const id = await makeModel('bad.safetensors')
    computeFileHash.mockRejectedValue(new Error('EACCES: 文件被占用'))
    await requestHashWarmup([id], { delayMs: 0 })
    await whenWarmupIdle()
    expect(computeFileHash).toHaveBeenCalledTimes(1)

    // 文件被修改（显式 utimes 保证 mtime 必然变化）：旧失败记录失效，
    // 新版本立即重新获得预热资格并计算成功
    computeFileHash.mockResolvedValue(fakeHash(1))
    const later = new Date(Date.now() + 5000)
    await fs.utimes(id, later, later)
    const { mtimeMs } = await fs.stat(id)
    await requestHashWarmup([{ id, mtimeMs }], { delayMs: 0, full: true })
    await whenWarmupIdle()
    expect(computeFileHash).toHaveBeenCalledTimes(2)
    expect(getModelMeta(id)?.hash).toBe(fakeHash(1))
  })

  it('静默期到期后自动恢复重试（占用释放的自愈通道）', async () => {
    setHashFailRetryBaseForTests(20)
    const id = await makeModel('bad.safetensors')
    computeFileHash.mockRejectedValue(new Error('EBUSY: 资源暂时不可用'))
    await requestHashWarmup([id], { delayMs: 0 })
    await whenWarmupIdle()
    expect(computeFileHash).toHaveBeenCalledTimes(1)

    // 静默期（20ms）到期：再次批量预热重新尝试，本次成功并回写缓存
    computeFileHash.mockResolvedValue(fakeHash(2))
    await new Promise((resolve) => setTimeout(resolve, 50))
    await requestHashWarmup([id], { delayMs: 0, full: true })
    await whenWarmupIdle()
    expect(computeFileHash).toHaveBeenCalledTimes(2)
    expect(getModelMeta(id)?.hash).toBe(fakeHash(2))
  })

  it('priority 按需任务不受负缓存限制，成功即清除失败记录', async () => {
    setHashFailRetryBaseForTests(60000)
    const id = await makeModel('bad.safetensors')
    computeFileHash.mockRejectedValue(new Error('EACCES: 文件被占用'))
    await requestHashWarmup([id], { delayMs: 0 })
    await whenWarmupIdle()
    expect(computeFileHash).toHaveBeenCalledTimes(1)

    // 用户打开详情/点击识别：priority 任务立即重试（不受静默期约束）
    computeFileHash.mockResolvedValue(fakeHash(3))
    await requestHashWarmup([id], { priority: true, delayMs: 0 })
    await whenWarmupIdle()
    expect(computeFileHash).toHaveBeenCalledTimes(2)
    expect(getModelMeta(id)?.hash).toBe(fakeHash(3))

    // 成功后清除失败记录：后续批量预热走缓存有效路径正常跳过
    await requestHashWarmup([id], { delayMs: 0, full: true })
    await whenWarmupIdle()
    expect(computeFileHash).toHaveBeenCalledTimes(2)
  })
})
