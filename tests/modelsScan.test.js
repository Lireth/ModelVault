import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { BrowserWindow, dialog, nativeImage } from 'electron'
import { fakeUserData } from './setup'
import { getRegisteredHandler, makeEvent, makeWindow } from './helpers/modelsIpc'

/**
 * models 域扫描与存储 handler 特征测试（D1，先测后拆基线）：
 * - models:scan 防重入（scanning 同步置位）/ 取消（AbortError -> { canceled: true }）
 * - 扫描进度推送节流与 isDestroyed 守卫（B4 行为）
 * - models:loadStore 单例一致性（ensureRootStore 不重复加载）
 * - models:chooseFolder / settings:update
 * 说明：scanModels 为耗时领域操作，此处 mock scanner 模块（仅覆写 scanModels，
 * 其余导出保留真实实现），装饰链对空模型数组空转。
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  BrowserWindow: Object.assign(vi.fn(), {
    fromWebContents: vi.fn(),
    getAllWindows: vi.fn(() => [])
  }),
  clipboard: { read: vi.fn(), writeText: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  shell: { trashItem: vi.fn(), showItemInFolder: vi.fn() },
  net: { fetch: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn(), createFromPath: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() }
}))

vi.mock('../src/main/services/scanner.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, scanModels: vi.fn() }
})

// setStoreSaveErrorListener 的广播使用 getAllWindows（注册时不触发，桩需存在）
vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([])

import { registerModelIpcHandlers } from '../src/main/ipc/models/index'
import { scanModels } from '../src/main/services/scanner'
import { loadSettings, setDataRoot, updateSettings } from '../src/main/services/store'
import { drainDeferredThumbs, getThumbPathDeferred } from '../src/main/services/thumbs'

const settingsFile = path.join(fakeUserData, 'settings.json')
const roots = []
let root
let releaseScan

/** 将 scanModels mock 挂起（返回手动释放的 Promise），释放时可指定正常返回或 AbortError */
function hangScanModels() {
  releaseScan = null
  vi.mocked(scanModels).mockImplementation((_rootDir, _onProgress, opts) =>
    new Promise((resolve, reject) => {
      releaseScan = () =>
        opts?.signal?.aborted
          ? reject(Object.assign(new Error('扫描已取消'), { name: 'AbortError' }))
          : resolve({ models: [], errors: [], dirCount: 0 })
    })
  )
}

