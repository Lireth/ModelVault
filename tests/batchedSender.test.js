import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createBatchedSender } from '../src/main/ipc/models/batched-sender'

/**
 * 事件窗口合批发送器单元测试（OPT-22）：
 * decorate（缩略图就绪，单窗口上下文）与 civitai（哈希完成，广播）两份
 * 逐行同构的「时间窗 + 阈值 + 单飞定时器 + 强制刷新」机器收敛后的单一实现。
 */

describe('createBatchedSender', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('时间窗内累积多条，窗后合并为一次投递', async () => {
    const delivered = []
    const sender = createBatchedSender({
      flushMs: 120,
      maxBatch: 100,
      deliver: (items) => delivered.push(items),
    })
    sender.push('a')
    sender.push('b')
    sender.push('c')
    expect(delivered).toEqual([])

    await vi.advanceTimersByTimeAsync(120)
    expect(delivered).toEqual([['a', 'b', 'c']])
    // 窗口后再次推进：无新批次不重复投递
    await vi.advanceTimersByTimeAsync(120)
    expect(delivered).toEqual([['a', 'b', 'c']])
  })

  it('达到阈值立即投递，不等时间窗', async () => {
    const delivered = []
    const sender = createBatchedSender({
      flushMs: 120,
      maxBatch: 3,
      deliver: (items) => delivered.push(items),
    })
    sender.push('a')
    sender.push('b')
    expect(delivered).toEqual([])
    sender.push('c')
    expect(delivered).toEqual([['a', 'b', 'c']])
    // 阈值发送后新批次重新计时
    sender.push('d')
    expect(delivered).toEqual([['a', 'b', 'c']])
    await vi.advanceTimersByTimeAsync(120)
    expect(delivered).toEqual([['a', 'b', 'c'], ['d']])
  })

  it('push 数组时整批入队，阈值按条数判定', () => {
    const delivered = []
    const sender = createBatchedSender({
      flushMs: 120,
      maxBatch: 4,
      deliver: (items) => delivered.push(items),
    })
    sender.push(['a', 'b'])
    sender.push(['c'])
    // 2 + 1 = 3 < 4：未触发阈值
    expect(delivered).toEqual([])
    sender.push(['d'])
    // 4 条达到阈值：立即投递
    expect(delivered).toEqual([['a', 'b', 'c', 'd']])
  })

  it('ctx 变化先刷新既有批次再开新批（多窗口不错投语义）', async () => {
    const delivered = []
    const sender = createBatchedSender({
      flushMs: 120,
      maxBatch: 100,
      deliver: (items, ctx) => delivered.push([ctx, items]),
    })
    sender.push('a', 'win1')
    sender.push('b', 'win1')
    sender.push('c', 'win2')
    // win1 的批次在切换前已送达，'c' 属于 win2 的新批次
    expect(delivered).toEqual([['win1', ['a', 'b']]])
    await vi.advanceTimersByTimeAsync(120)
    expect(delivered).toEqual([
      ['win1', ['a', 'b']],
      ['win2', ['c']],
    ])
  })

  it('flush 强制投递；空批与重复 flush 安全', () => {
    const delivered = []
    const sender = createBatchedSender({
      flushMs: 120,
      maxBatch: 100,
      deliver: (items) => delivered.push(items),
    })
    sender.flush()
    expect(delivered).toEqual([])
    sender.push('a')
    sender.flush()
    sender.flush()
    expect(delivered).toEqual([['a']])
    // flush 后再推进时钟：定时器已清，不重复投递
    return vi.advanceTimersByTimeAsync(120).then(() => {
      expect(delivered).toEqual([['a']])
    })
  })

  it('drop 丢弃未发送批次且不再投递（切根失效场景）', async () => {
    const delivered = []
    const sender = createBatchedSender({
      flushMs: 120,
      maxBatch: 100,
      deliver: (items) => delivered.push(items),
    })
    sender.push('a')
    sender.push('b')
    expect(sender.size()).toBe(2)
    sender.drop()
    expect(sender.size()).toBe(0)
    await vi.advanceTimersByTimeAsync(120)
    expect(delivered).toEqual([])
    // drop 后可继续正常使用
    sender.push('c')
    await vi.advanceTimersByTimeAsync(120)
    expect(delivered).toEqual([['c']])
  })

  it('多次 push 共用单飞定时器（不随条数累加）', async () => {
    const delivered = []
    const sender = createBatchedSender({
      flushMs: 120,
      maxBatch: 100,
      deliver: (items) => delivered.push(items),
    })
    sender.push('a')
    // 第一窗的中途再 push：仍按首个定时器到期一次投递
    await vi.advanceTimersByTimeAsync(60)
    sender.push('b')
    await vi.advanceTimersByTimeAsync(60)
    // 距首push 120ms：到期投递（b 的 60ms 窗口被单飞定时器合并）
    expect(delivered).toEqual([['a', 'b']])
  })
})
