import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  atomicWriteFile,
  flushSettingsSave,
  flushStoreSave,
  getModelMeta,
  getModelIdsByAbsPath,
  getSettings,
  getCurrentRoot,
  isInRoot,
  loadData,
  loadSettings,
  normalizeStoreData,
  reloadCurrentRootData,
  reloadLibrarySettings,
  removeModelMeta,
  renameModelMeta,
  resolveCover,
  saveStoreNow,
  saveStoreDeltaNow,
  setDataRoot,
  setModelMeta,
  setStoreSaveErrorListener,
  switchDataRoot,
  updateSettings
} from '../src/main/services/store'
import { fakeUserData } from './setup'

/**
 * store.js 单元测试（黑盒）：
 * - 元数据规范化（别名/标签/评分/参数旧版迁移/未知字段剔除）
 * - 路径关联（相对键、Windows 大小写不敏感兜底、越界拒绝）
 * - 哈希持久化校验
 * - atomicWriteFile 原子写入
 * 说明：模块级内存状态按 beforeEach 重置（切换临时根目录）。
 */

let root
const roots = []

/** 写入一个模型文件占位（仅为路径关联，不要求真实模型内容） */
async function touchModel(rel) {
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, 'x')
  return abs
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-store-'))
  roots.push(root)
  setDataRoot(root)
  await loadData()
})

