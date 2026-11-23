import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fakeUserData } from './setup'

/**
 * SCAN-DELTA 列表快照注册表特征测试：
 * - beginListSnapshot：全量下发播种与代际单调递增；
 * - computeScanDelta：代际失配回退全量 / 装饰引用快路径 / 索引条目内容
 *   比对慢路径（相等跳过并固化、不等进入 upsert）/ remove 判定；
 * - updateListSnapshotPartial：局部扫描结果同步注册表；
 * - 比对口径：undefined 与缺失键等价（结构化克隆载荷的可观察内容）。
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  BrowserWindow: Object.assign(vi.fn(), {
    fromWebContents: vi.fn(),
    getAllWindows: vi.fn(() => []),
  }),
  clipboard: { read: vi.fn(), writeText: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  shell: { trashItem: vi.fn(), showItemInFolder: vi.fn() },
  net: { fetch: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
}))

import {
  beginListSnapshot,
  computeScanDelta,
  updateListSnapshotPartial,
  resetListSnapshotsForTests,
} from '../src/main/ipc/models/list-delta'

const ROOT = 'D:\\models'

/** 构造装饰模型 */
function makeModel(id, patch = {}) {
  return {
    id,
    name: id,
    ext: '.safetensors',
    type: 'lora',
    size: 100,
    mtimeMs: 1000,
    covers: [
      {
        rel: '.modelvault/covers/1.png',
        path: `${id}.png`,
        thumbPath: `${id}.thumb.png`,
      },
    ],
    ...patch,
  }
}

beforeEach(() => {
  resetListSnapshotsForTests()
})

describe('beginListSnapshot 播种', () => {
  it('返回随根递增的代际，非模型条目被忽略', () => {
    const s1 = beginListSnapshot(ROOT, [
      makeModel(`${ROOT}\\a`),
      null,
      { noId: true },
    ])
    const s2 = beginListSnapshot(ROOT, [])
    expect(s1.root).toBe(ROOT)
    expect(s2.gen).toBeGreaterThan(s1.gen)
  })

  it('同根重复播种覆盖旧条目（旧代际失配）', () => {
    beginListSnapshot(ROOT, [makeModel(`${ROOT}\\a`)])
    const second = beginListSnapshot(ROOT, [makeModel(`${ROOT}\\b`)])
    // 旧代际请求失配 → 全量
    expect(
      computeScanDelta(ROOT, { root: ROOT, gen: second.gen - 1 }, []),
    ).toBeNull()
    // 新代际请求：b 已播种为索引条目，内容一致 → 空 remove/upsert
    const delta = computeScanDelta(ROOT, second, [makeModel(`${ROOT}\\b`)])
    expect(delta).not.toBeNull()
    expect(delta.upsert).toHaveLength(0)
    expect(delta.remove).toHaveLength(0)
    expect(delta.unchanged).toBe(1)
  })
})