/** 等待挂起的 scanModels 被真正调用（handler 内部有多个 await 才到达） */
async function waitForScanStarted() {
  const deadline = Date.now() + 5000
  while (typeof releaseScan !== 'function' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(typeof releaseScan).toBe('function')
}

/**
 * 把目录注册为模型库（B1 后扫描的前置条件）：
 * models:scan 只接受 settings.modelsFolders 白名单内的目录，
 * 经 updateSettings 写入的目录自动进入白名单（并附存在性校验语义）
 */
async function registerLibrary(dir) {
  await updateSettings({ modelsFolder: dir })
}

beforeEach(async () => {
  registerModelIpcHandlers()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-scan-'))
  roots.push(root)
  setDataRoot(root)
  await loadSettings()
})

afterEach(async () => {
  // settings.json 由 updateSettings/chooseFolder 用例写入，清理防跨用例污染
  await fs.rm(settingsFile, { force: true }).catch(() => {})
  vi.mocked(dialog.showOpenDialog).mockReset()
})

afterAll(async () => {
  for (const dir of roots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('models:scan 防重入（B4）', () => {
  it('扫描进行中时并发请求立即拒绝', async () => {
    const scan = getRegisteredHandler('models:scan')
    hangScanModels()
    await registerLibrary(root)
    const first = scan(makeEvent(), { folder: root })
    // 第二个并发请求必须同步被拒（scanning 在任何 await 前置位）
    const second = await scan(makeEvent(), { folder: root })
    expect(second).toEqual({ error: '正在扫描中，请稍候' })
    // 释放首个扫描并确认正常完成、标志复位
    await waitForScanStarted()
    releaseScan()
    const result = await first
    expect(result.root).toBe(root)
    expect(result.models).toEqual([])
  })
})

describe('models:scan 取消', () => {
  it('cancelScan 中止后返回 { canceled: true }', async () => {
    const scan = getRegisteredHandler('models:scan')
    const cancel = getRegisteredHandler('models:cancelScan')
    hangScanModels()
    await registerLibrary(root)
    const pending = scan(makeEvent(), { folder: root })
    await waitForScanStarted()
    expect(await cancel(makeEvent(), {})).toEqual({ ok: true })
    releaseScan() // signal 已 aborted -> mock 以 AbortError reject
    expect(await pending).toEqual({ canceled: true })
    // 取消后标志复位，可立即重新扫描
    hangScanModels()
    const next = scan(makeEvent(), { folder: root })
    await waitForScanStarted()
    releaseScan()
    expect((await next).root).toBe(root)
  })

  it('空闲时 cancelScan 返回 { ok: false }，无副作用', async () => {
    const cancel = getRegisteredHandler('models:cancelScan')
    expect(await cancel(makeEvent(), {})).toEqual({ ok: false })
  })
})

describe('切根扫描清空延迟缩略图队列（C5）', () => {
  it('旧根登记的缩略图任务在切换根目录扫描后不再跨根生成', async () => {
    // 旧根：真实封面文件登记延迟缩略图任务（getThumbPathDeferred 未命中缓存即登记）
    const coverA = path.join(root, 'cover-a.png')
    await fs.writeFile(coverA, 'png-bytes')
    expect(await getThumbPathDeferred(coverA)).toBe('')

    // 解码桩：若清理失效，旧根条目会在新根目录下生成成功并触发回调
    vi.mocked(nativeImage.createFromBuffer).mockReturnValue({
      isEmpty: () => false,
      getSize: () => ({ width: 1200, height: 800 }),
      resize() { return this },
      toJPEG: () => Buffer.from('fake-jpeg')
    })

    // 切换到新根目录扫描：切根分支应同步清空 deferredJobs/deferredOwners
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-scan-b-'))
    roots.push(rootB)
    await registerLibrary(rootB)
    vi.mocked(scanModels).mockResolvedValue({ models: [], errors: [], dirCount: 0 })
    const scan = getRegisteredHandler('models:scan')
    const res = await scan(makeEvent(), { folder: rootB })
    expect(res.root).toBe(rootB)

    // 队列已清空：手动 drain 不为旧根封面生成，新根 thumbs 目录不被写入
    const generated = []
    await drainDeferredThumbs((absCover, thumbPath) => generated.push({ absCover, thumbPath }))
    expect(generated).toHaveLength(0)
    await expect(fs.readdir(path.join(rootB, '.modelvault', 'thumbs'))).rejects.toThrow()
  })
})

describe('models:scan 进度推送（B4 守卫）', () => {
  it('进度经 scanProgress 推送并按间隔节流', async () => {
    const scan = getRegisteredHandler('models:scan')
    const win = makeWindow()
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(win)
    await registerLibrary(root)
    // 同步两次 onProgress 间隔小于 PROGRESS_INTERVAL(120ms)，仅推送一次
    vi.mocked(scanModels).mockImplementation(async (rootDir, onProgress) => {
      onProgress({ dirs: 1, found: 1, current: 'a.safetensors' })
      onProgress({ dirs: 1, found: 2, current: 'b.safetensors' })
      return { models: [], errors: [], dirCount: 1 }
    })
    await scan(makeEvent(win), { folder: root })
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledWith('models:scanProgress', {
      dirs: 1,
      found: 1,
      current: 'a.safetensors'
    })
  })

  it('窗口已销毁（isDestroyed）时不发送也不抛异常', async () => {
    const scan = getRegisteredHandler('models:scan')
    const win = makeWindow({ destroyed: true })
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(win)
    await registerLibrary(root)
    vi.mocked(scanModels).mockImplementation(async (rootDir, onProgress) => {
      onProgress({ dirs: 1, found: 1, current: 'a.safetensors' })
      return { models: [], errors: [], dirCount: 1 }
    })
    const result = await scan(makeEvent(win), { folder: root })
    expect(result.root).toBe(root)
    expect(win.webContents.send).not.toHaveBeenCalled()
  })
})

describe('models:scan 模型库白名单（B1）', () => {
  it('拒绝扫描模型库列表之外的目录：未执行扫描、未创建 .modelvault', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-scan-outside-'))
    roots.push(outside)
    // settings 为全新默认（modelsFolders 为空）：outside 是可写目录但不在白名单
    vi.mocked(scanModels).mockResolvedValue({ models: [], errors: [], dirCount: 0 })
    const scan = getRegisteredHandler('models:scan')
    const res = await scan(makeEvent(), { folder: outside })
    expect(res).toEqual({ error: '该目录不在模型库列表中' })
    // 扫描未执行，关联存储目录未被创建（渲染可控的任意目录写入面关闭）
    expect(vi.mocked(scanModels)).not.toHaveBeenCalled()
    await expect(fs.access(path.join(outside, '.modelvault'))).rejects.toThrow()
  })

  it('白名单内的目录正常扫描（Windows 大小写不敏感）', async () => {
    vi.mocked(scanModels).mockResolvedValue({ models: [], errors: [], dirCount: 0 })
    await registerLibrary(root)
    const variant = process.platform === 'win32' ? root.toUpperCase() : root
    if (variant === root) return // 大小写不敏感平台上该用例无区分度
    const scan = getRegisteredHandler('models:scan')
    const res = await scan(makeEvent(), { folder: variant })
    expect(res.root).toBe(variant)
  })
})

describe('models:scan 目录校验与回写（C6）', () => {
  it('不存在的目录拒绝扫描', async () => {
    const scan = getRegisteredHandler('models:scan')
    const res = await scan(makeEvent(), { folder: path.join(root, 'no-such-dir') })
    expect(res).toEqual({ error: '模型文件夹不存在或不是目录' })
  })

  it('路径为文件时拒绝扫描', async () => {
    const file = path.join(root, 'a-file.safetensors')
    await fs.writeFile(file, 'x')
    const scan = getRegisteredHandler('models:scan')
    const res = await scan(makeEvent(), { folder: file })
    expect(res).toEqual({ error: '模型文件夹不存在或不是目录' })
  })

  it('显式传入白名单内目录扫描成功后回写 settings.modelsFolder', async () => {
    // root 为当前激活库，rootB 同在白名单但非激活：扫描 rootB 后激活根应切到 rootB
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-scan-writeback-'))
    roots.push(rootB)
    await updateSettings({ modelsFolder: root, modelsFolders: [root, rootB] })
    vi.mocked(scanModels).mockResolvedValue({ models: [], errors: [], dirCount: 0 })
    const scan = getRegisteredHandler('models:scan')
    const res = await scan(makeEvent(), { folder: rootB })
    expect(res.root).toBe(rootB)
    const { modelsFolder } = await loadSettings()
    expect(modelsFolder).toBe(rootB)
  })
})

describe('models:loadStore', () => {
  it('返回设置与元数据映射；连续调用结果一致（ensureRootStore 不重复加载）', async () => {
    await updateSettings({ modelsFolder: root })
    const loadStore = getRegisteredHandler('models:loadStore')
    const first = await loadStore(makeEvent(), {})
    expect(first.settings.modelsFolder).toBe(root)
    expect(first.models).toEqual({})
    const second = await loadStore(makeEvent(), {})
    expect(second.models).toEqual(first.models)
    expect(second.settings.modelsFolder).toBe(root)
  })

  it('已设置的目录不存在时跳过关联存储加载，返回空元数据映射（C6 任意目录写入防护）', async () => {
    await updateSettings({ modelsFolder: root })
    await fs.rm(root, { recursive: true, force: true })
    const loadStore = getRegisteredHandler('models:loadStore')
    const res = await loadStore(makeEvent(), {})
    expect(res.settings.modelsFolder).toBe(root)
    expect(res.models).toEqual({})
  })
})

describe('models:chooseFolder', () => {
  it('对话框确认后持久化并返回所选目录', async () => {
    const chooseFolder = getRegisteredHandler('models:chooseFolder')
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [root] })
    expect(await chooseFolder(makeEvent(), {})).toBe(root)
    const { modelsFolder } = await loadSettings()
    expect(modelsFolder).toBe(root)
  })

  it('对话框取消返回 null 且不修改设置', async () => {
    const chooseFolder = getRegisteredHandler('models:chooseFolder')
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await chooseFolder(makeEvent(), {})).toBeNull()
  })
})