// 只清理本文件创建的临时目录：删除整个系统临时目录会连带摧毁
// 并行运行的其他测试文件临时目录与 vite 转换缓存，造成偶发 ENOENT 失败
afterAll(async () => {
  for (const dir of roots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('元数据规范化', () => {
  it('基础字段：别名修剪、备注截断、未知字段剔除', async () => {
    const abs = await touchModel('a.safetensors')
    const meta = setModelMeta(abs, {
      alias: '  我的大模型  ',
      note: 'x'.repeat(3000),
      unknownField: 'should be dropped',
      params: { steps: 20 }
    })
    expect(meta.alias).toBe('我的大模型')
    expect(meta.note).toHaveLength(2000)
    expect(meta.unknownField).toBeUndefined()
    expect(meta.params.steps).toBe(20)
    // 重新读取（内存规范化结果一致）
    expect(getModelMeta(abs).alias).toBe('我的大模型')
  })

  it('评分越界回退 0，收藏仅接受 true', async () => {
    const abs = await touchModel('c.safetensors')
    expect(setModelMeta(abs, { rating: 9, favorite: 'yes' }).rating).toBe(0)
    expect(getModelMeta(abs).favorite).toBe(false)
    expect(setModelMeta(abs, { rating: 5, favorite: true }).favorite).toBe(true)
  })

  it('旧版参数迁移：cfg 单值 -> 区间，resMinW/resMinH -> 单值区间', async () => {
    const abs = await touchModel('d.safetensors')
    const meta = setModelMeta(abs, {
      params: { cfg: 7, resMinW: 512, resMinH: 768, steps: 25 }
    })
    expect(meta.params.cfgMin).toBe(7)
    expect(meta.params.cfgMax).toBe(7)
    expect(meta.params.resMin).toBe(512)
    expect(meta.params.steps).toBe(25)
  })

  it('旧版单封面字段迁移为多封面列表', async () => {
    const abs = await touchModel('e.safetensors')
    const meta = setModelMeta(abs, { cover: '.modelvault/covers/old.png' })
    expect(meta.covers).toEqual(['.modelvault/covers/old.png'])
    expect(meta.cover).toBe('.modelvault/covers/old.png')
  })

  it('sidecar 来源标记仅接受 sidecar，非法值剔除', async () => {
    const abs = await touchModel('src.safetensors')
    const meta = setModelMeta(abs, {
      note: 'n',
      noteSource: 'sidecar',
      triggerWords: 't',
      triggerWordsSource: 'sidecar'
    })
    expect(meta.noteSource).toBe('sidecar')
    expect(meta.triggerWordsSource).toBe('sidecar')
    const bad = setModelMeta(abs, { noteSource: 'other', triggerWordsSource: 1 })
    expect(bad.noteSource).toBe('')
    expect(bad.triggerWordsSource).toBe('')
  })
})

describe('不可信 store.json 清洗（B-04）', () => {
  it('normalizeStoreData 剔除 __proto__/constructor/prototype 键', () => {
    const parsed = JSON.parse(
      '{"models":{"__proto__":{"alias":"pwn"},"constructor":{"alias":"c"},' +
        '"prototype":{"alias":"p"},"ok.safetensors":{"note":"ok"}}}'
    )
    const data = normalizeStoreData(parsed)
    expect(Object.keys(data.models)).toEqual(['ok.safetensors'])
    expect(Object.getPrototypeOf(data.models)).toBe(Object.prototype)
    expect({}.alias).toBeUndefined()
  })

  it('磁盘加载时剔除危险键，后续保存也不会把危险键写回', async () => {
    await fs.mkdir(path.join(root, '.modelvault'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.modelvault', 'store.json'),
      JSON.stringify({
        version: 1,
        models: {
          ['__proto__']: { alias: 'pwn' },
          'ok.safetensors': { note: 'ok' }
        }
      })
    )

    await loadData()
    expect(getModelMeta(path.join(root, 'ok.safetensors'))?.note).toBe('ok')
    // 危险键未成为 data.models 的自有属性
    expect(getModelMeta(path.join(root, 'anything.safetensors'))).toBeNull()

    setModelMeta(path.join(root, 'ok.safetensors'), { note: 'ok2' })
    await flushStoreSave()
    const disk = JSON.parse(
      await fs.readFile(path.join(root, '.modelvault', 'store.json'), 'utf-8')
    )
    expect(Object.prototype.hasOwnProperty.call(disk.models, '__proto__')).toBe(false)
    expect(disk.models['ok.safetensors'].note).toBe('ok2')
  })
})

describe('路径关联', () => {
  it('越界路径拒绝保存', async () => {
    const outside = path.join(path.dirname(root), 'outside.safetensors')
    expect(setModelMeta(outside, { alias: 'x' })).toBeNull()
    expect(setModelMeta('', { alias: 'x' })).toBeNull()
  })

  it('Windows 大小写不敏感：路径仅大小写不同仍可关联', async () => {
    const abs = await touchModel('Case-Model.safetensors')
    const lower = abs.toLowerCase()
    if (lower === abs) return // 文件系统大小写不敏感时大小写变化无意义
    expect(isInRoot(lower)).toBe(true)
    const meta = setModelMeta(lower, { alias: '小写路径' })
    expect(meta).not.toBeNull()
    // 键按传入路径的相对形式记录，同一变体读取一致
    expect(getModelMeta(lower).alias).toBe('小写路径')
  })

  it('删除元数据', async () => {
    const abs = await touchModel('del.safetensors')
    setModelMeta(abs, { alias: '待删除' })
    expect(removeModelMeta(abs)).toBe(true)
    expect(getModelMeta(abs)).toBeNull()
    expect(removeModelMeta(abs)).toBe(false)
  })

  it('模型 id 列表按绝对路径返回（启动预热用，O1）', async () => {
    const a = await touchModel('id-a.safetensors')
    const b = await touchModel('nested/id-b.safetensors')
    setModelMeta(a, { alias: 'a' })
    setModelMeta(b, { alias: 'b' })
    expect(getModelIdsByAbsPath().sort()).toEqual([a, b].sort())
  })

  it('改名/移动后元数据键整体迁移：标注与哈希履历无缝跟随（F10/F11）', async () => {
    const oldAbs = await touchModel('move-old.safetensors')
    setModelMeta(oldAbs, { alias: '跟着走', rating: 5, hash: 'f'.repeat(64), hashMtime: 123 })
    const newAbs = path.join(root, 'move-new.safetensors.disabled')
    expect(renameModelMeta(oldAbs, newAbs)).toBe(true)
    // 旧键消失，新键携带全部标注（含哈希履历）
    expect(getModelMeta(oldAbs)).toBeNull()
    const moved = getModelMeta(newAbs)
    expect(moved?.alias).toBe('跟着走')
    expect(moved?.rating).toBe(5)
    expect(moved?.hash).toBe('f'.repeat(64))
    // 无旧数据/越界目标返回 false
    expect(renameModelMeta(path.join(root, 'none.safetensors'), path.join(root, 'x.safetensors'))).toBe(false)
    expect(renameModelMeta(newAbs, 'D:\\库外\\x.safetensors')).toBe(false)
  })
})

describe('atomicWriteFile', () => {
  it('写入内容完整且不残留临时文件', async () => {
    const file = path.join(root, 'nested', 'dir', 'out.json')
    await atomicWriteFile(file, '{"ok":true}')
    expect(await fs.readFile(file, 'utf-8')).toBe('{"ok":true}')
    const siblings = await fs.readdir(path.dirname(file))
    expect(siblings.every((n) => !n.includes('.tmp'))).toBe(true)
  })

  it('并发写入同一文件使用互不相同的临时文件，内容不交错（A1）', async () => {
    const file = path.join(root, 'concurrent.json')
    const realRename = fs.rename.bind(fs)
    const renameSources = []
    vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
      renameSources.push(src)
      return realRename(src, dst)
    })
    try {
      await Promise.all([
        atomicWriteFile(file, '{"who":"first"}'),
        atomicWriteFile(file, '{"who":"second"}')
      ])
    } finally {
      vi.restoreAllMocks()
    }
    // 若共享同一临时文件：后写方的 writeFile 会截断前写方内容、
    // 先行方的 rename 又会移走临时文件使后行方 ENOENT——两次写的临时路径必须不同
    // （rename 重试不改变临时路径，故按去重后集合断言）；
    // 此外 Windows 上并发替换同一目标会确定性 EPERM，atomicWriteFile 须退避重试使两次写均成功
    expect(new Set(renameSources).size).toBe(2)
    // 最终内容必为其中之一的完整内容（无交错字节）
    const final = await fs.readFile(file, 'utf-8')
    expect(['{"who":"first"}', '{"who":"second"}']).toContain(final)
    expect(() => JSON.parse(final)).not.toThrow()
  })

  it('rename 前对临时文件 fsync，确保断电后目标为完整内容（A2）', async () => {
    const file = path.join(root, 'durable.json')
    // 事件时间线：记录 fsync 与 rename 的先后（当前实现无 fsync，rename 先于一切）
    const timeline = []
    const realOpen = fs.open.bind(fs)
    const realRename = fs.rename.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (target, ...rest) => {
      const fh = await realOpen(target, ...rest)
      const realSync = fh.sync.bind(fh)
      fh.sync = async () => {
        timeline.push('sync')
        return realSync()
      }
      return fh
    })
    vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
      timeline.push('rename')
      return realRename(src, dst)
    })
    try {
      await atomicWriteFile(file, '{"durable":true}')
    } finally {
      vi.restoreAllMocks()
    }
    // 数据块必须先刷盘再更名：否则断电时 rename 可能已持久化而数据块未落盘，
    // 目标文件呈现"已更名但内容不完整/全零"
    expect(timeline.filter((e) => e === 'sync')).toHaveLength(1)
    expect(timeline.indexOf('sync')).toBeLessThan(timeline.indexOf('rename'))
    expect(await fs.readFile(file, 'utf-8')).toBe('{"durable":true}')
    const siblings = await fs.readdir(root)
    expect(siblings.every((n) => !n.includes('.tmp'))).toBe(true)
  })
})

describe('落盘失败通知（B1）', () => {
  // 说明：直接调用 saveStoreNow 触发落盘而非依赖 scheduleSave 的防抖 timer——
  // 全量并行跑测试时事件循环积压会无限推迟 timer 回调，轮询等待会产生竞态
  it('写入失败时经监听器上报错误', async () => {
    const abs = await touchModel('save-fail.safetensors')
    // 用同名普通文件占位 .modelvault 目录，使原子写临时文件必然失败（EEXIST/ENOTDIR）
    const dataDir = path.join(root, '.modelvault')
    await fs.rm(dataDir, { recursive: true, force: true })
    await fs.writeFile(dataDir, 'x')

    const errors = []
    setStoreSaveErrorListener((err) => errors.push(err))
    try {
      setModelMeta(abs, { alias: '测试' })
      await saveStoreNow()
      expect(errors.length).toBeGreaterThanOrEqual(1)
      expect(errors[0]).toBeInstanceOf(Error)
      expect(errors[0].message).toBeTruthy()
    } finally {
      setStoreSaveErrorListener(null)
    }
  })

  it('监听器自身抛异常时仅降级为日志，不中断保存流程', async () => {
    const abs = await touchModel('listener-throw.safetensors')
    const dataDir = path.join(root, '.modelvault')
    await fs.rm(dataDir, { recursive: true, force: true })
    await fs.writeFile(dataDir, 'x')

    let notified = 0
    setStoreSaveErrorListener(() => {
      notified += 1
      throw new Error('监听器内部错误')
    })
    try {
      setModelMeta(abs, { alias: '测试' })
      await saveStoreNow()
      // 失败已上报且保存流程未被监听器异常中断：内存态已更新，无未捕获异常
      expect(notified).toBeGreaterThanOrEqual(1)
      expect(getModelMeta(abs).alias).toBe('测试')
    } finally {
      setStoreSaveErrorListener(null)
    }
  })
})

