import { performance } from 'node:perf_hooks'
import logger from '../logger'

/**
 * 关键路径耗时打点（PERF-2 性能观测基线）：
 * 冷启动/切库等用户必经路径的耗时写入按天日志（`[perf]` 前缀便于检索聚合），
 * 与既有扫描耗时打点（scan.js 的 durationMs）共同构成性能基线数据源——
 * 优化决策（如 PERF-1 冷启动链并行化的收益验证）以实测数据为准。
 * 刻意保持最小面：零依赖、零采样、零聚合，先跑通观测再考虑升级。
 */

/**
 * 开始一段耗时观测。
 * @param {string} label 打点名称（如 'models:loadStore'）
 * @param {{warnMs?: number, quiet?: boolean}} [options]
 *   warnMs：达到该耗时改用 warn 级别（默认 Infinity，恒为 info）；
 *   quiet：静默模式——低于 warnMs 完全不写日志（高频路径只报慢任务）
 * @returns {(detail?: string) => number} 结束观测：写日志并返回耗时 ms
 */
export function startPerf(label, { warnMs = Infinity, quiet = false } = {}) {
  const t0 = performance.now()
  return (detail) => {
    const ms = Math.round((performance.now() - t0) * 10) / 10
    if (quiet && ms < warnMs) return ms
    const line = `[perf] ${label} 耗时 ${ms}ms${detail ? `（${detail}）` : ''}`
    if (ms >= warnMs) logger.warn(line)
    else logger.info(line)
    return ms
  }
}
