import { it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import fss from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * hash-worker-pool 单元测试（P1 主进程非阻塞改造）：
 * 与 decorate.test.js 对缩略图链路的「真实实现 + 临时文件」策略一致，
 * 哈希线程池直接以真实 worker 运行（vitest node 环境支持 worker_threads）：
 * - 小文件哈希结果与 node crypto 直接计算一致，进度回调可达终值
 * - 多任务串行 FIFO（并发 1）
 * - AbortSignal：在途取消 / 预先取消 / 队列中取消，均抛 AbortError
 * - 文件不存在报错
 */

import {
  computeFileHashOffThread,
  crashHashWorkerForTests,
  isRetryableHashPoolError,
  resetHashPoolForTests,
} from '../src/main/services/hash-worker-pool'

let dir

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-hashpool-'))
})

afterAll(async () => {
  await resetHashPoolForTests()
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
})

/** 写入内容确定的临时文件并返回其真实 SHA256（hex 小写） */
async function writeFixture(name, content) {
  const abs = path.join(dir, name)
  await fs.writeFile(abs, content)
  const expected = crypto.createHash('sha256').update(content).digest('hex')
  return { abs, expected }
}

it('后台线程计算的哈希与 node crypto 结果一致，进度可达终值', async () => {
  const { abs, expected } = await writeFixture(
    'a.bin',
    Buffer.from('modelvault-hash-worker'),
  )

  const progress = []
  const hash = await computeFileHashOffThread(abs, undefined, (hashed, total) =>
    progress.push([hashed, total]),
  )

  expect(hash).toBe(expected)
  expect(progress.length).toBeGreaterThan(0)
  expect(progress[progress.length - 1][0]).toBe(fss.statSync(abs).size)
})

it('多任务串行执行：按入队顺序逐个完成（并发 1）', async () => {
  const a = await writeFixture('b.bin', Buffer.from('task-one'))
  const b = await writeFixture('c.bin', Buffer.from('task-two'))

  const order = []
  const pa = computeFileHashOffThread(a.abs).then((h) => {
    order.push('a')
    return h
  })
  const pb = computeFileHashOffThread(b.abs).then((h) => {
    order.push('b')
    return h
  })

  const [ha, hb] = await Promise.all([pa, pb])
  expect(ha).toBe(a.expected)
  expect(hb).toBe(b.expected)
  expect(order).toEqual(['a', 'b'])
})

it('前台优先级任务先于已排队的后台任务执行', async () => {
  const a = await writeFixture('p1.bin', Buffer.from('foreground-a'))
  const b = await writeFixture('p2.bin', Buffer.from('background-b'))
  const c = await writeFixture('p3.bin', Buffer.from('foreground-c'))

  const order = []
  // a 先占用 current（前台）；b 为后台排队；c 为前台插队。
  // a 完成前 b/c 已同步入队，故 c 必须越过 b 先执行。
  const pa = computeFileHashOffThread(a.abs, undefined, undefined, {
    priority: true,
  }).then((h) => {
    order.push('a')
    return h
  })
  const pb = computeFileHashOffThread(b.abs).then((h) => {
    order.push('b')
    return h
  })
  const pc = computeFileHashOffThread(c.abs, undefined, undefined, {
    priority: true,
  }).then((h) => {
    order.push('c')
    return h
  })

  const [ha, hb, hc] = await Promise.all([pa, pb, pc])
  expect(ha).toBe(a.expected)
  expect(hb).toBe(b.expected)
  expect(hc).toBe(c.expected)
  expect(order).toEqual(['a', 'c', 'b'])
})

it('前台任务抢占在途后台任务：后台任务以 PreemptedError 让路', async () => {
  // 64MB 大文件包含多个 8MB 读块，worker 会在块边界检查 abort：
  // 前台任务入队后后台任务必须中止并让出唯一执行位。
  const big = await writeFixture(
    'preempt-big.bin',
    Buffer.alloc(64 * 1024 * 1024, 1),
  )
  const small = await writeFixture(
    'preempt-small.bin',
    Buffer.from('front-task'),
  )

  const background = computeFileHashOffThread(big.abs)
  const backgroundOutcome = background.then(
    () => 'resolved',
    (err) => err,
  )
  const foreground = computeFileHashOffThread(small.abs, undefined, undefined, {
    priority: true,
  })

  await expect(foreground).resolves.toBe(small.expected)
  expect(await backgroundOutcome).toMatchObject({ name: 'PreemptedError' })
})