describe('退出落盘 flushStoreSave', () => {
  it('取消未触发的防抖定时器，最新数据立即落盘', async () => {
    const abs = await touchModel('flush-idle.safetensors')
    setModelMeta(abs, { alias: '防抖中' })
    // saveTimer 尚未触发（SAVE_DELAY 500ms）：flush 应取消定时器并发起写入
    await flushStoreSave()
    const text = await fs.readFile(path.join(root, '.modelvault', 'store.json'), 'utf-8')
    const key = path.relative(root, abs).split(path.sep).join('/')
    expect(JSON.parse(text).models[key].alias).toBe('防抖中')
  })

  it('与进行中的写入并发时等待写盘链静止，返回后磁盘必为最新数据', async () => {
    const abs = await touchModel('flush-race.safetensors')
    setModelMeta(abs, { alias: '第一版' })
    const first = saveStoreNow() // 有意不 await：构造写盘进行中的场景
    setModelMeta(abs, { alias: '第二版' })
    // 无论首次写入是否已结束（在途则 flush 登记补写并等待），
    // flush 返回后磁盘都必须包含最后一次修改——退出路径不丢数据的语义保证
    await Promise.all([first, flushStoreSave()])
    const text = await fs.readFile(path.join(root, '.modelvault', 'store.json'), 'utf-8')
    const key = path.relative(root, abs).split(path.sep).join('/')
    expect(JSON.parse(text).models[key].alias).toBe('第二版')
  })
})

describe('O5 增量落盘与快照合并', () => {
  const journalDir = () => path.join(root, '.modelvault', 'journal')
  const storeFile = () => path.join(root, '.modelvault', 'store.json')

  it('背景保存只写变化键日志；重新加载回放日志；flush 合并为紧凑快照', async () => {
    const abs = await touchModel('delta.safetensors')
    const key = path.relative(root, abs).split(path.sep).join('/')
    setModelMeta(abs, { alias: 'v1' })
    await saveStoreNow()

    // 快照为紧凑 JSON（不再 pretty 缩进）
    const snapshotText = await fs.readFile(storeFile(), 'utf-8')
    expect(snapshotText).not.toContain('\n  ')

    setModelMeta(abs, { alias: 'v2', note: '增量备注' })
    await saveStoreDeltaNow()
    const batches = await fs.readdir(journalDir())
    expect(batches).toHaveLength(1)
    const batch = JSON.parse(await fs.readFile(path.join(journalDir(), batches[0]), 'utf-8'))
    expect(batch.entries).toEqual([
      expect.objectContaining({ op: 'set', key })
    ])
    // 未合并前 store.json 仍是旧值
    const diskBefore = JSON.parse(await fs.readFile(storeFile(), 'utf-8'))
    expect(diskBefore.models[key].alias).toBe('v1')

    // 模拟重启：快照 + 增量日志回放
    await loadData()
    expect(getModelMeta(abs).alias).toBe('v2')
    expect(getModelMeta(abs).note).toBe('增量备注')

    // flush（退出/备份/切库路径）强制合并
    await flushStoreSave()
    const diskAfter = JSON.parse(await fs.readFile(storeFile(), 'utf-8'))
    expect(diskAfter.models[key].alias).toBe('v2')
    await expect(fs.access(journalDir())).rejects.toThrow()
  })

  it('增量条目达到阈值时自动写全量快照并清空日志', async () => {
    await saveStoreNow() // 建立基线快照
    for (let i = 0; i < 200; i++) {
      setModelMeta(path.join(root, `bulk-${i}.safetensors`), { alias: `m${i}` })
    }
    await saveStoreDeltaNow()

    const disk = JSON.parse(await fs.readFile(storeFile(), 'utf-8'))
    expect(Object.keys(disk.models)).toHaveLength(200)
    await expect(fs.access(journalDir())).rejects.toThrow()
  })

  it('增量日志记录删除操作并在回放中生效；无脏键时不写空批次', async () => {
    const abs = await touchModel('delete-delta.safetensors')
    setModelMeta(abs, { alias: '待删' })
    await saveStoreNow()
    await saveStoreDeltaNow() // 无脏键：不产生日志
    await expect(fs.access(journalDir())).rejects.toThrow()

    removeModelMeta(abs)
    await saveStoreDeltaNow()
    const batches = await fs.readdir(journalDir())
    const batch = JSON.parse(await fs.readFile(path.join(journalDir(), batches[0]), 'utf-8'))
    expect(batch.entries).toEqual([
      { op: 'del', key: path.relative(root, abs).split(path.sep).join('/') }
    ])

    await loadData()
    expect(getModelMeta(abs)).toBeNull()
  })

  it('损坏的日志批次被隔离，后续批次仍正常回放', async () => {
    await saveStoreNow()
    await fs.mkdir(journalDir(), { recursive: true })
    await fs.writeFile(path.join(journalDir(), 'delta-000000000001.json'), '{broken!!')
    await fs.writeFile(
      path.join(journalDir(), 'delta-000000000002.json'),
      JSON.stringify({
        seq: 2,
        entries: [{ op: 'set', key: 'b.safetensors', meta: { alias: '后续批次' } }]
      })
    )
    // 合法 JSON 但缺少 entries：同样隔离并继续后续批次
    await fs.writeFile(
      path.join(journalDir(), 'delta-000000000003.json'),
      JSON.stringify({ seq: 3 })
    )
    await fs.writeFile(
      path.join(journalDir(), 'delta-000000000004.json'),
      JSON.stringify({
        seq: 4,
        entries: [{ op: 'set', key: 'c.safetensors', meta: { alias: '再后续' } }]
      })
    )

    await loadData()

    expect(getModelMeta(path.join(root, 'b.safetensors')).alias).toBe('后续批次')
    expect(getModelMeta(path.join(root, 'c.safetensors')).alias).toBe('再后续')
    await expect(
      fs.access(path.join(journalDir(), 'delta-000000000001.json'))
    ).rejects.toThrow()
    await expect(
      fs.access(path.join(journalDir(), 'delta-000000000003.json'))
    ).rejects.toThrow()
  })

  it('增量写盘期间的再次修改保留为脏，并由下一次增量补写最新值', async () => {
    const abs = await touchModel('race-delta.safetensors')
    setModelMeta(abs, { alias: 'base' })
    await saveStoreNow()

    setModelMeta(abs, { alias: 'v1' })
    const realRename = fs.rename.bind(fs)
    let releaseRename = () => {}
    const gate = new Promise((resolve) => {
      releaseRename = resolve
    })
    let gated = false
    vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
      if (!gated && src.includes('journal')) {
        gated = true
        await gate
      }
      return realRename(src, dst)
    })

    try {
      const first = saveStoreDeltaNow()
      await vi.waitFor(() => expect(gated).toBe(true))
      // 日志已按 v1 序列化但尚未改名完成：此刻的新修改不得被清出脏集合
      setModelMeta(abs, { alias: 'v2' })
      releaseRename()
      await first
      await saveStoreDeltaNow()
    } finally {
      vi.restoreAllMocks()
    }

    await loadData()
    expect(getModelMeta(abs).alias).toBe('v2')
  })

  it('快照代际之前的旧日志批次被跳过，不覆盖新快照', async () => {
    await fs.mkdir(path.join(root, '.modelvault'), { recursive: true })
    await fs.writeFile(
      storeFile(),
      JSON.stringify({
        version: 1,
        journalSeq: 2,
        models: { 'a.safetensors': { alias: 'snapshot' } }
      })
    )
    await fs.mkdir(journalDir(), { recursive: true })
    const writeBatch = (seq, alias) =>
      fs.writeFile(
        path.join(journalDir(), `delta-${String(seq).padStart(12, '0')}.json`),
        JSON.stringify({
          seq,
          entries: [{ op: 'set', key: 'a.safetensors', meta: { alias } }]
        })
      )
    await writeBatch(1, 'stale-1')
    await writeBatch(2, 'stale-2')
    await writeBatch(3, 'fresh')

    await loadData()

    expect(getModelMeta(path.join(root, 'a.safetensors')).alias).toBe('fresh')
  })
})

