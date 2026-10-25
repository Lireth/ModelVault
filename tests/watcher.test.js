import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { fakeUserData } from './setup'

/**
 * watcher.js 单元测试（E8 / A8 重写为轮询 + 快照比对后的首个覆盖）：
 * - 快照收集跳过关联存储目录（.modelvault）与排除目录（excludeDirs）
 * - 目录条目变更广播 models:fsChanged；防抖窗内多次变更只广播一次
 * - .modelvault / 排除目录内的写入不误触发（自激励防护）
 * - 未启用/停止后不再监控；重复 syncWatcher 不叠加
 * - 根目录消失时停止监控且不崩溃
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

import {
  collectDirSnapshot,
  computeSnapshotDiff,
  computeStatSnapshotDiff,
  refreshWatcherBaseline,
  setWatcherScanning,
  snapshotsEqual,
  stopWatcher,
  syncWatcher,
} from '../src/main/services/watcher'
import logger from '../src/main/logger'

/** 测试用小间隔时序（ms）：轮询快、防抖短，用例百毫秒级完成 */
const timing = { pollInterval: 20, broadcastDebounce: 40 }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 条件等待：周期轮询断言函数直到满足，超时抛出。
 * 轮询/文件操作耗时受环境负载波动影响（尤其 CI 慢盘），固定 sleep
 * 在慢环境会偶发失效；条件等待只在被测逻辑真正卡住时失败。
 */
async function waitFor(cond, desc, timeout = 1500) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error(`waitFor 超时: ${desc}`)
    await sleep(10)
  }
}

let root
const roots = []
/** 预置的待移入文件包目录（rename 一次调用产生单一原子条目变更，避免被轮询拆分观测） */
const bundles = []

/** 构造一个含单个模型文件的临时文件包，返回其路径 */
async function makeBundle(name) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), `modelvault-bundle-${name}-`),
  )
  await fs.writeFile(path.join(dir, `${name}.safetensors`), 'x')
  bundles.push(dir)
  return dir
}

/** 把文件包原子移入监控根目录（一次 rename = 根目录条目列表单一变更） */
async function moveBundleIn(dir, name) {
  await fs.rename(dir, path.join(root, name))
}

beforeEach(async () => {
  sentEvents.length = 0
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-watcher-'))
  roots.push(root)
})

afterEach(async () => {
  stopWatcher()
  for (const dir of [...roots, ...bundles]) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  roots.length = 0
  bundles.length = 0
})

describe('OP-05 原生事件监听（加速触发，轮询兜底）', () => {
  it('文件变更经原生事件提前广播；.modelvault 内写入被忽略', async () => {
    await fs.mkdir(path.join(root, '.modelvault'), { recursive: true })
    syncWatcher(root, true, [], {
      nativeWatch: true,
      // 轮询拉到很长，确保本用例的广播只能来自原生事件
      pollInterval: 100000,
      broadcastDebounce: 30,
      contentCheckInterval: 0,
      isVisible: () => true,
      onPollScheduled: () => {},
    })
    await sleep(50)

    await fs.writeFile(path.join(root, 'native.safetensors'), 'x')
    await waitFor(() => sentEvents.length > 0, '原生事件广播', 3000)
    expect(sentEvents[0].channel).toBe('models:fsChanged')
    expect(sentEvents[0].payload.root).toBe(root)
    // 根直属文件：子树为空串
    expect(sentEvents[0].payload.dirs).toContain('')

    const before = sentEvents.length
    await fs.mkdir(path.join(root, '.modelvault', 'thumbs'), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(root, '.modelvault', 'thumbs', 'noise.jpg'),
      'x',
    )
    await sleep(300)
    // 关联存储目录的写入不触发广播（与轮询排除策略一致）
    expect(sentEvents.length).toBe(before)

    // O11：内置排除目录（node_modules）的事件同样忽略，不再各自维护规则
    await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true })
    await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'noise.js'), 'x')
    await sleep(300)
    expect(sentEvents.length).toBe(before)
  })
})

