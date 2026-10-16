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
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true }
}))

vi.mock('../src/main/services/civitai', () => ({
  computeFileHash: vi.fn()
}))

import { computeFileHash } from '../src/main/services/civitai'
import {
  computeAndCacheHash,
  pauseHashWarmup,
  requestHashWarmup,
  resetHashWarmupForTests,
  resumeHashWarmup,
  whenWarmupIdle
} from '../src/main/services/hash-warmup'
import { getModelMeta, loadData, setDataRoot, setModelMeta } from '../src/main/services/store'

/** 64 位十六进制假哈希（按调用序号变化便于区分） */
function fakeHash(n) {
  return (n.toString(16).padStart(4, '0') + 'a'.repeat(60))
}

let root
const roots = []

beforeEach(async () => {
  vi.clearAllMocks()
  resetHashWarmupForTests()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-warmup-'))
  roots.push(root)
  setDataRoot(root)
  await loadData()
})

afterEach(async () => {
  resetHashWarmupForTests()
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
    computeFileHash.mockReturnValue(new Promise((r) => { release = () => r(fakeHash(2)) }))

    const p1 = computeAndCacheHash(id, mtimeMs)
    const p2 = computeAndCacheHash(id, mtimeMs)
    release()
    expect(await p1).toBe(fakeHash(2))
    expect(await p2).toBe(fakeHash(2))
    expect(computeFileHash).toHaveBeenCalledTimes(1)
  })

  it('mtime 变化（文件更新后）重新计算', async () => {
    const id = await makeModel('c.safetensors')
    computeFileHash.mockResolvedValueOnce(fakeHash(1))
    await computeAndCacheHash(id, 1000)
    computeFileHash.mockResolvedValueOnce(fakeHash(2))
    await computeAndCacheHash(id, 2000)
    expect(computeFileHash).toHaveBeenCalledTimes(2)
    expect(getModelMeta(id).hashMtime).toBe(2000)
  })

  it('计算失败时拒绝且不写缓存', async () => {
    const id = await makeModel('d.safetensors')
    computeFileHash.mockRejectedValueOnce(new Error('磁盘错误'))
    await expect(computeAndCacheHash(id, 1000)).rejects.toThrow('磁盘错误')
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
    for (let i = 0; i < 3; i++) batch.push(await makeModel(`batch${i}.safetensors`))
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
      () => new Promise((r) => { release = () => r(fakeHash(6)) })
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