describe('computeScanDelta 差量判定', () => {
  it('无快照 / 无请求快照 / 代际失配 / 根不一致 → 全量（null）', () => {
    const snap = beginListSnapshot(ROOT, [makeModel(`${ROOT}\\a`)])
    expect(computeScanDelta(ROOT, null, [])).toBeNull()
    expect(computeScanDelta(ROOT, undefined, [])).toBeNull()
    expect(
      computeScanDelta(ROOT, { root: ROOT, gen: snap.gen + 1 }, []),
    ).toBeNull()
    expect(computeScanDelta(ROOT, { gen: snap.gen }, [])).toBeNull()
    expect(
      computeScanDelta('D:\\other', { root: 'D:\\other', gen: snap.gen }, []),
    ).toBeNull()
  })

  it('新装饰对象（引用不同）但内容一致 → 索引条目慢路径判未变化', () => {
    const snap = beginListSnapshot(ROOT, [makeModel(`${ROOT}\\a`)])
    // 模拟重新反序列化的装饰结果：同内容新对象（嵌套 covers 数组也新建）
    const redecorated = makeModel(`${ROOT}\\a`)
    const delta = computeScanDelta(ROOT, snap, [redecorated])
    expect(delta.upsert).toHaveLength(0)
    expect(delta.remove).toHaveLength(0)
    expect(delta.unchanged).toBe(1)
    expect(delta.total).toBe(1)
    // 固化为引用比对：同对象快路径
    const again = computeScanDelta(ROOT, snap, [redecorated])
    expect(again.unchanged).toBe(1)
  })

  it('内容变化（mtime 变更）→ upsert 携带瘦身副本', () => {
    const snap = beginListSnapshot(ROOT, [makeModel(`${ROOT}\\a`)])
    const changed = makeModel(`${ROOT}\\a`, { mtimeMs: 2000 })
    const delta = computeScanDelta(ROOT, snap, [changed])
    expect(delta.upsert).toHaveLength(1)
    // upsert 为瘦身副本：covers 条目收敛为 {rel, path, thumbPath}，无 url 派生字段
    expect(delta.upsert[0].id).toBe(`${ROOT}\\a`)
    expect(delta.upsert[0].mtimeMs).toBe(2000)
    expect(delta.upsert[0].covers[0].url).toBeUndefined()
    expect(delta.approxBytes).toBeGreaterThan(0)
    // 注册表已更新：再扫同引用 → 未变化
    const again = computeScanDelta(ROOT, snap, [changed])
    expect(again.unchanged).toBe(1)
    expect(again.upsert).toHaveLength(0)
  })

  it('本次扫描缺失的 id 进入 remove 并从注册表移除', () => {
    beginListSnapshot(ROOT, [])
    beginListSnapshot(ROOT, [
      makeModel(`${ROOT}\\a`),
      makeModel(`${ROOT}\\gone`),
    ])
    const delta = computeScanDelta(ROOT, { root: ROOT, gen: 2 }, [
      makeModel(`${ROOT}\\a`),
    ])
    expect(delta.remove).toEqual([`${ROOT}\\gone`])
    expect(delta.upsert).toHaveLength(0)
  })

  it('装饰引用快路径：同引用条目不产生 upsert', () => {
    beginListSnapshot(ROOT, [])
    const a = makeModel(`${ROOT}\\a`)
    // 全量扫描播种（引用 = decorated 元素）
    beginListSnapshot(ROOT, [a])
    const delta = computeScanDelta(ROOT, { root: ROOT, gen: 2 }, [a])
    expect(delta.unchanged).toBe(1)
    expect(delta.upsert).toHaveLength(0)
  })

  it('空差量（无新增无删除）仍返回 delta 对象', () => {
    beginListSnapshot(ROOT, [])
    const delta = computeScanDelta(ROOT, { root: ROOT, gen: 1 }, [])
    expect(delta).not.toBeNull()
    expect(delta.upsert).toHaveLength(0)
    expect(delta.remove).toHaveLength(0)
  })

  it('未变化条目在慢路径命中后，同内容新对象下次走引用快路径', () => {
    const snap = beginListSnapshot(ROOT, [makeModel(`${ROOT}\\a`)])
    const first = makeModel(`${ROOT}\\a`)
    computeScanDelta(ROOT, snap, [first])
    // 内容一致的新对象（如缓存淘汰后重装饰）：引用比对失败 → 内容比对兜底
    const second = makeModel(`${ROOT}\\a`)
    const delta = computeScanDelta(ROOT, snap, [second])
    expect(delta.upsert).toHaveLength(0)
    expect(delta.unchanged).toBe(1)
  })
})

describe('updateListSnapshotPartial 局部同步', () => {
  it('局部装饰结果固化为引用比对；无快照时静默跳过', () => {
    // 无快照：不抛错
    expect(() =>
      updateListSnapshotPartial(ROOT, [makeModel(`${ROOT}\\a`)]),
    ).not.toThrow()

    const snap = beginListSnapshot(ROOT, [makeModel(`${ROOT}\\a`)])
    const partial = makeModel(`${ROOT}\\a`, { note: '局部更新' })
    updateListSnapshotPartial(ROOT, [partial])
    const delta = computeScanDelta(ROOT, snap, [partial])
    expect(delta.unchanged).toBe(1)
    expect(delta.upsert).toHaveLength(0)
  })

  it('局部同步的新 id 进入注册表，全量扫描缺失时以 remove 下发', () => {
    const snap = beginListSnapshot(ROOT, [])
    const added = makeModel(`${ROOT}\\new`)
    updateListSnapshotPartial(ROOT, [added])
    const delta = computeScanDelta(ROOT, snap, [])
    expect(delta.remove).toEqual([`${ROOT}\\new`])
  })
})

describe('looseEqual 比对口径（经慢路径观测）', () => {
  it('undefined 字段与缺失键等价', () => {
    beginListSnapshot(ROOT, [makeModel(`${ROOT}\\a`, { note: undefined })])
    const withoutNote = makeModel(`${ROOT}\\a`)
    delete withoutNote.note
    const delta = computeScanDelta(ROOT, { root: ROOT, gen: 1 }, [withoutNote])
    expect(delta.unchanged).toBe(1)
  })

  it('嵌套对象/数组差异可检出（params/covers）', () => {
    beginListSnapshot(ROOT, [
      makeModel(`${ROOT}\\a`, {
        params: { steps: 20, sampler: 'euler' },
      }),
    ])
    const changedParams = makeModel(`${ROOT}\\a`, {
      params: { steps: 30, sampler: 'euler' },
    })
    const delta = computeScanDelta(ROOT, { root: ROOT, gen: 1 }, [
      changedParams,
    ])
    expect(delta.upsert).toHaveLength(1)
    expect(delta.upsert[0].params.steps).toBe(30)
  })
})