describe('OP-05 原生监听降级与重建', () => {
  const originalWatch = fsSync.watch

  afterEach(() => {
    fsSync.watch = originalWatch
  })

  it('监听运行期异常时关闭并回落 2s 轮询；同根同步可重建监听', async () => {
    const fake = new EventEmitter()
    fake.close = vi.fn()
    let watchCalls = 0
    fsSync.watch = () => {
      watchCalls += 1
      return fake
    }
    const delays = []
    const timing = {
      nativeWatch: true,
      pollInterval: 100000,
      broadcastDebounce: 20,
      contentCheckInterval: 0,
      isVisible: () => true,
      onPollScheduled: (d) => delays.push(d),
    }
    syncWatcher(root, true, [], timing)
    expect(watchCalls).toBe(1)

    fake.emit('error', new Error('watch failed'))
    await waitFor(() => delays.includes(2000), '异常后回落 2s 轮询', 2000)
    expect(fake.close).toHaveBeenCalled()

    // 同根同开关再次同步：nativeWatcher 已为空，应尝试重建
    syncWatcher(root, true, [], timing)
    expect(watchCalls).toBe(2)
  })

  it('fs.watch 初始化抛错时继续用轮询且不崩溃', async () => {
    fsSync.watch = () => {
      throw new Error('unsupported platform')
    }
    const delays = []
    syncWatcher(root, true, [], {
      nativeWatch: true,
      pollInterval: 100000,
      broadcastDebounce: 20,
      contentCheckInterval: 0,
      isVisible: () => true,
      onPollScheduled: (d) => delays.push(d),
    })
    await waitFor(() => delays.includes(2000), '初始化失败回落 2s 轮询', 2000)
  })
})

describe('collectDirSnapshot / snapshotsEqual', () => {
  it('整条剔除 .modelvault 与排除目录；识别条目增减', async () => {
    await fs.mkdir(path.join(root, 'sub'), { recursive: true })
    await fs.writeFile(path.join(root, 'a.safetensors'), 'x')
    await fs.mkdir(path.join(root, '.modelvault', 'thumbs'), {
      recursive: true,
    })
    await fs.writeFile(path.join(root, '.modelvault', 'thumbs', 't.jpg'), 'x')
    await fs.mkdir(path.join(root, 'temp'), { recursive: true })
    await fs.writeFile(path.join(root, 'temp', 'junk.tmp'), 'x')

    const snapshot = await collectDirSnapshot(root, new Set(['temp']))

    // 既不记录也不递归被剔除的目录
    expect(snapshot.has(path.join(root, '.modelvault'))).toBe(false)
    expect(snapshot.has(path.join(root, '.modelvault', 'thumbs'))).toBe(false)
    expect(snapshot.has(path.join(root, 'temp'))).toBe(false)
    // 根目录条目名中同样不出现被剔除目录（出现/消失本身不构成变更）
    expect(snapshot.get(root)).not.toContain('.modelvault')
    expect(snapshot.get(root)).not.toContain('temp')
    // 正常子目录被递归，普通文件如实记录
    expect(snapshot.has(path.join(root, 'sub'))).toBe(true)
    expect(snapshot.get(root)).toContain('a.safetensors')
    // 一致判定：同一基线相等，增删条目后不等
    expect(
      snapshotsEqual(
        snapshot,
        await collectDirSnapshot(root, new Set(['temp'])),
      ),
    ).toBe(true)
    await fs.writeFile(path.join(root, 'b.safetensors'), 'x')
    expect(
      snapshotsEqual(
        snapshot,
        await collectDirSnapshot(root, new Set(['temp'])),
      ),
    ).toBe(false)
  })

  it('根目录不可读时抛出（由监控方决定停止）', async () => {
    await fs.mkdir(path.join(root, 'sub'))
    await expect(
      collectDirSnapshot(path.join(root, 'missing'), new Set()),
    ).rejects.toThrow()
  })

  it('O4：withStats 采集文件 size/mtime，同名覆盖写入产生目录差异', async () => {
    const file = path.join(root, 'overwrite.safetensors')
    await fs.writeFile(file, 'small')
    const before = await collectDirSnapshot(root, new Set(), {
      withStats: true,
    })
    const entry = before
      .get(root)
      .find((e) => e.name === 'overwrite.safetensors')
    expect(entry).toMatchObject({ size: 5 })
    expect(Number.isFinite(entry.mtimeMs)).toBe(true)

    // 同名、同条目名，仅内容/大小变化：名称快照无差异，内容快照必须命中
    await fs.writeFile(file, 'much-longer-content')
    const after = await collectDirSnapshot(root, new Set(), { withStats: true })

    // 条目名完全一致（名称快照不会发现变化），内容快照必须命中
    expect(before.get(root).map((e) => e.name)).toEqual(
      after.get(root).map((e) => e.name),
    )
    expect(computeStatSnapshotDiff(root, before, after)).toEqual([''])
  })

  it('O4：有界并发遍历（concurrency=1）仍完整收集嵌套目录', async () => {
    for (let i = 0; i < 12; i++) {
      const dir = path.join(root, `dir-${i}`, 'nested')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'm.safetensors'), 'x')
    }
    const snapshot = await collectDirSnapshot(root, new Set(), {
      withStats: true,
      concurrency: 1,
    })
    // 根 + 12 个一级目录 + 12 个 nested 目录
    expect(snapshot.size).toBe(25)
    expect(snapshot.has(path.join(root, 'dir-11', 'nested'))).toBe(true)
  })

  it('与 scanner 共享排除策略与最大深度：隐藏项/内置目录/put_/深层子树不进快照', async () => {
    await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true })
    await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'a.js'), 'x')
    await fs.mkdir(path.join(root, '.git'), { recursive: true })
    await fs.writeFile(path.join(root, '.git', 'config'), 'x')
    await fs.mkdir(path.join(root, '$RECYCLE.BIN'), { recursive: true })
    await fs.writeFile(path.join(root, '$RECYCLE.BIN', 'old.safetensors'), 'x')
    // 大小写变体：共享排除集按小写比较
    await fs.mkdir(path.join(root, 'System volume information'), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(root, 'System volume information', 'sys.safetensors'),
      'x',
    )
    await fs.writeFile(path.join(root, 'put_temp.safetensors'), 'x')
    await fs.writeFile(path.join(root, '.hidden.safetensors'), 'x')

    // MAX_SCAN_DEPTH=8：8 段目录在快照内，9 段目录及其文件不进入
    const depth8 = path.join(
      root,
      ...Array.from({ length: 8 }, (_, i) => `d${i}`),
    )
    const depth9 = path.join(depth8, 'd8')
    await fs.mkdir(depth9, { recursive: true })
    await fs.writeFile(path.join(depth8, 'm8.safetensors'), 'x')
    await fs.writeFile(path.join(depth9, 'm9.safetensors'), 'x')

    const snapshot = await collectDirSnapshot(root)

    const rootEntries = snapshot.get(root)
    expect(rootEntries).not.toContain('node_modules')
    expect(rootEntries).not.toContain('.git')
    expect(rootEntries).not.toContain('$RECYCLE.BIN')
    expect(rootEntries).not.toContain('System volume information')
    expect(rootEntries).not.toContain('put_temp.safetensors')
    expect(rootEntries).not.toContain('.hidden.safetensors')
    expect(snapshot.has(path.join(root, 'node_modules'))).toBe(false)
    expect(snapshot.has(path.join(root, '.git'))).toBe(false)
    expect(snapshot.has(depth8)).toBe(true)
    expect(snapshot.has(depth9)).toBe(false)
  })

  it('OPT-02：startDepth 让子树回填保持全库深度上限语义', async () => {
    const depth7 = path.join(
      root,
      ...Array.from({ length: 7 }, (_, i) => `s${i}`),
    )
    const depth8 = path.join(depth7, 's7')
    const depth9 = path.join(depth8, 's8')
    await fs.mkdir(depth9, { recursive: true })
    await fs.writeFile(path.join(depth8, 'm8.safetensors'), 'x')
    await fs.writeFile(path.join(depth9, 'm9.safetensors'), 'x')

    // 从第 7 层子树开始回填：第 8 层仍应采集，第 9 层与全库快照一致地忽略
    const snapshot = await collectDirSnapshot(depth7, new Set(), {
      startDepth: 7,
    })
    expect(snapshot.has(depth8)).toBe(true)
    expect(snapshot.has(depth9)).toBe(false)
  })
})

