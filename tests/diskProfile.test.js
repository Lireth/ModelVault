import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * disk-profile.js 磁盘介质探测单元测试（OP-B 自适应哈希预热并发）：
 * - classifyRandomReadLatency：延迟中位数 → 并发档位的判定阈值（纯函数）；
 * - resolveAdaptiveHashConcurrency：小文件/体积未知跳过探测（不写缓存，
 *   后续大文件仍可正确分类）、真实探测结果合法且按盘符缓存、
 *   探测挂起超预算保守回退串行并缓存（避免每轮 drain 重付预算）、
 *   不同盘符的缓存互相独立。
 * fs.open 经 node:fs/promises 模块桩挂起/计数，其余调用透传真实实现。
 */

// B-1（与 autoBackup.test.js 同款模式）：open 可按路径挂起（模拟内核层
// 阻塞的磁盘 IO）并记录调用次数（缓存命中断言），其余透传真实实现
const { fsHook } = vi.hoisted(() => ({
  fsHook: { openCalls: [], hangOpen: null, pending: [] },
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal()
  const wrapped = {
    ...actual,
    open: (p, flags) => {
      fsHook.openCalls.push(String(p))
      if (fsHook.hangOpen && String(p) === fsHook.hangOpen) {
        return new Promise((resolve, reject) => {
          fsHook.pending.push({ resolve, reject })
        })
      }
      return actual.open(p, flags)
    },
  }
  wrapped.default = wrapped
  return wrapped
})

import {
  classifyRandomReadLatency,
  resolveAdaptiveHashConcurrency,
  resetDiskProfileForTests,
  setDiskProbeTimeoutForTests,
} from '../src/main/services/disk-profile'

const PROBE_MIN_BYTES = 16 * 1024 * 1024
/** 略高于探测下限的稀疏大文件（NTFS 截断即时完成，读零块不实际分配） */
const SPARSE_FILE_BYTES = PROBE_MIN_BYTES + 4 * 1024 * 1024

const roots = []

beforeEach(() => {
  resetDiskProfileForTests()
  fsHook.openCalls.length = 0
  fsHook.hangOpen = null
})

afterEach(async () => {
  resetDiskProfileForTests()
  // 挂起的 open 统一拒绝释放，避免用例泄漏悬挂句柄
  for (const entry of fsHook.pending.splice(0)) {
    entry.reject(new Error('测试收尾释放'))
  }
  for (const dir of roots.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

async function makeRoot(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  roots.push(dir)
  return dir
}

/** 稀疏大文件：truncate 即时完成，读取范围返回零块 */
async function makeSparseBigFile(dir, name = 'probe.safetensors') {
  const p = path.join(dir, name)
  const fh = await fs.open(p, 'w')
  await fh.truncate(SPARSE_FILE_BYTES)
  await fh.close()
  return p
}

describe('classifyRandomReadLatency（判据阈值，纯函数）', () => {
  it('NVMe/SSD：<2ms → 4；SATA SSD：2-8ms → 2；HDD：≥8ms → 1', () => {
    expect(classifyRandomReadLatency(0.05)).toBe(4)
    expect(classifyRandomReadLatency(1.9)).toBe(4)
    expect(classifyRandomReadLatency(2)).toBe(2)
    expect(classifyRandomReadLatency(7.9)).toBe(2)
    expect(classifyRandomReadLatency(8)).toBe(1)
    expect(classifyRandomReadLatency(50)).toBe(1)
  })

  it('非法输入（NaN/负数/Infinity）保守回退串行', () => {
    expect(classifyRandomReadLatency(Number.NaN)).toBe(1)
    expect(classifyRandomReadLatency(-1)).toBe(1)
    expect(classifyRandomReadLatency(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

describe('resolveAdaptiveHashConcurrency（探测与缓存）', () => {
  it('体积未知/文件过小：回退串行且不写缓存（后续大文件仍可正确分类）', async () => {
    const dir = await makeRoot('modelvault-disk-small-')
    const small = path.join(dir, 'small.safetensors')
    await fs.writeFile(small, Buffer.alloc(1024))

    expect(await resolveAdaptiveHashConcurrency(small, null)).toBe(1)
    expect(await resolveAdaptiveHashConcurrency(small, 1024)).toBe(1)
    // 未探测 = 未缓存：同路径以合法体积再次调用时真实发起探测
    const opensBefore = fsHook.openCalls.length
    await resolveAdaptiveHashConcurrency(small, SPARSE_FILE_BYTES)
    expect(fsHook.openCalls.length).toBeGreaterThan(opensBefore)
  })

  it('真实探测返回合法档位，同盘第二次调用命中缓存（零新探测）', async () => {
    const dir = await makeRoot('modelvault-disk-probe-')
    const big = await makeSparseBigFile(dir)
    const first = await resolveAdaptiveHashConcurrency(big, SPARSE_FILE_BYTES)
    expect([1, 2, 4]).toContain(first)
    const opensAfterFirst = fsHook.openCalls.length
    const second = await resolveAdaptiveHashConcurrency(big, SPARSE_FILE_BYTES)
    expect(second).toBe(first)
    expect(fsHook.openCalls.length).toBe(opensAfterFirst)
  })

  it('探测挂起超预算：保守回退串行并缓存（后续调用不再重付预算）', async () => {
    setDiskProbeTimeoutForTests(30)
    const dir = await makeRoot('modelvault-disk-hang-')
    const big = await makeSparseBigFile(dir, 'hang.safetensors')
    fsHook.hangOpen = big

    const first = await resolveAdaptiveHashConcurrency(big, SPARSE_FILE_BYTES)
    expect(first).toBe(1)
    // 挂起的 open 已随预算超时进入缓存路径：第二次调用直接命中缓存
    const opensAfterFirst = fsHook.openCalls.length
    expect(await resolveAdaptiveHashConcurrency(big, SPARSE_FILE_BYTES)).toBe(1)
    expect(fsHook.openCalls.length).toBe(opensAfterFirst)
  })

  it('不同盘符的缓存互相独立（C:\\ 真实探测与 Q:\\ 探测失败互不污染）', async () => {
    const dir = await makeRoot('modelvault-disk-multi-')
    const big = await makeSparseBigFile(dir)
    const real = await resolveAdaptiveHashConcurrency(big, SPARSE_FILE_BYTES)
    // 不存在的盘符：open 失败 → 串行；不得影响 C:\\ 缓存值
    const phantom = await resolveAdaptiveHashConcurrency(
      'Q:\\models\\probe.safetensors',
      SPARSE_FILE_BYTES,
    )
    expect(phantom).toBe(1)
    expect(await resolveAdaptiveHashConcurrency(big, SPARSE_FILE_BYTES)).toBe(
      real,
    )
  })
})
