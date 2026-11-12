import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DATA_DIR, setDataRoot } from '../src/main/services/store'
import { metaState } from '../src/main/services/store-meta-state'
import {
  isDeltaBatchName,
  loadJournal,
  normalizeSnapshotSeq,
  removeJournalDir,
} from '../src/main/services/store-meta-journal'
import logger from '../src/main/logger'

/**
 * store-meta-journal.js 单元测试（OPT-2 数据关键路径补测）：
 * 增量日志回放是「标注不丢失」承诺的最后防线之一，此前仅经 store.test.js
 * 的 loadData 集成路径间接覆盖。本文件直接锁定模块自身契约：
 * - 纯函数：批次文件名识别、快照代际规范化（越界回退 0 触发自愈回放）；
 * - 回放语义：seq 数值序、代际跳过、条目级安全过滤（危险键/非法条目）、
 *   代际与条目计数记账；
 * - 容错：目录缺失静默、非 ENOENT 读取失败告警、损坏批次隔离且不抬升代际。
 * 集成层（批次写入/快照合并/防抖时序）已由 store.test.js 覆盖，此处不重复。
 */

let root
const roots = []

const journalDir = () => path.join(root, DATA_DIR, 'journal')

/** 重置模块共享内存态（loadJournal 直接读写 metaState） */
function resetMetaState(models = {}) {
  metaState.data = { version: 1, models: { ...models } }
  metaState.journalSeq = 0
  metaState.journalEntryCount = 0
}

/** 写入一个增量批次文件（默认 12 位零填充文件名，与写盘侧一致） */
async function writeBatch(seq, entries, fileName) {
  await fs.mkdir(journalDir(), { recursive: true })
  const name = fileName ?? `delta-${String(seq).padStart(12, '0')}.json`
  await fs.writeFile(
    path.join(journalDir(), name),
    JSON.stringify({ seq, entries }),
  )
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-journal-'))
  roots.push(root)
  setDataRoot(root)
  resetMetaState()
})

afterEach(() => {
  setDataRoot(null)
  resetMetaState()
})