describe('computeSnapshotDiff（A-03 增量扫描的变更子树定位）', () => {
  /** 用 POSIX 相对路径构造快照（key 转平台绝对路径，value 为排序条目名） */
  function snap(root, entries) {
    const map = new Map()
    for (const [relDir, names] of Object.entries(entries)) {
      const abs = relDir === '' ? root : path.join(root, ...relDir.split('/'))
      map.set(abs, [...names].sort())
    }
    return map
  }

  it('无差异返回空数组', () => {
    const a = snap(root, { '': ['m.safetensors'], lora: ['a.safetensors'] })
    expect(computeSnapshotDiff(root, a, new Map(a))).toEqual([])
  })

  it('条目增删定位到所在目录（根目录用空串表示）', () => {
    const before = snap(root, {
      '': ['a.safetensors'],
      lora: ['x.safetensors'],
    })
    const after = snap(root, {
      '': ['a.safetensors', 'b.safetensors'],
      lora: ['x.safetensors'],
    })
    expect(computeSnapshotDiff(root, before, after)).toEqual([''])
  })

  it('子目录条目变化定位到该子目录（POSIX 相对路径）', () => {
    const before = snap(root, { '': [], lora: ['x.safetensors'] })
    const after = snap(root, {
      '': [],
      lora: ['x.safetensors', 'y.safetensors'],
    })
    expect(computeSnapshotDiff(root, before, after)).toEqual(['lora'])
  })

  it('新增目录与删除目录都纳入变更集合（供局部重扫判定模型增删）', () => {
    const before = snap(root, { '': [], old: ['gone.safetensors'] })
    const after = snap(root, { '': [], fresh: ['new.safetensors'] })
    const diff = computeSnapshotDiff(root, before, after).sort()
    expect(diff).toEqual(['fresh', 'old'])
  })

  it('结果稳定排序且去重', () => {
    const before = snap(root, { b: ['1'], a: ['1'] })
    const after = snap(root, { b: ['1', '2'], a: ['1', '2'] })
    expect(computeSnapshotDiff(root, before, after)).toEqual(['a', 'b'])
  })

  it('端到端：真实快照移动文件到新子目录后，diff 给出新旧两个目录', async () => {
    const oldDir = path.join(root, 'old')
    const newDir = path.join(root, 'new')
    await fs.mkdir(oldDir, { recursive: true })
    await fs.writeFile(path.join(oldDir, 'm.safetensors'), 'x')
    const before = await collectDirSnapshot(root, new Set())

    await fs.mkdir(newDir, { recursive: true })
    await fs.rename(
      path.join(oldDir, 'm.safetensors'),
      path.join(newDir, 'm.safetensors'),
    )
    const after = await collectDirSnapshot(root, new Set())

    // old/new 目录在根层增删，故根目录（''）与其自身同时进入变更集合
    expect(computeSnapshotDiff(root, before, after).sort()).toEqual([
      '',
      'new',
      'old',
    ])
  })
})

