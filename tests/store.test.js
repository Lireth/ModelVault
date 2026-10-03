import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  atomicWriteFile,
  flushStoreSave,
  getModelMeta,
  getSettings,
  isInRoot,
  loadData,
  loadSettings,
  removeModelMeta,
  resolveCover,
  saveStoreNow,
  setDataRoot,
  setModelHash,
  setModelMeta,
  setStoreSaveErrorListener,
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
})

describe('文件哈希持久化', () => {
  it('合法哈希写入成功，非法哈希拒绝', async () => {
    const abs = await touchModel('hash-model.safetensors')
    setModelMeta(abs, { alias: 'hash' })
    const good = 'a'.repeat(64)
    expect(setModelHash(abs, good, 12345)).toBe(true)
    const meta = getModelMeta(abs)
    expect(meta.hash).toBe(good)
    expect(meta.hashMtime).toBe(12345)
    expect(setModelHash(abs, 'not-a-hash', 1)).toBe(false)
    expect(setModelHash(abs, 'A'.repeat(64), 1)).toBe(true) // 大写 hex 自动转小写
    expect(getModelMeta(abs).hash).toBe('a'.repeat(64))
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

  it('设置落盘失败经监听器通知（C7），内存值运行时仍生效', async () => {
    // 占位 settings.json 为目录：原子写 rename 到目录必然失败
    await fs.rm(settingsFile, { force: true }).catch(() => {})
    await fs.mkdir(settingsFile, { recursive: true })
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
      await fs.rm(settingsFile, { recursive: true, force: true }).catch(() => {})
    }
  })
})

describe('settings.json 并发落盘串行化（A1）', () => {
  const settingsFile = path.join(fakeUserData, 'settings.json')

  afterEach(async () => {
    await fs.rm(settingsFile, { force: true }).catch(() => {})
  })

  it('并发 updateSettings 依次落盘：最终文件为最新合并快照，且不产生失败上报', async () => {
    const realRename = fs.rename.bind(fs)
    let releaseFirstRename = () => {}
    const firstRenameGate = new Promise((resolve) => {
      releaseFirstRename = resolve
    })
    let gated = false
    vi.spyOn(fs, 'rename').mockImplementation(async (src, dst) => {
      // 卡住 settings.json 的第一次 rename，构造与后续并发写重叠的时间窗口
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
      const onDisk = JSON.parse(await fs.readFile(settingsFile, 'utf-8'))
      expect(onDisk.theme).toBe('light')
      expect(onDisk.cardSize).toBe('large')
    } finally {
      setStoreSaveErrorListener(null)
      vi.restoreAllMocks()
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