afterAll(async () => {
  for (const dir of roots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('isDeltaBatchName', () => {
  it('识别 delta-<数字>.json 批次名（兼容任意位数与零填充）', () => {
    expect(isDeltaBatchName('delta-1.json')).toBe(true)
    expect(isDeltaBatchName('delta-0.json')).toBe(true)
    expect(isDeltaBatchName('delta-000000000001.json')).toBe(true)
  })

  it('拒绝非批次文件名', () => {
    expect(isDeltaBatchName('snapshot.json')).toBe(false)
    expect(isDeltaBatchName('delta.json')).toBe(false)
    expect(isDeltaBatchName('delta-.json')).toBe(false)
    expect(isDeltaBatchName('delta-1a.json')).toBe(false)
    expect(isDeltaBatchName('delta-1.txt')).toBe(false)
    expect(isDeltaBatchName('delta-1.json.bak')).toBe(false)
    expect(isDeltaBatchName('')).toBe(false)
  })
})

describe('normalizeSnapshotSeq', () => {
  it('合法代际原样返回（含 0 与上界）', () => {
    expect(normalizeSnapshotSeq(0)).toBe(0)
    expect(normalizeSnapshotSeq(42)).toBe(42)
    expect(normalizeSnapshotSeq(1_000_000_000)).toBe(1_000_000_000)
  })

  it('非法/越界代际回退 0 并告警（触发从头回放自愈）', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      for (const bad of [-1, 1.5, 1_000_000_001, '3', null, undefined, NaN]) {
        expect(normalizeSnapshotSeq(bad)).toBe(0)
      }
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('loadJournal 回放语义', () => {
  it('set/del 按代际升序回放，代际与条目计数如实记账', async () => {
    await writeBatch(1, [
      { op: 'set', key: 'a.safetensors', meta: { alias: 'A' } },
    ])
    await writeBatch(2, [
      { op: 'set', key: 'b.safetensors', meta: { alias: 'B' } },
      { op: 'del', key: 'a.safetensors' },
    ])

    await loadJournal(0)

    expect(metaState.data.models['a.safetensors']).toBeUndefined()
    expect(metaState.data.models['b.safetensors'].alias).toBe('B')
    expect(metaState.journalSeq).toBe(2)
    expect(metaState.journalEntryCount).toBe(3)
  })

  it('批次 seq 按数值序回放（未零填充文件名不受字符串序干扰）', async () => {
    // 字符串序 'delta-10' < 'delta-2'；数值序回放终态必须是 seq=10 的值
    await writeBatch(
      2,
      [{ op: 'set', key: 'a.safetensors', meta: { alias: 'two' } }],
      'delta-2.json',
    )
    await writeBatch(
      10,
      [{ op: 'set', key: 'a.safetensors', meta: { alias: 'ten' } }],
      'delta-10.json',
    )

    await loadJournal(0)

    expect(metaState.data.models['a.safetensors'].alias).toBe('ten')
    expect(metaState.journalSeq).toBe(10)
  })

  it('快照代际之前的批次跳过，仅回放之后批次且记账不含被跳过条目', async () => {
    await writeBatch(1, [
      { op: 'set', key: 'a.safetensors', meta: { alias: 'stale' } },
    ])
    await writeBatch(2, [
      { op: 'set', key: 'b.safetensors', meta: { alias: 'stale-too' } },
    ])
    await writeBatch(3, [
      { op: 'set', key: 'c.safetensors', meta: { alias: 'fresh' } },
    ])

    await loadJournal(2)

    expect(metaState.data.models['a.safetensors']).toBeUndefined()
    expect(metaState.data.models['b.safetensors']).toBeUndefined()
    expect(metaState.data.models['c.safetensors'].alias).toBe('fresh')
    expect(metaState.journalSeq).toBe(3)
    expect(metaState.journalEntryCount).toBe(1)
  })

  it('条目级安全过滤：危险键/空键/非法条目跳过，合法条目照常应用', async () => {
    await writeBatch(1, [
      { op: 'set', key: '__proto__', meta: { alias: 'pwn' } },
      { op: 'set', key: 'constructor', meta: { alias: 'pwn2' } },
      { op: 'set', key: '', meta: { alias: 'empty' } },
      { op: 'set', key: 42, meta: { alias: 'numkey' } },
      null,
      { op: 'set', key: 'bad.safetensors', meta: null },
      { op: 'wat', key: 'whatever.safetensors', meta: {} },
      { op: 'set', key: 'ok.safetensors', meta: { alias: 'ok' } },
      { op: 'del', key: 'ghost.safetensors' },
    ])

    await loadJournal(0)

    expect(Object.keys(metaState.data.models)).toEqual(['ok.safetensors'])
    expect(metaState.data.models['ok.safetensors'].alias).toBe('ok')
    // 危险键未污染原型
    expect({}.alias).toBeUndefined()
  })

  it('批次内容经 normalizeModelMeta 规范化：未知字段剔除、别名修剪', async () => {
    await writeBatch(1, [
      {
        op: 'set',
        key: 'a.safetensors',
        meta: { alias: '  修剪  ', note: '备注', unknownField: 'drop' },
      },
    ])

    await loadJournal(0)

    const meta = metaState.data.models['a.safetensors']
    expect(meta.alias).toBe('修剪')
    expect(meta.note).toBe('备注')
    expect(meta.unknownField).toBeUndefined()
  })

  it('损坏批次隔离（删除）且不抬升代际，后续批次照常回放', async () => {
    await fs.mkdir(journalDir(), { recursive: true })
    await fs.writeFile(
      path.join(journalDir(), 'delta-000000000001.json'),
      '{broken!!',
    )
    await writeBatch(2, [
      { op: 'set', key: 'b.safetensors', meta: { alias: 'after' } },
    ])
    // 内容 seq 为 0：低于合法下界，同样按损坏隔离
    await writeBatch(0, [{ op: 'set', key: 'zero.safetensors', meta: {} }])

    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      await loadJournal(0)
    } finally {
      warnSpy.mockRestore()
    }

    expect(metaState.data.models['b.safetensors'].alias).toBe('after')
    expect(metaState.data.models['zero.safetensors']).toBeUndefined()
    // 隔离批次不抬升代际：加载基线保持在实际可用批次的代际
    expect(metaState.journalSeq).toBe(2)
    await expect(
      fs.access(path.join(journalDir(), 'delta-000000000001.json')),
    ).rejects.toThrow()
    await expect(
      fs.access(path.join(journalDir(), 'delta-000000000000.json')),
    ).rejects.toThrow()
  })

  it('目录缺失（ENOENT）静默返回，数据与日志态不变', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      await loadJournal(0)
    } finally {
      warnSpy.mockRestore()
    }
    expect(metaState.data.models).toEqual({})
    expect(metaState.journalSeq).toBe(0)
    expect(metaState.journalEntryCount).toBe(0)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('非 ENOENT 读取失败仅告警不抛出，内存数据不受影响', async () => {
    const deny = new Error('拒绝访问')
    deny.code = 'EACCES'
    const spy = vi.spyOn(fs, 'readdir').mockRejectedValue(deny)
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      await expect(loadJournal(0)).resolves.toBeUndefined()
      // 断言置于 restore 之前（mockRestore 会清空调用记录）
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0][0])).toContain('增量日志读取失败')
      expect(metaState.data.models).toEqual({})
    } finally {
      spy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it('非批次文件被忽略且不被隔离删除', async () => {
    await fs.mkdir(journalDir(), { recursive: true })
    await fs.writeFile(path.join(journalDir(), 'readme.txt'), 'hello')
    await fs.writeFile(path.join(journalDir(), 'delta-abc.json'), '{bad')
    await writeBatch(1, [
      { op: 'set', key: 'a.safetensors', meta: { alias: 'A' } },
    ])

    await loadJournal(0)

    expect(metaState.data.models['a.safetensors'].alias).toBe('A')
    expect(metaState.journalSeq).toBe(1)
    expect(
      await fs.readFile(path.join(journalDir(), 'readme.txt'), 'utf-8'),
    ).toBe('hello')
    // 文件名不匹配批次格式：即使内容损坏也不隔离（留给健康检查治理）
    await fs.access(path.join(journalDir(), 'delta-abc.json'))
  })
})

describe('removeJournalDir', () => {
  it('删除整个日志目录', async () => {
    await writeBatch(1, [{ op: 'set', key: 'a.safetensors', meta: {} }])
    await removeJournalDir()
    await expect(fs.access(journalDir())).rejects.toThrow()
  })

  it('目录不存在时静默通过', async () => {
    await expect(removeJournalDir()).resolves.toBeUndefined()
  })

  it('删除失败仅告警不抛出', async () => {
    const spy = vi
      .spyOn(fs, 'rm')
      .mockRejectedValue(Object.assign(new Error('占用'), { code: 'EPERM' }))
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      await expect(removeJournalDir()).resolves.toBeUndefined()
      // 断言置于 restore 之前（mockRestore 会清空调用记录）
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0][0])).toContain('增量日志目录清理失败')
    } finally {
      spy.mockRestore()
      warnSpy.mockRestore()
    }
  })
})