describe('settings:update', () => {
  it('合并更新并返回规范化后的完整设置', async () => {
    const update = getRegisteredHandler('settings:update')
    const res = await update(makeEvent(), { sortBy: 'type' })
    expect(res.error).toBeUndefined()
    expect(res.settings.sortBy).toBe('type')
    // 增量合并：其余字段保留默认值
    expect(res.settings.theme).toBe('dark')
  })

  it('变更 modelsFolder 为不存在的路径时拒绝且不落盘（任意目录写入防护）', async () => {
    const update = getRegisteredHandler('settings:update')
    const res = await update(makeEvent(), { modelsFolder: path.join(root, 'no-such-dir') })
    expect(res.error).toContain('模型文件夹不存在或不是目录')
    const { modelsFolder } = await loadSettings()
    expect(modelsFolder).toBe('')
  })

  it('变更 modelsFolder 为真实存在的目录时接受', async () => {
    const update = getRegisteredHandler('settings:update')
    const res = await update(makeEvent(), { modelsFolder: root })
    expect(res.error).toBeUndefined()
    expect(res.settings.modelsFolder).toBe(root)
  })

  it('modelsFolder 与当前值相同时跳过存在性校验（目录暂时离线仍可保存其他设置）', async () => {
    const update = getRegisteredHandler('settings:update')
    await updateSettings({ modelsFolder: root })
    await fs.rm(root, { recursive: true, force: true })
    const res = await update(makeEvent(), { sortBy: 'mtime', modelsFolder: root })
    expect(res.error).toBeUndefined()
    expect(res.settings.sortBy).toBe('mtime')
  })
})
