import { describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import {
  buildLibraryOverview,
  normalizeLibraryRoots
} from '../src/main/services/library-overview'

/**
 * 跨库存储总览聚合（FN-01）：
 * 纯函数测试覆盖 —— 跨库分组、库内重复计数、容量未知回退、索引过期标记。
 */

const ROOT_A = path.join(os.tmpdir(), 'mv-overview-a')
const ROOT_B = path.join(os.tmpdir(), 'mv-overview-b')

function entry(root, rel, hash, size = 0) {
  return {
    absPath: path.join(root, rel),
    relPath: rel,
    name: path.basename(rel),
    size,
    hash
  }
}

function library(root, models, overrides = {}) {
  return {
    root,
    name: path.basename(root),
    exists: true,
    source: 'index',
    savedAt: Date.now(),
    models,
    ...overrides
  }
}

describe('normalizeLibraryRoots', () => {
  it('去空、去重（Windows 大小写不敏感）并保持顺序', () => {
    const lower = ROOT_A.toLowerCase()
    expect(normalizeLibraryRoots([ROOT_A, lower, '', null, ROOT_B])).toEqual([ROOT_A, ROOT_B])
  })
})

describe('buildLibraryOverview', () => {
  it('跨库同哈希聚合：副本数、可释放空间与库内统计', () => {
    const overview = buildLibraryOverview([
      library(ROOT_A, [entry(ROOT_A, 'a.safetensors', 'h1', 100), entry(ROOT_A, 'b.safetensors', 'h2', 50)]),
      library(ROOT_B, [entry(ROOT_B, 'c.safetensors', 'h1', 100)])
    ])

    expect(overview.totals.libraries).toBe(2)
    expect(overview.totals.availableLibraries).toBe(2)
    expect(overview.totals.models).toBe(3)
    expect(overview.totals.knownBytes).toBe(250)
    expect(overview.totals.crossGroups).toBe(1)
    expect(overview.totals.redundantCopies).toBe(1)
    expect(overview.totals.wastedBytes).toBe(100)
    expect(overview.crossLibraryGroups[0].libraries).toBe(2)
    expect(overview.crossLibraryGroups[0].members).toHaveLength(2)
    for (const lib of overview.libraries) expect(lib.localDuplicateGroups).toBe(0)
  })

  it('仅库内重复不进入跨库组，但计数用于指引现有「重复」筛选', () => {
    const overview = buildLibraryOverview([
      library(ROOT_A, [
        entry(ROOT_A, 'x.safetensors', 'local', 10),
        entry(ROOT_A, 'y.safetensors', 'local', 10)
      ])
    ])
    expect(overview.totals.crossGroups).toBe(0)
    expect(overview.libraries[0].localDuplicateGroups).toBe(1)
    expect(overview.totals.redundantCopies).toBe(0)
  })

  it('元数据回退（size=0）时标记容量未知，仍统计副本数', () => {
    const overview = buildLibraryOverview([
      library(ROOT_A, [entry(ROOT_A, 'a.safetensors', 'h', 0)], { source: 'store' }),
      library(ROOT_B, [entry(ROOT_B, 'b.safetensors', 'h', 0)], { source: 'store' })
    ])
    expect(overview.totals.crossGroups).toBe(1)
    expect(overview.totals.redundantCopies).toBe(1)
    expect(overview.totals.wastedBytes).toBe(0)
    expect(overview.totals.unknownSizeGroups).toBe(1)
    expect(overview.crossLibraryGroups[0].sizeKnown).toBe(false)
  })

  it('索引超过 7 天标记 staleIndex', () => {
    const now = Date.now()
    const overview = buildLibraryOverview(
      [library(ROOT_A, [], { savedAt: now - 8 * 24 * 3600 * 1000 })],
      now
    )
    expect(overview.libraries[0].staleIndex).toBe(true)
  })

  it('同一库内重复路径（异常索引）只计一次', () => {
    const duplicate = entry(ROOT_A, 'one.safetensors', 'h1', 100)
    const overview = buildLibraryOverview([
      library(ROOT_A, [duplicate, { ...duplicate }]),
      library(ROOT_B, [entry(ROOT_B, 'two.safetensors', 'h1', 100)])
    ])
    expect(overview.totals.crossGroups).toBe(1)
    expect(overview.crossLibraryGroups[0].copies).toBe(2)
  })
})
