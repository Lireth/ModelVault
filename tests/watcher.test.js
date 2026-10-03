import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
    webContents: { send: (channel, payload) => sentEvents.push({ channel, payload }) }
  }
  return { win, sentEvents }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  BrowserWindow: { getAllWindows: vi.fn(() => [win]) }
}))

import {
  collectDirSnapshot,
  snapshotsEqual,
  stopWatcher,
  syncWatcher
} from '../src/main/services/watcher'

/** 测试用小间隔时序（ms）：轮询快、防抖短，用例百毫秒级完成 */
const timing = { pollInterval: 20, broadcastDebounce: 40 }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let root
const roots = []
/** 预置的待移入文件包目录（rename 一次调用产生单一原子条目变更，避免被轮询拆分观测） */
const bundles = []

/** 构造一个含单个模型文件的临时文件包，返回其路径 */
async function makeBundle(name) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `modelvault-bundle-${name}-`))
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

describe('collectDirSnapshot / snapshotsEqual', () => {
  it('整条剔除 .modelvault 与排除目录；识别条目增减', async () => {
    await fs.mkdir(path.join(root, 'sub'), { recursive: true })
    await fs.writeFile(path.join(root, 'a.safetensors'), 'x')
    await fs.mkdir(path.join(root, '.modelvault', 'thumbs'), { recursive: true })
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
    expect(snapshotsEqual(snapshot, await collectDirSnapshot(root, new Set(['temp'])))).toBe(true)
    await fs.writeFile(path.join(root, 'b.safetensors'), 'x')
    expect(snapshotsEqual(snapshot, await collectDirSnapshot(root, new Set(['temp'])))).toBe(false)
  })

  it('根目录不可读时抛出（由监控方决定停止）', async () => {
    await fs.mkdir(path.join(root, 'sub'))
    await expect(collectDirSnapshot(path.join(root, 'missing'), new Set())).rejects.toThrow()
  })
})

describe('syncWatcher 目录监控（A8）', () => {
  it('条目变更广播 models:fsChanged（载荷为当前根目录）', async () => {
    syncWatcher(root, true, [], timing)
    await sleep(60) // 等基准快照建立

    await moveBundleIn(await makeBundle('new'), 'new')
    await sleep(250) // 覆盖轮询(20ms) + 防抖(40ms) + 余量

    expect(sentEvents).toHaveLength(1)
    expect(sentEvents[0].channel).toBe('models:fsChanged')
    expect(sentEvents[0].payload).toEqual({ root })
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
    await sleep(250)
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
})
