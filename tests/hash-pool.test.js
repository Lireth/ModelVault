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
  resetHashPoolForTests
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
  const { abs, expected } = await writeFixture('a.bin', Buffer.from('modelvault-hash-worker'))

  const progress = []
  const hash = await computeFileHashOffThread(abs, undefined, (hashed, total) =>
    progress.push([hashed, total])
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
  await expect(computeFileHashOffThread(abs, controller.signal)).rejects.toMatchObject({
    name: 'AbortError'
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
    (err) => err
  )
  controller.abort()

  await expect(pa).resolves.toBe(a.expected)
  expect(await pbOutcome).toMatchObject({ name: 'AbortError' })
})

it('文件不存在：reject 且不中断后续任务', async () => {
  const missing = path.join(dir, 'missing.bin')
  await expect(computeFileHashOffThread(missing)).rejects.toThrow()
  const { abs, expected } = await writeFixture('h.bin', Buffer.from('after-crash'))
  await expect(computeFileHashOffThread(abs)).resolves.toBe(expected)
})