describe('syncWatcher 目录监控（A8）', () => {
  it('条目变更广播 models:fsChanged（载荷为当前根目录）', async () => {
    syncWatcher(root, true, [], timing)
    await sleep(60) // 等基准快照建立

    await moveBundleIn(await makeBundle('new'), 'new')
    await sleep(300) // 覆盖轮询(20ms) + 防抖(40ms) + 余量

    expect(sentEvents).toHaveLength(1)
    expect(sentEvents[0].channel).toBe('models:fsChanged')
    // A-03：载荷携带变更子树——根层新增 new 目录（''），new 目录为新增子树
    expect(sentEvents[0].payload.root).toBe(root)
    expect(sentEvents[0].payload.dirs).toEqual(['', 'new'])
  })

  it('防抖合并：静默期内的后续变更重置计时，最终只广播一次', async () => {
    // 放宽防抖窗，确保第二次变更稳定落在首次防抖触发之前
    syncWatcher(root, true, [], { pollInterval: 20, broadcastDebounce: 120 })
    await sleep(60)
    await moveBundleIn(await makeBundle('b1'), 'b1')
    await sleep(50) // 轮询已发现 b1（进入 120ms 防抖窗），窗口内
    await moveBundleIn(await makeBundle('b2'), 'b2') // 窗口内第二次变更：重置防抖
    await sleep(350) // 等重置后的防抖结束

    expect(sentEvents).toHaveLength(1)
  })

  it('O4：同名覆盖写入经低频内容校验被发现并广播', async () => {
    const file = path.join(root, 'overwrite.safetensors')
    await fs.writeFile(file, 'small')
    // 内容校验间隔调小到 30ms（生产默认 60s），名称轮询 20ms
    syncWatcher(root, true, [], {
      pollInterval: 20,
      broadcastDebounce: 40,
      contentCheckInterval: 30,
    })
    await sleep(80) // 等基准内容快照建立
    sentEvents.length = 0

    // 条目名不变、仅内容/大小变化：名称快照不会触发，内容校验轮必须命中
    await fs.writeFile(file, 'much-longer-content')
    await waitFor(() => sentEvents.length >= 1, '同名覆盖写入未触发广播')

    expect(sentEvents[0].channel).toBe('models:fsChanged')
    expect(sentEvents[0].payload.root).toBe(root)
    expect(sentEvents[0].payload.dirs).toEqual([''])
  })

  it('O4：contentCheckInterval≤0 时关闭内容校验（仅名称变更监控）', async () => {
    const file = path.join(root, 'no-content.safetensors')
    await fs.writeFile(file, 'small')
    syncWatcher(root, true, [], { ...timing, contentCheckInterval: 0 })
    await sleep(60)
    sentEvents.length = 0

    await fs.writeFile(file, 'much-longer-content')
    await sleep(250)
    expect(sentEvents).toHaveLength(0)
  })

  it('.modelvault 内的写入不触发广播（自激励防护）', async () => {
    syncWatcher(root, true, [], timing)
    await sleep(60)
    const store = path.join(root, '.modelvault')
    await fs.mkdir(path.join(store, 'thumbs'), { recursive: true })
    await fs.writeFile(path.join(store, 'store.json'), '{}')
    await fs.writeFile(path.join(store, 'thumbs', 'x.jpg'), 'x')
    await sleep(250)
    expect(sentEvents).toHaveLength(0)
  })

  it('excludeDirs 排除目录内的变更不触发广播（与 scanner 同规则）', async () => {
    await fs.mkdir(path.join(root, 'temp'))
    syncWatcher(root, true, ['temp'], timing)
    await sleep(60)
    await fs.writeFile(path.join(root, 'temp', 'a.tmp'), 'x')
    await fs.rm(path.join(root, 'temp', 'a.tmp'))
    await sleep(250)
    expect(sentEvents).toHaveLength(0)
  })

  it('未启用时不监控；启动后停止则不再广播', async () => {
    syncWatcher(root, false)
    await sleep(80)
    await moveBundleIn(await makeBundle('x'), 'x')
    expect(sentEvents).toHaveLength(0)

    syncWatcher(root, true, [], timing)
    await sleep(60)
    stopWatcher()
    await moveBundleIn(await makeBundle('y'), 'y')
    await sleep(250)
    expect(sentEvents).toHaveLength(0)
  })

  it('重复 syncWatcher（同根同开关）不叠加监控：仍只广播一次', async () => {
    syncWatcher(root, true, [], timing)
    await sleep(50)
    syncWatcher(root, true, [], timing) // 扫描完成后的重复同步（幂等）
    await sleep(50)
    await moveBundleIn(await makeBundle('z'), 'z')
    await sleep(300)
    expect(sentEvents).toHaveLength(1)
  })

  it('根目录被删除时停止监控：不广播、不崩溃', async () => {
    syncWatcher(root, true, [], timing)
    await sleep(60)
    await fs.rm(root, { recursive: true, force: true })
    await sleep(150)
    expect(sentEvents).toHaveLength(0)
    // 监控已停止：后续轮询不再运行（重建目录也不产生历史积压广播）
    await fs.mkdir(root, { recursive: true })
    await moveBundleIn(await makeBundle('later'), 'later')
    await sleep(250)
    expect(sentEvents).toHaveLength(0)
  })

  it('切根后旧根的变更零广播、新根监控不受旧根状态影响（B2 代际防护）', async () => {
    const rootA = root
    const rootB = await fs.mkdtemp(
      path.join(os.tmpdir(), 'modelvault-watcher-'),
    )
    roots.push(rootB)
    syncWatcher(rootA, true, [], timing)
    await sleep(60)
    // 切换到新根：旧 watcher 停止，其任何在途遍历回调都不得再安排广播/巡检，
    // 也不得因旧根的后续异常误停新 watcher
    syncWatcher(rootB, true, [], timing)

    // 旧根发生变更（若旧 watcher 的代际校验被破坏，其广播会把渲染层
    // 的 autoRescan 指回旧根，用户刚切的库被静默切回）
    await moveBundleIn(await makeBundle('stale'), 'stale')
    await sleep(250)
    expect(sentEvents.filter((e) => e.payload.root === rootA)).toHaveLength(0)

    // 新根监控正常存活：变更照常广播（载荷为新根）
    await fs.writeFile(path.join(rootB, 'fresh.safetensors'), 'x')
    await waitFor(
      () => sentEvents.some((e) => e.payload.root === rootB),
      '切根后新根的变更未广播（新 watcher 被误停？）',
    )
  })
})

