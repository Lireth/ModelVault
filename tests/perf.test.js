import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * startPerf 耗时打点助手（PERF-2 性能观测基线）：
 * - 结束回调返回耗时数值且写 info 日志（默认恒 info）；
 * - warnMs 阈值：达到阈值升级为 warn；
 * - quiet 静默模式：低于阈值不写任何日志（高频路径只报慢任务）；
 * - detail 附加上下文与 [perf] 前缀格式。
 */

// perf.js 依赖 logger（electron app.getPath），由 tests/setup.js 的 electron mock 兜底
const { startPerf } = await import('../src/main/services/perf')
const logger = (await import('../src/main/logger')).default

describe('startPerf 耗时打点（PERF-2）', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'info').mockImplementation(() => {})
    vi.spyOn(logger, 'warn').mockImplementation(() => {})
  })

  it('默认恒为 info 级并返回耗时数值', () => {
    const done = startPerf('test:op')
    const ms = done('完成')
    expect(ms).toBeGreaterThanOrEqual(0)
    expect(logger.info).toHaveBeenCalledTimes(1)
    const line = logger.info.mock.calls[0][0]
    expect(line).toContain('[perf] test:op 耗时')
    expect(line).toContain('（完成）')
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('达到 warnMs 阈值时升级为 warn', () => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(3000)
    const done = startPerf('test:slow', { warnMs: 2000 })
    done()
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.info).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('quiet 模式低于阈值完全静默，超过阈值以 warn 显形', () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(50)
    const doneFast = startPerf('test:thumb', { warnMs: 2000, quiet: true })
    expect(doneFast()).toBeGreaterThanOrEqual(0)
    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()

    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(2500)
    const doneSlow = startPerf('test:thumb', { warnMs: 2000, quiet: true })
    doneSlow('大图')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0][0]).toContain('（大图）')
    vi.restoreAllMocks()
  })

  it('耗时保留一位小数且无 detail 时不含括号段', () => {
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(123.45)
    const done = startPerf('test:prec')
    done()
    expect(logger.info.mock.calls[0][0]).toContain('耗时 123.5ms')
    expect(logger.info.mock.calls[0][0]).not.toContain('（')
    vi.restoreAllMocks()
  })
})