describe('reloadCurrentRootData（备份恢复到当前根后的内存重载，B1）', () => {
  /** 直接整文件替换磁盘 store.json（备份恢复目录交换的等价形态） */
  async function replaceStoreOnDisk(models) {
    await fs.mkdir(path.join(root, '.modelvault'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.modelvault', 'store.json'),
      JSON.stringify({ version: 1, models })
    )
  }

  it('重载后内存反映磁盘上的替换内容，而非恢复前的旧内存', async () => {
    const abs = await touchModel('old.safetensors')
    setModelMeta(abs, { note: '恢复前的旧数据' })
    await replaceStoreOnDisk({ 'restored.safetensors': { note: '恢复数据' } })

    await reloadCurrentRootData()

    // 旧内存条目被磁盘上的替换内容取代：没有它，下一次 setModelMeta →
    // saveStoreNow 会用旧内存原子覆盖刚恢复的文件（恢复被静默回滚）
    expect(getModelMeta(abs)).toBeNull()
    expect(getModelMeta(path.join(root, 'restored.safetensors'))?.note).toBe('恢复数据')
  })

  it('重载丢弃的在途防抖定时器不再落盘：磁盘保持恢复内容', async () => {
    const abs = await touchModel('pending.safetensors')
    setModelMeta(abs, { note: '先落盘一版' })
    await saveStoreNow()
    await replaceStoreOnDisk({ 'restored.safetensors': { note: '恢复数据' } })
    // 恢复完成瞬间的在途防抖（恢复前用户刚做的修改）：必须被重载丢弃
    setModelMeta(abs, { note: '恢复前的最后修改' })

    vi.useFakeTimers()
    try {
      await reloadCurrentRootData()
      // 越过防抖延迟：被丢弃的定时器不得把旧内存覆盖到恢复内容上
      await vi.advanceTimersByTimeAsync(700)
    } finally {
      vi.useRealTimers()
    }
    const text = await fs.readFile(path.join(root, '.modelvault', 'store.json'), 'utf-8')
    const disk = JSON.parse(text)
    expect(disk.models['restored.safetensors']?.note).toBe('恢复数据')
    expect(disk.models[path.relative(root, abs).split(path.sep).join('/')]).toBeUndefined()
  })

  it('等待在途原子写结束后再读取磁盘，避免重载与 rename 交错（B-02）', async () => {
    const abs = await touchModel('inflight.safetensors')
    setModelMeta(abs, { alias: '在途写入' })

    const realRename = fs.rename.bind(fs)
    let releaseRename = () => {}
    const gate = new Promise((resolve) => {
      releaseRename = resolve
    })
    let gated = false
    vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
      if (!gated && src.includes('store.json')) {
        gated = true
        await gate
      }
      return realRename(src, dst)
    })

    try {
      const write = saveStoreNow() // 卡在 rename，构造在途写入
      await vi.waitFor(() => expect(gated).toBe(true))

      let reloaded = false
      const reload = reloadCurrentRootData().then(() => {
        reloaded = true
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      // 在途写入未结束：重载必须等待，不能先读到旧文件
      expect(reloaded).toBe(false)

      releaseRename()
      await Promise.all([write, reload])
      expect(getModelMeta(abs)?.alias).toBe('在途写入')
    } finally {
      vi.restoreAllMocks()
    }
  })
})

describe('切换根目录与落盘链（A6）', () => {
  /** 另建一个临时根目录（切库目标） */
  async function makeOtherRoot() {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-otherroot-'))
    roots.push(other)
    return other
  }

  it('switchDataRoot 先把旧根待落盘数据写入旧目录，再切换根目录', async () => {
    const abs = await touchModel('switch-a.safetensors')
    const other = await makeOtherRoot()
    setModelMeta(abs, { alias: '切库前抢救' }) // 防抖中（500ms 内不会自动落盘）

    await switchDataRoot(other)

    // 旧根数据已立即落盘（不必等防抖定时器）
    const text = await fs.readFile(path.join(root, '.modelvault', 'store.json'), 'utf-8')
    const key = path.relative(root, abs).split(path.sep).join('/')
    expect(JSON.parse(text).models[key].alias).toBe('切库前抢救')
    // 新根已生效且未发生写盘（无迟到定时器把旧数据写进新目录）
    expect(getCurrentRoot()).toBe(other)
    await expect(fs.access(path.join(other, '.modelvault', 'store.json'))).rejects.toThrow()
  })

  it('切库后迟到的防抖保存被丢弃：不把旧根数据写进新根目录', async () => {
    const abs = await touchModel('stale-timer.safetensors')
    const other = await makeOtherRoot()
    const otherStoreFile = path.join(other, '.modelvault', 'store.json')
    vi.useFakeTimers()
    try {
      setModelMeta(abs, { alias: '旧根的修改' }) // 防抖调度于旧根
      // 绕过 switchDataRoot 直接裸切根（兜底场景）：此刻 data 仍是旧根数据
      setDataRoot(other)
      // 迟到定时器在 loadData 之前触发：旧实现会把旧根数据写进新根 store.json
      await vi.advanceTimersByTimeAsync(500)
    } finally {
      vi.useRealTimers()
    }
    // fake timers 不拦截真实 fs I/O：轮询等待在途写盘落定后再判定，
    // 未修复时新根 store.json 会被创建且含旧根数据（跨库污染）
    const deadline = Date.now() + 1000
    let polluted = false
    while (Date.now() < deadline && !polluted) {
      try {
        if ((await fs.readFile(otherStoreFile, 'utf-8')).includes('旧根的修改')) polluted = true
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    expect(polluted).toBe(false)
  })

  it('根目录仅大小写不同时不误判跨根：迟到防抖照常落盘（P0-7）', async () => {
    const abs = await touchModel('case-variant.safetensors')
    // 构造同一目录的另一种大小写拼写（Windows 文件系统大小写不敏感，
    // 对话框与设置文件对同一根目录可能给出不同拼写）
    const letterIndex = [...root].findIndex((ch) => /[a-z]/.test(ch))
    const variant =
      root.slice(0, letterIndex) + root[letterIndex].toUpperCase() + root.slice(letterIndex + 1)
    expect(variant).not.toBe(root)
    expect(variant.toLowerCase()).toBe(root.toLowerCase())

    // 全新根无快照，首个防抖保存走 writeSnapshot 落 store.json（与上一用例
    // 的污染判定目标同一路径）
    const storeFile = path.join(root, '.modelvault', 'store.json')
    vi.useFakeTimers()
    try {
      setModelMeta(abs, { alias: '大小写变体根的修改' }) // 防抖调度于原拼写根
      // 裸切根到大小写变体：守卫不应视为跨根丢弃（对照上一用例的真跨根）
      setDataRoot(variant)
      await vi.advanceTimersByTimeAsync(500)
    } finally {
      vi.useRealTimers()
    }
    // fake timers 不拦截真实 fs I/O：轮询等待在途写盘落定后再判定
    const deadline = Date.now() + 1000
    let saved = false
    while (Date.now() < deadline && !saved) {
      try {
        if ((await fs.readFile(storeFile, 'utf-8')).includes('大小写变体根的修改')) saved = true
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    expect(saved).toBe(true)
  })
})

describe('应用设置规范化', () => {
  it('excludeDirs 统一小写并大小写不敏感去重（与 scanner 匹配约定一致）', async () => {
    await updateSettings({ excludeDirs: ['Loras', '  LORAS ', 'Embeds', '', '.modelvault'] })
    const { excludeDirs } = await loadSettings()
    expect(excludeDirs).toEqual(['loras', 'embeds', '.modelvault'])
  })

  it('收藏/评分排序合法（U2 白名单扩展），未知排序回退 name，sortAsc 仅接受布尔', async () => {
    await updateSettings({ sortBy: 'favorite', sortAsc: false })
    let s = await loadSettings()
    expect(s.sortBy).toBe('favorite')
    expect(s.sortAsc).toBe(false)
    // sortAsc 非布尔回退默认 true
    await updateSettings({ sortAsc: 'yes' })
    s = await loadSettings()
    expect(s.sortAsc).toBe(true)
  })

  it('theme 接受 dark/light/system，未知值回退 dark', async () => {
    await updateSettings({ theme: 'system' })
    let s = await loadSettings()
    expect(s.theme).toBe('system')
    await updateSettings({ theme: 'neon' })
    s = await loadSettings()
    expect(s.theme).toBe('dark')
  })

  it('hashWarmup 接受 candidates/full/off，未知值回退 candidates', async () => {
    for (const mode of ['full', 'off', 'candidates']) {
      await updateSettings({ hashWarmup: mode })
      const s = await loadSettings()
      expect(s.hashWarmup).toBe(mode)
    }
    await updateSettings({ hashWarmup: 'turbo' })
    const s = await loadSettings()
    expect(s.hashWarmup).toBe('candidates')
  })

  it('autoCheckUpdate 缺省视为开启，显式关闭后持久生效（O-3）', async () => {
    let s = await loadSettings()
    expect(s.autoCheckUpdate).toBe(true)
    await updateSettings({ autoCheckUpdate: false })
    s = await loadSettings()
    expect(s.autoCheckUpdate).toBe(false)
    // 与 civitaiEnabled 同款宽松语义：仅显式 false 关闭，缺省/其余值回退开启
    await updateSettings({ autoCheckUpdate: undefined })
    s = await loadSettings()
    expect(s.autoCheckUpdate).toBe(true)
  })

  it('viewMode 接受 grid/list，未知值回退 grid', async () => {
    await updateSettings({ viewMode: 'list' })
    let s = await loadSettings()
    expect(s.viewMode).toBe('list')
    await updateSettings({ viewMode: 'kanban' })
    s = await loadSettings()
    expect(s.viewMode).toBe('grid')
  })

  it('accentColor 规范化：预设 key 与 #rrggbb 自定义色合法，非法回退默认', async () => {
    await updateSettings({ accentColor: 'violet' })
    let s = await loadSettings()
    expect(s.accentColor).toBe('violet')
    // 自定义 hex 统一小写
    await updateSettings({ accentColor: '#FF8800' })
    s = await loadSettings()
    expect(s.accentColor).toBe('#ff8800')
    // 非法形态（含 # 但非 hex / 超长 / 非字符串）回退默认 blue
    for (const bad of ['#12345', '#1234567', 'x'.repeat(21), 42]) {
      await updateSettings({ accentColor: bad })
      s = await loadSettings()
      expect(s.accentColor).toBe('blue')
    }
  })

  it('savedViews 规范化：非法条目剔除、id 去重、缺省字段与未知排序回退', async () => {
    await updateSettings({
      savedViews: [
        {
          id: 'v1',
          name: ' LoRA收藏 ',
          search: '动漫',
          typeFilter: 'lora',
          subFilter: 'role',
          tagFilters: ['角色', '风格', '角色'],
          showFavoritesOnly: true,
          showDuplicatesOnly: true,
          sortBy: 'mtime',
          sortAsc: false
        },
        { id: '', name: '无id' }, // 缺 id：剔除
        { id: 'v2', name: '  ' }, // 空白名称：剔除
        { id: 'v1', name: '重复id' }, // id 去重（首条保留）
        { id: 'v3', name: '缺省字段' }, // 其余字段回退默认
        { id: 'v4', name: '未知排序', tagFilter: '旧标签', sortBy: 'xxx', sortAsc: 'yes' },
        'not-an-object' // 非对象：剔除
      ]
    })
    const s = await loadSettings()
    expect(s.savedViews).toHaveLength(3)
    expect(s.savedViews[0]).toEqual({
      id: 'v1',
      name: 'LoRA收藏',
      search: '动漫',
      typeFilter: 'lora',
      subFilter: 'role',
      baseFilter: '',
      tagFilters: ['角色', '风格'],
      showFavoritesOnly: true,
      showDuplicatesOnly: true,
      sortBy: 'mtime',
      sortAsc: false
    })
    expect(s.savedViews[1]).toEqual({
      id: 'v3',
      name: '缺省字段',
      search: '',
      typeFilter: 'all',
      subFilter: '',
      baseFilter: '',
      tagFilters: [],
      showFavoritesOnly: false,
      showDuplicatesOnly: false,
      sortBy: 'name',
      sortAsc: true
    })
    // 未知排序/非布尔方向回退默认
    expect(s.savedViews[2].sortBy).toBe('name')
    expect(s.savedViews[2].sortAsc).toBe(true)
    // 旧视图单标签字符串迁移为数组（FEAT-01）
    expect(s.savedViews[2].tagFilters).toEqual(['旧标签'])
  })

  it('savedViews 缺失或非数组时回退空数组，上限 20 个', async () => {
    await updateSettings({ savedViews: 'oops' })
    let s = await loadSettings()
    expect(s.savedViews).toEqual([])

    const many = Array.from({ length: 25 }, (_, i) => ({ id: `v${i}`, name: `视图${i}` }))
    await updateSettings({ savedViews: many })
    s = await loadSettings()
    expect(s.savedViews).toHaveLength(20)
    expect(s.savedViews[19].id).toBe('v19')
  })
})

describe('应用设置文件损坏恢复（B2）', () => {
  const settingsFile = path.join(fakeUserData, 'settings.json')
  const backupFile = `${settingsFile}.bak`

  afterEach(async () => {
    await fs.rm(settingsFile, { force: true }).catch(() => {})
    await fs.rm(backupFile, { force: true }).catch(() => {})
  })

  it('settings.json 损坏时备份为 .bak 后重置，不直接覆盖原文件', async () => {
    await fs.mkdir(fakeUserData, { recursive: true })
    await fs.writeFile(settingsFile, '{corrupted!!')
    const s = await loadSettings()
    // 返回默认设置（modelsFolder 丢失但可手动从备份恢复）
    expect(s.modelsFolder).toBe('')
    // 原文件被备份，损坏内容原样保留，供用户手动抢救
    expect(await fs.readFile(backupFile, 'utf-8')).toBe('{corrupted!!')
    // settings.json 已被 rename 移走，待下次 updateSettings 重写新文件
    await expect(fs.access(settingsFile)).rejects.toThrow()
  })

  it('合法 JSON 但根节点非对象时同样备份重置', async () => {
    await fs.mkdir(fakeUserData, { recursive: true })
    await fs.writeFile(settingsFile, '123')
    const s = await loadSettings()
    expect(s.theme).toBe('dark')
    expect(await fs.readFile(backupFile, 'utf-8')).toBe('123')
    await expect(fs.access(settingsFile)).rejects.toThrow()
  })

  it('引导层设置落盘失败同样上报，且写盘链保持可等待（C7）', async () => {
    // 占位引导层设置文件为目录：原子写 rename 到目录必然失败
    await fs.mkdir(fakeUserData, { recursive: true })
    await fs.rm(settingsFile, { force: true })
    await fs.mkdir(settingsFile, { recursive: true })
    const errors = []
    setStoreSaveErrorListener((err) => errors.push(err))
    try {
      await updateSettings({ modelsFolder: root })
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toContain('设置保存失败')
      // 失败的写盘已由链内 catch 消化：flush 不会 reject
      await expect(flushSettingsSave()).resolves.toBeUndefined()
    } finally {
      setStoreSaveErrorListener(null)
      await fs.rm(settingsFile, { recursive: true, force: true })
    }
  })

  it('设置落盘失败经监听器通知（C7），内存值运行时仍生效', async () => {
    // 占位库设置文件为目录：库层原子写 rename 到目录必然失败（设置随模型库走）
    const libSettingsFile = path.join(root, '.modelvault', 'settings.json')
    await fs.mkdir(libSettingsFile, { recursive: true })
    const errors = []
    setStoreSaveErrorListener((err) => errors.push(err))
    try {
      await updateSettings({ sortBy: 'mtime' })
      // 失败已上报且信息可辨识
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toContain('设置保存失败')
      // 内存 settings 已更新：本次运行内排序切换仍然生效（重启后才会丢失并经 Toast 提示）
      expect(getSettings().sortBy).toBe('mtime')
    } finally {
      setStoreSaveErrorListener(null)
    }
  })
})

describe('库设置并发落盘串行化（A1）', () => {
  it('并发 updateSettings 依次落盘：最终文件为最新合并快照，且不产生失败上报', async () => {
    // 库设置落盘到当前根目录的 .modelvault/settings.json（设置随模型库走）
    const libSettingsFile = path.join(root, '.modelvault', 'settings.json')
    const realRename = fs.rename.bind(fs)
    let releaseFirstRename = () => {}
    const firstRenameGate = new Promise((resolve) => {
      releaseFirstRename = resolve
    })
    let gated = false
    vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
      // 卡住库设置文件的第一次 rename，构造与后续并发写重叠的时间窗口
      if (!gated && src.includes('settings.json')) {
        gated = true
        await firstRenameGate
      }
      return realRename(src, dst)
    })

    const errors = []
    setStoreSaveErrorListener((err) => errors.push(err))
    try {
      const first = updateSettings({ theme: 'light' })
      // 等第一次写进入 rename（临时文件已写好），再发起第二次并发更新
      await vi.waitFor(() => expect(gated).toBe(true))
      const second = updateSettings({ cardSize: 'large' })
      releaseFirstRename()
      await Promise.all([first, second])

      // 串行化后无任何写失败（未串行化时：共享临时文件导致一方 rename ENOENT 被上报）
      expect(errors).toEqual([])
      // 最终落盘包含两次更新的合并结果（未串行化时可能仅剩先前的旧快照）
      const onDisk = JSON.parse(await fs.readFile(libSettingsFile, 'utf-8'))
      expect(onDisk.theme).toBe('light')
      expect(onDisk.cardSize).toBe('large')
    } finally {
      setStoreSaveErrorListener(null)
      vi.restoreAllMocks()
    }
  })

  it('排队中的库设置写入使用调度时快照与根目录：切根后不会把新库补丁写进旧库（B-02）', async () => {
    const libA = path.join(root, '.modelvault', 'settings.json')
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-snapshot-'))
    roots.push(other)
    const libB = path.join(other, '.modelvault', 'settings.json')

    const realRename = fs.rename.bind(fs)
    let releaseFirstRename = () => {}
    const firstRenameGate = new Promise((resolve) => {
      releaseFirstRename = resolve
    })
    let gated = false
    vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
      if (!gated && src.includes('settings.json')) {
        gated = true
        await firstRenameGate
      }
      return realRename(src, dst)
    })

    try {
      // 显式写入 cardSize，避免用例间共享的模块级 library 残留影响断言
      const first = updateSettings({ theme: 'light', cardSize: 'normal' })
      await vi.waitFor(() => expect(gated).toBe(true))
      // 模拟切根窗口：新根已生效，随后又产生一条库字段补丁
      setDataRoot(other)
      const second = updateSettings({ cardSize: 'large' })
      releaseFirstRename()
      await Promise.all([first, second])

      const onA = JSON.parse(await fs.readFile(libA, 'utf-8'))
      const onB = JSON.parse(await fs.readFile(libB, 'utf-8'))
      // 旧实现执行时读取全局 library，会把第二次补丁一并写进旧库 A
      expect(onA.theme).toBe('light')
      expect(onA.cardSize).toBe('normal')
      expect(onB.cardSize).toBe('large')
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('flushSettingsSave 等待在途库设置写入完成后再返回（B-02）', async () => {
    const realRename = fs.rename.bind(fs)
    let releaseRename = () => {}
    const gate = new Promise((resolve) => {
      releaseRename = resolve
    })
    let gated = false
    vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
      if (!gated && src.includes('settings.json')) {
        gated = true
        await gate
      }
      return realRename(src, dst)
    })

    try {
      const write = updateSettings({ theme: 'light' })
      await vi.waitFor(() => expect(gated).toBe(true))

      let flushed = false
      const flush = flushSettingsSave().then(() => {
        flushed = true
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(flushed).toBe(false)

      releaseRename()
      await Promise.all([write, flush])
      expect(flushed).toBe(true)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('reloadLibrarySettings 等待旧库在途写入结束后再切换内存视图（B-02）', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-reload-'))
    roots.push(other)

    const realRename = fs.rename.bind(fs)
    let releaseRename = () => {}
    const gate = new Promise((resolve) => {
      releaseRename = resolve
    })
    let gated = false
    vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
      if (!gated && src.includes('settings.json')) {
        gated = true
        await gate
      }
      return realRename(src, dst)
    })

    try {
      const pendingWrite = updateSettings({ theme: 'light' })
      await vi.waitFor(() => expect(gated).toBe(true))

      let reloaded = false
      const reload = reloadLibrarySettings(other).then(() => {
        reloaded = true
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      // 旧库写在途：重载必须等待，否则会先读到旧状态再被迟到写入影响
      expect(reloaded).toBe(false)

      releaseRename()
      await Promise.all([pendingWrite, reload])
      // 已切到 other：库设置为该库的默认值
      expect(getSettings().theme).toBe('dark')
    } finally {
      vi.restoreAllMocks()
    }
  })
})

describe('库设置随模型库存储（双层设置）', () => {
  const settingsFile = path.join(fakeUserData, 'settings.json')

  afterEach(async () => {
    await fs.rm(settingsFile, { force: true }).catch(() => {})
    await fs.rm(`${settingsFile}.bak`, { force: true }).catch(() => {})
  })

  it('旧版全局设置一次性迁移：激活库生成库设置文件，全局文件精简为引导字段', async () => {
    await fs.mkdir(fakeUserData, { recursive: true })
    // 旧版布局：全局 settings.json 承载全部字段
    await fs.writeFile(
      settingsFile,
      JSON.stringify({
        modelsFolder: root,
        modelsFolders: [root],
        theme: 'light',
        cardSize: 'large'
      })
    )
    const s = await loadSettings()
    expect(s.theme).toBe('light')
    expect(s.modelsFolder).toBe(root)
    // 库设置文件已生成并携带迁移的库字段（引导字段不入库文件）
    const libOnDisk = JSON.parse(
      await fs.readFile(path.join(root, '.modelvault', 'settings.json'), 'utf-8')
    )
    expect(libOnDisk.theme).toBe('light')
    expect(libOnDisk.cardSize).toBe('large')
    expect(libOnDisk.modelsFolder).toBeUndefined()
    expect(libOnDisk.modelsFolders).toBeUndefined()
    // 全局文件已精简为仅引导字段
    const globalOnDisk = JSON.parse(await fs.readFile(settingsFile, 'utf-8'))
    expect(globalOnDisk.modelsFolder).toBe(root)
    expect(globalOnDisk.theme).toBeUndefined()
  })

  it('切库后库设置随目标库切换（reloadLibrarySettings）', async () => {
    const libFile = path.join(root, '.modelvault', 'settings.json')
    await fs.mkdir(path.dirname(libFile), { recursive: true })
    await fs.writeFile(libFile, JSON.stringify({ theme: 'light', viewMode: 'list' }))

    await reloadLibrarySettings(root)
    expect(getSettings().theme).toBe('light')
    expect(getSettings().viewMode).toBe('list')

    // 切到无库设置文件的另一个库：以默认值初始化并落盘
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-libswitch-'))
    roots.push(other)
    await reloadLibrarySettings(other)
    expect(getSettings().theme).toBe('dark')
    const otherOnDisk = JSON.parse(
      await fs.readFile(path.join(other, '.modelvault', 'settings.json'), 'utf-8')
    )
    expect(otherOnDisk.theme).toBe('dark')
  })

  it('库设置文件损坏时备份为 .bak 后以默认值重置', async () => {
    const libFile = path.join(root, '.modelvault', 'settings.json')
    await fs.mkdir(path.dirname(libFile), { recursive: true })
    await fs.writeFile(libFile, '{broken!!')
    await reloadLibrarySettings(root)
    expect(getSettings().theme).toBe('dark')
    expect(await fs.readFile(`${libFile}.bak`, 'utf-8')).toBe('{broken!!')
    await expect(fs.access(libFile)).rejects.toThrow()
  })

  it('无激活库时库字段仅内存生效，引导字段仍正常落盘', async () => {
    setDataRoot(null)
    try {
      await updateSettings({ theme: 'light' })
      expect(getSettings().theme).toBe('light')
      // 引导字段不受影响，照常写入全局文件
      await updateSettings({ modelsFolder: root })
      const onDisk = JSON.parse(await fs.readFile(settingsFile, 'utf-8'))
      expect(onDisk.modelsFolder).toBe(root)
    } finally {
      setDataRoot(root)
    }
  })
})

describe('旧版存储迁移', () => {
  it('不同模型的同名封面迁移互不覆盖（B6）', async () => {
    const legacyFile = path.join(fakeUserData, 'store.json')
    try {
      // 伪造两个同名但内容不同的旧版封面（分属不同目录）
      const oldDir = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-oldcovers-'))
      const coverA = path.join(oldDir, 'a', 'preview.png')
      const coverB = path.join(oldDir, 'b', 'preview.png')
      await fs.mkdir(path.dirname(coverA), { recursive: true })
      await fs.mkdir(path.dirname(coverB), { recursive: true })
      await fs.writeFile(coverA, 'CONTENT-A')
      await fs.writeFile(coverB, 'CONTENT-B')

      // 模型文件占位 + 旧版全局存储（绝对路径键 + 绝对路径封面）
      const m1 = await touchModel('m1.safetensors')
      const m2 = await touchModel('m2.safetensors')
      await fs.mkdir(fakeUserData, { recursive: true })
      await fs.writeFile(
        legacyFile,
        JSON.stringify({
          models: {
            [m1]: { cover: coverA, alias: 'A' },
            [m2]: { cover: coverB, alias: 'B' }
          }
        })
      )

      // 重新加载：新 store.json 不存在时触发旧版迁移
      await loadData()

      const metaA = getModelMeta(m1)
      const metaB = getModelMeta(m2)
      expect(metaA.cover).toBeTruthy()
      expect(metaB.cover).toBeTruthy()
      // 同名源文件必须迁移为不同目标名
      expect(metaA.cover).not.toBe(metaB.cover)
      // 内容未互换
      expect(await fs.readFile(resolveCover(metaA.cover), 'utf-8')).toBe('CONTENT-A')
      expect(await fs.readFile(resolveCover(metaB.cover), 'utf-8')).toBe('CONTENT-B')
    } finally {
      // 清理 legacy 文件，避免污染其他用例的 loadData
      await fs.rm(legacyFile, { force: true })
    }
  })
})

describe('库离线写入防护（O5）', () => {
  it('根目录离线时跳过元数据落盘且不重建目录，恢复后补写内存修改', async () => {
    const abs = path.join(root, 'offline.safetensors')
    setModelMeta(abs, { note: '离线修改' })
    // 模拟库被移动/盘符卸载：整个根目录消失
    await fs.rm(root, { recursive: true, force: true })

    await saveStoreNow()
    // 已安排重试时再次保存直接复用定时器（不重复调度）
    await saveStoreNow()
    // 关键：写链不得通过 mkdir 把根目录/.modelvault 重新建出来
    await expect(fs.access(root)).rejects.toThrow()

    // 库恢复可用：内存中的修改在下一次保存时补写
    await fs.mkdir(root)
    await saveStoreNow()
    const parsed = JSON.parse(
      await fs.readFile(path.join(root, '.modelvault', 'store.json'), 'utf-8')
    )
    expect(parsed.models['offline.safetensors'].note).toBe('离线修改')
  })

  it('库根路径变成普通文件时同样跳过落盘（目录判定）', async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.writeFile(root, 'not-a-directory')

    await saveStoreNow()

    // 路径仍是文件，未被写链替换为目录树
    expect((await fs.stat(root)).isFile()).toBe(true)
  })

  it('根目录可用时连续保存复用探测缓存', async () => {
    const abs = path.join(root, 'cached.safetensors')
    setModelMeta(abs, { note: 'v1' })
    await saveStoreNow()

    setModelMeta(abs, { note: 'v2' })
    await saveStoreNow()

    const parsed = JSON.parse(
      await fs.readFile(path.join(root, '.modelvault', 'store.json'), 'utf-8')
    )
    expect(parsed.models['cached.safetensors'].note).toBe('v2')
  })

  it('atomicWriteFile createDirs:false 不创建缺失目录', async () => {
    const target = path.join(root, 'missing', 'x.json')
    await expect(atomicWriteFile(target, 'x', { createDirs: false })).rejects.toThrow()
    await expect(fs.access(path.join(root, 'missing'))).rejects.toThrow()
  })

  it('库目录离线时设置更新不重建目录（内存仍生效）', async () => {
    await fs.rm(root, { recursive: true, force: true })

    await updateSettings({ theme: 'light' })

    expect(getSettings().theme).toBe('light')
    await expect(fs.access(root)).rejects.toThrow()
  })
})