describe('OPT-02 扫描/监控基线协同', () => {
  it('全量扫描基线直接复用：不再在扫描后做全树重建', async () => {
    await fs.writeFile(path.join(root, 'existing.safetensors'), 'x')
    // 故意提供缺少现有条目的基线：若仍执行一次基准遍历，基线会被纠正为
    // 磁盘现状而不广播；直接复用该基线则首个轮询必然检出差异。
    syncWatcher(root, true, [], {
      pollInterval: 20,
      broadcastDebounce: 20,
      contentCheckInterval: 0,
      baseline: new Map([[root, []]]),
    })
    await waitFor(() => sentEvents.length >= 1, '复用基线后未检出差异')
    expect(sentEvents[0].payload.dirs).toEqual([''])
  })

  it('正确基线不产生首次误报，后续变更仍只广播一次', async () => {
    const baseline = await collectDirSnapshot(root)
    syncWatcher(root, true, [], {
      pollInterval: 20,
      broadcastDebounce: 20,
      contentCheckInterval: 0,
      baseline,
    })
    await sleep(120)
    expect(sentEvents).toHaveLength(0)

    await fs.writeFile(path.join(root, 'later.safetensors'), 'x')
    await waitFor(() => sentEvents.length >= 1, '后续变更未广播')
    await sleep(150)
    expect(sentEvents).toHaveLength(1)
  })

  it('局部扫描基线回填后，轮询不再重复广播同一变更', async () => {
    syncWatcher(root, true, [], {
      pollInterval: 200,
      broadcastDebounce: 20,
      contentCheckInterval: 0,
    })
    await sleep(40)
    sentEvents.length = 0

    await fs.writeFile(path.join(root, 'refreshed.safetensors'), 'x')
    const snapshot = await collectDirSnapshot(root)
    expect(refreshWatcherBaseline(root, [''], snapshot)).toBe(true)
    await sleep(450)
    expect(sentEvents).toHaveLength(0)
  })

  it('原生事件广播后回填基线，轮询不重复广播同一变更', async () => {
    syncWatcher(root, true, [], {
      nativeWatch: true,
      pollInterval: 80,
      broadcastDebounce: 20,
      contentCheckInterval: 0,
      isVisible: () => true,
      onPollScheduled: () => {},
    })
    await sleep(80)
    sentEvents.length = 0

    await fs.writeFile(path.join(root, 'native-once.safetensors'), 'x')
    await waitFor(() => sentEvents.length >= 1, '原生事件未广播', 3000)
    // 轮询周期 80ms：若广播后的快照回填缺失，下一轮会再次检出同一变更
    await sleep(350)
    expect(sentEvents).toHaveLength(1)
  })

  it('扫描期暂停广播，停扫后只补发未覆盖变更', async () => {
    syncWatcher(root, true, [], {
      pollInterval: 30,
      broadcastDebounce: 20,
      contentCheckInterval: 0,
    })
    await sleep(60)
    sentEvents.length = 0

    setWatcherScanning(true)
    await fs.writeFile(path.join(root, 'during-scan.safetensors'), 'x')
    await sleep(150)
    expect(sentEvents).toHaveLength(0)

    setWatcherScanning(false)
    await waitFor(() => sentEvents.length >= 1, '停扫后未补发未覆盖变更')
    await sleep(150)
    expect(sentEvents).toHaveLength(1)
  })

  it('扫描基线覆盖变更后停扫不补发，消除重复局部扫描', async () => {
    syncWatcher(root, true, [], {
      pollInterval: 30,
      broadcastDebounce: 20,
      contentCheckInterval: 0,
    })
    await sleep(60)
    sentEvents.length = 0

    setWatcherScanning(true)
    await fs.writeFile(path.join(root, 'covered.safetensors'), 'x')
    const snapshot = await collectDirSnapshot(root)
    // 模拟全量扫描成功后的基线回写
    syncWatcher(root, true, [], { baseline: snapshot })
    setWatcherScanning(false)

    await sleep(200)
    expect(sentEvents).toHaveLength(0)
  })

  it('全量基线过滤非法/越界/排除/隐藏条目，全部非法时回退基准遍历', async () => {
    await fs.mkdir(path.join(root, 'temp'))
    await fs.writeFile(path.join(root, 'a.safetensors'), 'x')
    const badBaseline = new Map([
      [123, ['x']],
      [path.join(root, 'temp'), ['x']],
      [path.join(root, '..', 'outside'), ['x']],
      [path.join(root, 'lora'), 'not-array'],
      [root, ['a.safetensors', '.hidden', 'put_tmp']],
    ])
    syncWatcher(root, true, ['temp'], {
      pollInterval: 100000,
      broadcastDebounce: 20,
      contentCheckInterval: 0,
      baseline: badBaseline,
    })
    await sleep(100)
    expect(sentEvents).toHaveLength(0)

    // 全部条目非法/越界：基线清洗后为空，回退到原有基准遍历
    stopWatcher()
    sentEvents.length = 0
    syncWatcher(root, true, [], {
      pollInterval: 100000,
      broadcastDebounce: 20,
      contentCheckInterval: 0,
      baseline: new Map([[123, ['x']]]),
    })
    await sleep(80)
    expect(sentEvents).toHaveLength(0)
  })

  it('局部基线只合并受影响子树，空快照移除已删除子树', async () => {
    await fs.mkdir(path.join(root, 'lora', 'sub'), { recursive: true })
    await fs.writeFile(path.join(root, 'lora', 'sub', 'a.safetensors'), 'x')
    syncWatcher(root, true, [], {
      pollInterval: 100000,
      contentCheckInterval: 0,
    })
    await sleep(40)
    sentEvents.length = 0

    const loraSnapshot = await collectDirSnapshot(path.join(root, 'lora'))
    const snapshot = new Map([
      ...loraSnapshot,
      [root, ['ignored-out-of-scope']],
      [123, ['bad-key']],
    ])
    expect(
      refreshWatcherBaseline(path.join(root, '..'), ['lora'], snapshot),
    ).toBe(false)
    expect(refreshWatcherBaseline(root, [], snapshot)).toBe(false)
    expect(refreshWatcherBaseline(root, ['lora'], null)).toBe(false)
    expect(refreshWatcherBaseline(root, ['lora'], snapshot)).toBe(true)
    await sleep(80)
    expect(sentEvents).toHaveLength(0)

    // 空快照代表子树已删除：移除对应旧基线但不抛错
    await fs.rm(path.join(root, 'lora'), { recursive: true, force: true })
    expect(refreshWatcherBaseline(root, ['lora'], new Map())).toBe(true)
    stopWatcher()
    expect(refreshWatcherBaseline(root, ['lora'], new Map())).toBe(false)
  })

  it('局部根直属基线同步清理根目录内容快照', async () => {
    await fs.writeFile(path.join(root, 'root-file.safetensors'), 'x')
    syncWatcher(root, true, [], {
      pollInterval: 100000,
      contentCheckInterval: 30,
    })
    await sleep(120)
    sentEvents.length = 0

    const snapshot = await collectDirSnapshot(root)
    expect(refreshWatcherBaseline(root, [''], snapshot)).toBe(true)
    await sleep(80)
    expect(sentEvents).toHaveLength(0)
  })

  it('局部基线清理已覆盖的待广播变更并取消防抖定时器', async () => {
    syncWatcher(root, true, [], {
      pollInterval: 20,
      broadcastDebounce: 200,
      contentCheckInterval: 0,
    })
    await sleep(60)
    sentEvents.length = 0

    await fs.writeFile(path.join(root, 'pending.safetensors'), 'x')
    await sleep(80)
    const snapshot = await collectDirSnapshot(root)
    expect(refreshWatcherBaseline(root, [''], snapshot)).toBe(true)
    await sleep(300)
    expect(sentEvents).toHaveLength(0)
  })

  it('原生事件子树回填：噪声不广播，真实变更/删除按子树广播（含内容基线）', async () => {
    const originalWatch = fsSync.watch
    const fake = new EventEmitter()
    fake.close = vi.fn()
    let onNativeEvent = null
    fsSync.watch = (_root, _opts, cb) => {
      onNativeEvent = cb
      return fake
    }
    try {
      await fs.mkdir(path.join(root, 'lora'))
      await fs.writeFile(path.join(root, 'lora', 'a.safetensors'), 'x')
      syncWatcher(root, true, [], {
        nativeWatch: true,
        pollInterval: 100000,
        broadcastDebounce: 20,
        contentCheckInterval: 30,
        isVisible: () => true,
        onPollScheduled: () => {},
      })
      await sleep(120)
      sentEvents.length = 0

      // 噪声事件：磁盘无实际变化，回填后差异为空，不广播
      onNativeEvent('change', 'noise.txt')
      await sleep(100)
      expect(sentEvents).toHaveLength(0)

      // 真实子树变更：只广播该子树
      await fs.writeFile(path.join(root, 'lora', 'b.safetensors'), 'x')
      onNativeEvent('change', path.join('lora', 'b.safetensors'))
      await waitFor(() => sentEvents.length >= 1, '子树变更未广播', 3000)
      expect(sentEvents[0].payload.dirs).toEqual(['lora'])

      // 子树被删除：事件与回填之间目录消失，移除旧基线并广播删除子树
      sentEvents.length = 0
      await fs.rm(path.join(root, 'lora'), { recursive: true, force: true })
      onNativeEvent('change', path.join('lora', 'b.safetensors'))
      await waitFor(() => sentEvents.length >= 1, '删除子树未广播', 3000)
      expect(sentEvents[0].payload.dirs).toContain('lora')
    } finally {
      fsSync.watch = originalWatch
    }
  })

  it('扫描期开关幂等，取消已安排广播并在停扫后补发累积变更', async () => {
    const originalWatch = fsSync.watch
    const fake = new EventEmitter()
    fake.close = vi.fn()
    let onNativeEvent = null
    fsSync.watch = (_root, _opts, cb) => {
      onNativeEvent = cb
      return fake
    }
    try {
      syncWatcher(root, true, [], {
        nativeWatch: true,
        pollInterval: 100000,
        broadcastDebounce: 100,
        contentCheckInterval: 0,
        isVisible: () => true,
        onPollScheduled: () => {},
      })
      await sleep(60)
      sentEvents.length = 0

      await fs.writeFile(path.join(root, 'scan-window.safetensors'), 'x')
      onNativeEvent('change', 'scan-window.safetensors')
      await sleep(5)
      setWatcherScanning(true) // 取消已安排防抖广播
      setWatcherScanning(true) // 幂等
      await fs.writeFile(path.join(root, 'during-scan.safetensors'), 'x')
      onNativeEvent('change', 'during-scan.safetensors') // 扫描期事件仅累积
      await sleep(150)
      expect(sentEvents).toHaveLength(0)

      setWatcherScanning(false)
      await waitFor(() => sentEvents.length >= 1, '停扫后未补发累积变更')
      expect(sentEvents).toHaveLength(1)
    } finally {
      fsSync.watch = originalWatch
    }
  })
})