it('在途任务取消：立即 reject AbortError（同步 abort，不依赖读块时序）', async () => {
  const { abs } = await writeFixture('d.bin', Buffer.alloc(1024, 7))
  const controller = new AbortController()
  const p = computeFileHashOffThread(abs, controller.signal)
  // pump 同步派发（任务已成 current），此刻 abort 必走在途取消分支
  controller.abort()
  await expect(p).rejects.toMatchObject({ name: 'AbortError' })
})

it('调用前 signal 已取消：直接 AbortError，不派发任务', async () => {
  const { abs } = await writeFixture('e.bin', Buffer.from('never-read'))
  const controller = new AbortController()
  controller.abort()
  await expect(
    computeFileHashOffThread(abs, controller.signal),
  ).rejects.toMatchObject({
    name: 'AbortError',
  })
})

it('队列中任务取消：reject AbortError 且不影响队头任务完成', async () => {
  const a = await writeFixture('f.bin', Buffer.from('head-task'))
  const b = await writeFixture('g.bin', Buffer.from('queued-task'))

  const controller = new AbortController()
  const pa = computeFileHashOffThread(a.abs)
  // a 已同步占位 current，b 必在队列中；取消时序无关紧要（两种分支都抛 AbortError）
  const pb = computeFileHashOffThread(b.abs, controller.signal)
  // 立即捕获 pb 的结算结果：其 rejection 发生在 abort() 同步路径上，
  // 处理器必须先于 pa 完成前挂上，避免 unhandledRejection
  const pbOutcome = pb.then(
    () => 'resolved',
    (err) => err,
  )
  controller.abort()

  await expect(pa).resolves.toBe(a.expected)
  expect(await pbOutcome).toMatchObject({ name: 'AbortError' })
})

it('文件不存在：reject 且不中断后续任务', async () => {
  const missing = path.join(dir, 'missing.bin')
  await expect(computeFileHashOffThread(missing)).rejects.toThrow()
  const { abs, expected } = await writeFixture(
    'h.bin',
    Buffer.from('after-crash'),
  )
  await expect(computeFileHashOffThread(abs)).resolves.toBe(expected)
})

it('可重试错误识别：仅 worker 崩溃/不可用与临时文件错误', () => {
  expect(isRetryableHashPoolError({ name: 'WorkerCrashError' })).toBe(true)
  expect(isRetryableHashPoolError({ name: 'WorkerUnavailableError' })).toBe(
    true,
  )
  expect(isRetryableHashPoolError({ code: 'EBUSY' })).toBe(true)
  expect(isRetryableHashPoolError({ code: 'ENOENT' })).toBe(false)
  expect(isRetryableHashPoolError({ name: 'AbortError' })).toBe(false)
  expect(isRetryableHashPoolError(null)).toBe(false)
})

it('worker 崩溃：当前任务以 WorkerCrashError 拒绝，排队任务重建后继续完成', async () => {
  // 64MB 多读块文件确保崩溃发生在任务执行中，而不是恰好已完成
  const big = await writeFixture(
    'crash-big.bin',
    Buffer.alloc(64 * 1024 * 1024, 5),
  )
  const small = await writeFixture(
    'crash-small.bin',
    Buffer.from('after-worker-crash'),
  )

  let progressStarted = false
  const first = computeFileHashOffThread(big.abs, undefined, () => {
    progressStarted = true
  })
  const firstOutcome = first.then(
    () => 'resolved',
    (err) => err,
  )
  // 第二个任务进入队列；崩溃后必须保留并在新 worker 中完成
  const second = computeFileHashOffThread(small.abs)

  const deadline = Date.now() + 3000
  while (!progressStarted && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(progressStarted).toBe(true)
  expect(crashHashWorkerForTests()).toBe(true)

  const crashErr = await firstOutcome
  expect(crashErr).toMatchObject({ name: 'WorkerCrashError' })
  await expect(second).resolves.toBe(small.expected)

  // 重启后线程池仍可继续服务
  const next = await writeFixture('crash-next.bin', Buffer.from('next-task'))
  await expect(computeFileHashOffThread(next.abs)).resolves.toBe(next.expected)
})
