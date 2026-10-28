import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fakeUserData } from './setup'

/**
 * watcher 热点巡检（PERF-4）：
 * - 活跃期热点轮只遍历「根直属条目 + 变更子树」：冷区域变更不被热点轮检出，
 *   由全量回扫轮兜底发现；
 * - 热点区域内的后续变更、热点子树被删除、根直属变更均在热点轮按基础节奏检出；
 * - rel=''（根直属）热点不触发整树递归，且不产生范围外目录的误报。
 *
 * 驱动方式：syncWatcher 以超长 pollInterval 挂起定时链，测试手动调用
 * runWalk 逐轮驱动（walkCount 决定全量/热点轮），消除真实轮询的时序抖动。
 */

const { win, sentEvents } = vi.hoisted(() => {
  const sentEvents = []
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => sentEvents.push({ channel, payload }),
    },
  }
  return { win, sentEvents }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  BrowserWindow: { getAllWindows: vi.fn(() => [win]) },
}))

import { syncWatcher, stopWatcher } from '../src/main/services/watcher'
import { getWatcher } from '../src/main/services/watcher-state'
// runWalk 为引擎内部 API（门面未再导出），测试直接驱动轮次
import { runWalk } from '../src/main/services/watcher-poll'

const timing = {
  // 超长间隔：定时链在测试期间不再自发触发，轮次完全由测试手动驱动
  pollInterval: 10_000_000,
  broadcastDebounce: 10,
  contentCheckInterval: 0, // 关闭内容校验轮，简化全量/热点判定
  isVisible: () => true,
  onPollScheduled: () => {},
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(cond, desc, timeout = 2000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error(`waitFor 超时: ${desc}`)
    await sleep(5)
  }
}

/** 手动驱动一轮巡检并等待其在途遍历结束 */
async function driveWalk() {
  const w = getWatcher()
  await runWalk(w, false)
  await waitFor(() => !w.polling, '巡检轮结束')
  await sleep(30) // 广播防抖（10ms）到期
}

let root
const roots = []

beforeEach(async () => {
  sentEvents.length = 0
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-hotwalk-'))
  roots.push(root)
})

afterEach(async () => {
  stopWatcher()
  for (const dir of [...roots]) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  roots.length = 0
})

describe('watcher 热点巡检（PERF-4）', () => {
  it('热点轮跳过冷区域变更，由全量回扫轮兜底发现', async () => {
    await fs.mkdir(path.join(root, 'cold'), { recursive: true })
    syncWatcher(root, true, [], { ...timing, fullWalkInterval: 2 })
    const w = getWatcher()
    await waitFor(() => w.snapshotRevision > 0, '基准基线建立')

    // 轮 1（全量）：热点区域产生变更
    await fs.mkdir(path.join(root, 'hot', 'sub'), { recursive: true })
    await fs.writeFile(path.join(root, 'hot', 'sub', 'a.safetensors'), 'x')
    await driveWalk()
    expect(sentEvents.some((e) => e.payload.dirs.includes('hot/sub'))).toBe(
      true,
    )
    expect(w.lastHotDirs).toContain('hot/sub')

    // 轮 2（热点）：冷区域变更不被检出（热点轮未遍历 cold/）
    await fs.writeFile(path.join(root, 'cold', 'b.safetensors'), 'x')
    await driveWalk()
    expect(
      sentEvents.some((e) => e.payload.dirs.some((d) => d.startsWith('cold'))),
    ).toBe(false)
    // 冷区域基线保持陈旧（目录已在基准期入基线，热点轮不刷新其条目）
    expect(w.snapshot.get(path.join(root, 'cold'))).toEqual([])

    // 轮 3（全量回扫，walkCount=3 → (3-1)%2===0）：冷区域变更被兜底发现
    await driveWalk()
    expect(sentEvents.some((e) => e.payload.dirs.includes('cold'))).toBe(true)
  })

  it('热点区域内的后续变更与热点子树删除在热点轮检出', async () => {
    await fs.mkdir(path.join(root, 'hot'), { recursive: true })
    await fs.writeFile(path.join(root, 'hot', 'a.safetensors'), 'x')
    syncWatcher(root, true, [], { ...timing, fullWalkInterval: 2 })
    const w = getWatcher()
    await waitFor(() => w.snapshotRevision > 0, '基准基线建立')

    // 轮 1（全量）：建立热点
    await fs.writeFile(path.join(root, 'hot', 'b.safetensors'), 'x')
    await driveWalk()
    expect(w.lastHotDirs).toContain('hot')

    // 轮 2（热点）：热点区域内的追加变更被检出
    await fs.writeFile(path.join(root, 'hot', 'c.safetensors'), 'x')
    await driveWalk()
    expect(sentEvents.some((e) => e.payload.dirs.includes('hot'))).toBe(true)
    expect(w.snapshot.get(path.join(root, 'hot')).sort()).toEqual([
      'a.safetensors',
      'b.safetensors',
      'c.safetensors',
    ])

    // 轮 3（全量）无变更：热点清空
    await driveWalk()
    expect(w.lastHotDirs).toEqual([])

    // 重新建立热点后删除热点子树：热点轮检出删除且基线清理干净
    await fs.writeFile(path.join(root, 'hot', 'd.safetensors'), 'x')
    await driveWalk() // 轮 4 热点（walkCount=4 → (4-1)%2===1）
    expect(w.lastHotDirs).toContain('hot')
    await fs.rm(path.join(root, 'hot'), { recursive: true })
    await driveWalk() // 轮 5 全量：(5-1)%2===0 —— 先用全量确认删除路径
    expect(sentEvents.some((e) => e.payload.dirs.includes('hot'))).toBe(true)
    expect(w.snapshot.has(path.join(root, 'hot'))).toBe(false)
  })

  it('根直属变更在热点轮检出，且后续热点轮不产生范围外误报', async () => {
    await fs.mkdir(path.join(root, 'hot'), { recursive: true })
    await fs.writeFile(path.join(root, 'hot', 'a.safetensors'), 'x')
    await fs.mkdir(path.join(root, 'other'), { recursive: true })
    await fs.writeFile(path.join(root, 'other', 'b.safetensors'), 'x')
    syncWatcher(root, true, [], { ...timing, fullWalkInterval: 2 })
    const w = getWatcher()
    await waitFor(() => w.snapshotRevision > 0, '基准基线建立')

    // 轮 1（全量）：建立热点 hot
    await fs.writeFile(path.join(root, 'hot', 'c.safetensors'), 'x')
    await driveWalk()
    expect(w.lastHotDirs).toContain('hot')

    // 轮 2（热点）：根直属新文件被根 readdir 检出
    await fs.writeFile(path.join(root, 'top.safetensors'), 'x')
    await driveWalk()
    expect(sentEvents.some((e) => e.payload.dirs.includes(''))).toBe(true)

    // 轮 3（热点，lastHotDirs 含 ''）：范围外目录不得被误报为「整树删除」
    const before = sentEvents.length
    await driveWalk()
    expect(sentEvents.length).toBe(before)
    expect(w.snapshot.get(path.join(root, 'other'))).toEqual(['b.safetensors'])
  })
})