describe('A-07b 自适应轮询', () => {
  it('连续无变更时轮询间隔按阶梯退避，检测到变更后重置回基础间隔', async () => {
    // 阶梯 [20, 50, 100]：基准后首次仍为基础间隔，连续空闲升到 50/100 并封顶；
    // 发现变更的那轮巡检重置退避，其后紧邻的调度回到基础间隔 20。
    // 巡检触发与文件操作耗时受环境负载波动（CI 慢盘），统一用条件等待代替固定 sleep
    const scheduled = []
    syncWatcher(root, true, [], {
      pollInterval: 20,
      backoff: [20, 50, 100],
      broadcastDebounce: 30,
      onPollScheduled: (delay) => scheduled.push(delay),
    })
    await waitFor(() => scheduled.length >= 1, '基准轮后未安排巡检')
    expect(scheduled[0]).toBe(20) // 基准轮后的首次调度即基础间隔
    await waitFor(() => scheduled.at(-1) === 100, '空闲退避未爬到封顶档 100')
    // scheduled 为追加式数组：含 50 证明封顶前确实逐级经过中间档而非跳档
    expect(scheduled).toContain(50)

    // 制造变更：变更落盘到被发现之间可能隔若干轮空闲巡检（CI 上 rename
    // 可能耗时超过已挂起的封顶档定时器），空闲巡检的调度恒为封顶档 100；
    // 发现变更那轮的调度必为基础档 20——以此为重置立即生效的判据
    const beforeChange = scheduled.length
    await moveBundleIn(await makeBundle('changed'), 'changed')
    await waitFor(() => sentEvents.length >= 1, '变更未在超时内被发现并广播')
    const afterChange = scheduled.slice(beforeChange)
    const firstReset = afterChange.indexOf(20)
    expect(firstReset).toBeGreaterThan(-1) // 发现变更后退避确实重置回基础档
    // 首个 20 之前只允许出现空闲巡检的封顶档 100——证明重置发生在
    // 发现变更的那一轮，而非延迟一轮
    expect(afterChange.slice(0, firstReset).every((d) => d === 100)).toBe(true)
  })

  it('窗口隐藏时跳过目录快照遍历（暂停期间变更不被发现），恢复后重新发现', async () => {
    let visible = true
    syncWatcher(root, true, [], {
      ...timing,
      backoff: [20, 50, 100],
      isVisible: () => visible,
    })
    await sleep(60)

    // 隐藏窗口后移入文件：轮询仅空转探测可见性，不读快照、不广播
    visible = false
    await sleep(40)
    await moveBundleIn(await makeBundle('hidden-file'), 'hidden-file')
    await sleep(150)
    expect(sentEvents).toHaveLength(0)

    // 恢复可见：同一变更在后续轮询被发现
    visible = true
    await sleep(300)
    expect(sentEvents).toHaveLength(1)
    expect(sentEvents[0].payload.root).toBe(root)
  })

  it('无 backoff 配置时维持固定基础间隔（旧行为兼容）', async () => {
    const scheduled = []
    syncWatcher(root, true, [], {
      ...timing,
      onPollScheduled: (d) => scheduled.push(d),
    })
    await sleep(120)
    expect(scheduled.length).toBeGreaterThan(1)
    expect(scheduled.every((d) => d === timing.pollInterval)).toBe(true)
  })

  it('O8：窗口隐藏时探测间隔与阶梯解耦（恒为基础间隔，恢复响应不受封顶拖累）', async () => {
    // 先可见空闲爬到封顶档 100，再隐藏：隐藏期的调度必须是基础档 20
    //（隐藏轮不读盘，巡检只是轻量可见性探测；以基础间隔探测使恢复可见后
    // ≤1 个基础间隔内即做比对，不受阶梯封顶拖累）
    let visible = true
    const scheduled = []
    syncWatcher(root, true, [], {
      ...timing,
      backoff: [20, 50, 100],
      isVisible: () => visible,
      onPollScheduled: (d) => scheduled.push(d),
    })
    await waitFor(() => scheduled.at(-1) === 100, '空闲退避未爬到封顶档 100')

    const hideAt = scheduled.length
    visible = false
    await waitFor(() => scheduled.length > hideAt + 1, '隐藏期未继续安排探测轮')
    expect(
      scheduled.slice(hideAt).every((d) => d === timing.pollInterval),
    ).toBe(true)
  })

  it('O8：生产默认阶梯封顶 30s（可见空闲全树巡检频率较 10s 降 67%）', async () => {
    const infoSpy = vi.spyOn(logger, 'info')
    syncWatcher(root, true, [])
    const started = infoSpy.mock.calls
      .map((c) => c.join(' '))
      .find((t) => t.includes('目录监控已启动'))
    expect(started).toContain('基础轮询 2000ms')
    expect(started).toContain('空闲退避至 30000ms')
  })
})
