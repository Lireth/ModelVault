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

// watcher 监听行为由 tests/watcher.test.js 单测覆盖；此处仅收集 syncWatcher 调用参数，
// 用于断言扫描完成时以「最新设置」而非扫描前快照同步排除名单（E8 竞态回归）
vi.mock('../src/main/services/watcher.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, syncWatcher: vi.fn() }
})

// setStoreSaveErrorListener 的广播使用 getAllWindows（注册时不触发，桩需存在）
vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([])

import { registerModelIpcHandlers } from '../src/main/ipc/models/index'
import { scanModels } from '../src/main/services/scanner'
import { syncWatcher } from '../src/main/services/watcher'
import {
  getCurrentRoot,
  loadData,
  loadSettings,
  setDataRoot,
  updateSettings
} from '../src/main/services/store'
import {
  MAX_PARTIAL_SCAN_DIRS,
  collapseDirsToTopLevel,
  normalizePartialScanDirs
} from '../src/shared/scan-dirs'
import { drainDeferredThumbs, getThumbPathDeferred } from '../src/main/services/thumbs'
import { decorateModels } from '../src/main/ipc/models/decorate'

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

describe('models:partialScan（A-03）', () => {
  it('全量扫描进行中局部扫描立即拒绝（共用扫描锁）', async () => {
    const scan = getRegisteredHandler('models:scan')
    const partial = getRegisteredHandler('models:partialScan')
    hangScanModels()
    await registerLibrary(root)
    const pending = scan(makeEvent(), { folder: root })
    await waitForScanStarted()

    const blocked = await partial(makeEvent(), { folder: root, dirs: [''] })
    expect(blocked).toEqual({ error: '正在扫描中，请稍候' })

    releaseScan()
    await pending
  })

  it('合法子树局部扫描成功（mock 扫描器返回局部模型）', async () => {
    const partial = getRegisteredHandler('models:partialScan')
    await registerLibrary(root)
    vi.mocked(scanModels).mockResolvedValue({ models: [], errors: [], dirCount: 1 })
    const res = await partial(makeEvent(), { folder: root, dirs: ['lora'] })
    expect(res.error).toBeUndefined()
    expect(res.dirs).toEqual(['lora'])
    // subDirs 透传给扫描器
    expect(vi.mocked(scanModels).mock.calls.at(-1)[2].subDirs).toEqual(['lora'])
  })

  it('OPT-07：局部扫描跳过装饰缓存，新增 sidecar 即时导入', async () => {
    await registerLibrary(root)
    const abs = path.join(root, 'late-sidecar.safetensors')
    await fs.writeFile(abs, 'x')
    const model = {
      id: abs,
      name: 'late-sidecar',
      ext: '.safetensors',
      relDir: '',
      folder: root,
      type: 'lora',
      size: 1,
      mtimeMs: 1
    }
    // 该测试文件不经过 loadStore 链路；显式加载当前根元数据，使 sidecar
    // 导入的 setModelMeta 能落到内存存储（与生产启动时序一致）
    await loadData()
    // 首次装饰建立缓存（此时无 sidecar）
    await decorateModels([model])
    await fs.writeFile(
      path.join(root, 'late-sidecar.civitai.info'),
      JSON.stringify({ trainedWords: ['late-tag'] })
    )
    vi.mocked(scanModels).mockResolvedValue({ models: [model], errors: [], dirCount: 1 })

    const res = await getRegisteredHandler('models:partialScan')(makeEvent(), {
      folder: root,
      dirs: ['']
    })

    // 模型 mtime 未变，仍必须重新检查 sidecar（forceRefresh 由局部扫描传入）
    expect(res.models[0].triggerWords).toBe('late-tag')
  })

  it('局部扫描应用用户配置的扫描扩展名（B3：与全量结果一致）', async () => {
    const partial = getRegisteredHandler('models:partialScan')
    await registerLibrary(root)
    await updateSettings({ scanExtensions: ['.safetensors'] })
    vi.mocked(scanModels).mockResolvedValue({ models: [], errors: [], dirCount: 1 })

    const res = await partial(makeEvent(), { folder: root, dirs: [''] })
    expect(res.error).toBeUndefined()
    // 此前局部扫描落回默认全集：用户排除的扩展名（如 .ckpt）会在 watcher
    // 触发一次增量重扫后“复活”，局部结果与全量结果不一致
    expect(vi.mocked(scanModels).mock.calls.at(-1)[2].extensions).toEqual(['.safetensors'])
  })

  it('未改设置时局部扫描透传规范化的全量扩展名（非 undefined 全集）', async () => {
    const partial = getRegisteredHandler('models:partialScan')
    await registerLibrary(root)
    vi.mocked(scanModels).mockResolvedValue({ models: [], errors: [], dirCount: 1 })

    await partial(makeEvent(), { folder: root, dirs: [''] })

    const extensions = vi.mocked(scanModels).mock.calls.at(-1)[2].extensions
    expect(Array.isArray(extensions)).toBe(true)
    expect(extensions.length).toBeGreaterThan(0)
  })

  it('局部扫描在首个 await 前持有扫描锁：并发局部请求立即拒绝（B-01）', async () => {
    const partial = getRegisteredHandler('models:partialScan')
    await registerLibrary(root)
    hangScanModels()

    const first = partial(makeEvent(), { folder: root, dirs: ['lora'] })
    await waitForScanStarted()

    // 此前锁在 checkExistingDirectory 之后才置位，此处会穿透并发出第二条扫描
    const second = await partial(makeEvent(), { folder: root, dirs: ['vae'] })
    expect(second).toEqual({ error: '正在扫描中，请稍候' })

    releaseScan()
    const result = await first
    expect(result.error).toBeUndefined()
    expect(result.dirs).toEqual(['lora'])
  })

  it('父子重叠与重复子树去重：只扫描祖先一次（B-01）', async () => {
    const partial = getRegisteredHandler('models:partialScan')
    await registerLibrary(root)
    vi.mocked(scanModels).mockResolvedValue({ models: [], errors: [], dirCount: 1 })

    const res = await partial(makeEvent(), {
      folder: root,
      dirs: ['lora', 'lora/sub', 'lora', 'vae/deep']
    })

    expect(res.error).toBeUndefined()
    // 后代 lora/sub 被祖先 lora 覆盖；精确重复只保留一份
    expect(res.dirs).toEqual(['lora', 'vae/deep'])
    expect(vi.mocked(scanModels).mock.calls.at(-1)[2].subDirs).toEqual(['lora', 'vae/deep'])
  })

  it('O3：子树超过业务上限时收敛为一级目录后继续局部扫描（不截断）', async () => {
    const partial = getRegisteredHandler('models:partialScan')
    await registerLibrary(root)
    vi.mocked(scanModels).mockResolvedValue({ models: [], errors: [], dirCount: 1 })
    const dirs = Array.from({ length: 205 }, (_, i) => `bulk/item-${i}`)

    const res = await partial(makeEvent(), { folder: root, dirs })

    expect(res.dirs).toEqual(['bulk'])
    expect(vi.mocked(scanModels).mock.calls.at(-1)[2].subDirs).toEqual(['bulk'])
  })

  it('O3：一级目录仍超过业务上限时返回 fullScanRequired，不执行局部扫描', async () => {
    const partial = getRegisteredHandler('models:partialScan')
    await registerLibrary(root)
    vi.mocked(scanModels).mockResolvedValue({ models: [], errors: [], dirCount: 1 })
    const callsBefore = vi.mocked(scanModels).mock.calls.length
    const dirs = Array.from({ length: 205 }, (_, i) => `top${i}`)

    const res = await partial(makeEvent(), { folder: root, dirs })

    expect(res).toEqual({ fullScanRequired: true })
    expect(vi.mocked(scanModels).mock.calls.length).toBe(callsBefore)
  })

  it('根直属空串与子树并存时两者都保留（语义不重叠）', async () => {
    const partial = getRegisteredHandler('models:partialScan')
    await registerLibrary(root)
    vi.mocked(scanModels).mockResolvedValue({ models: [], errors: [], dirCount: 1 })

    const res = await partial(makeEvent(), { folder: root, dirs: ['', 'lora'] })

    expect(res.dirs).toEqual(['', 'lora'])
  })

  it('参数非法时释放扫描锁，后续合法请求可正常进入（B-01）', async () => {
    const partial = getRegisteredHandler('models:partialScan')
    await registerLibrary(root)
    vi.mocked(scanModels).mockResolvedValue({ models: [], errors: [], dirCount: 1 })

    expect((await partial(makeEvent(), { folder: root, dirs: ['../escape'] })).error).toBe(
      '变更子树参数无效'
    )
    expect((await partial(makeEvent(), { folder: root, dirs: ['C:/abs'] })).error).toBe(
      '变更子树参数无效'
    )
    const ok = await partial(makeEvent(), { folder: root, dirs: ['lora'] })
    expect(ok.error).toBeUndefined()
  })

  it('请求根与当前根不一致时拒绝，绝不把主进程切回旧库（V-02）', async () => {
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-partial-other-'))
    roots.push(rootB)
    await updateSettings({ modelsFolder: root, modelsFolders: [root, rootB] })
    vi.mocked(scanModels).mockResolvedValue({ models: [], errors: [], dirCount: 1 })
    const partial = getRegisteredHandler('models:partialScan')
    const callsBefore = vi.mocked(scanModels).mock.calls.length

    const res = await partial(makeEvent(), { folder: rootB, dirs: ['lora'] })

    expect(res.error).toBe('模型库已切换，请稍后重试')
    expect(getCurrentRoot()).toBe(root)
    expect(vi.mocked(scanModels).mock.calls.length).toBe(callsBefore)
  })
})

describe('局部扫描子树超限（O3：不静默截断）', () => {
  it('超过上限时收敛为一级目录，语义等价覆盖全部变更子树', () => {
    const dirs = Array.from({ length: MAX_PARTIAL_SCAN_DIRS + 1 }, (_, i) => `bulk/item-${i}`)
    const res = normalizePartialScanDirs(dirs)
    expect(res).toEqual({ subDirs: ['bulk'], collapsed: true })
  })

  it('一级目录仍超过上限时返回 fullScanRequired，而不是丢弃部分子树', () => {
    const dirs = Array.from({ length: MAX_PARTIAL_SCAN_DIRS + 1 }, (_, i) => `top${i}`)
    const res = normalizePartialScanDirs(dirs)
    expect(res).toEqual({ fullScanRequired: true })
    expect(collapseDirsToTopLevel(dirs)).toHaveLength(MAX_PARTIAL_SCAN_DIRS + 1)
  })

  it('校验全部条目：超限输入里的非法项不会被数量上限掩盖', () => {
    const dirs = Array.from({ length: MAX_PARTIAL_SCAN_DIRS }, (_, i) => `bulk/item-${i}`)
    dirs.push('../escape')
    expect(normalizePartialScanDirs(dirs)).toEqual({ error: '变更子树参数无效' })
  })

  it('去重与后代剔除后不超限时保持原始顺序', () => {
    expect(
      normalizePartialScanDirs(['vae', 'lora', 'lora/sub', 'vae/deep', 'lora'])
    ).toEqual({ subDirs: ['vae', 'lora'] })
  })

  it('一级目录收敛保留根直属空串（不递归子目录，语义不重叠）', () => {
    expect(collapseDirsToTopLevel(['', 'a/1', 'a/2', 'b/1'])).toEqual(['', 'a', 'b'])
  })
})

describe('局部扫描不清理子树外缩略图（OPT-1 修复）', () => {
  it('partialScan 跳过缩略图清理：非本次装饰产出的缩略图文件保留', async () => {
    const partial = getRegisteredHandler('models:partialScan')
    await registerLibrary(root)
    // 预置一个「子树外模型」的缩略图文件（模拟此前全量扫描的产物）
    const thumbsDir = path.join(root, '.modelvault', 'thumbs')
    await fs.mkdir(thumbsDir, { recursive: true })
    const externalThumb = path.join(thumbsDir, 'external-1.jpg')
    await fs.writeFile(externalThumb, 'jpeg-bytes')
    // mock 扫描器返回空列表：局部装饰 usedThumbs 为空
    vi.mocked(scanModels).mockResolvedValue({ models: [], errors: [], dirCount: 1 })

    const res = await partial(makeEvent(), { folder: root, dirs: ['lora'] })
    expect(res.error).toBeUndefined()
    // 修复前：decorateModels 按局部 usedThumbs 清理，子树外缩略图被全部误删，
    // 且装饰缓存命中路径不会重新生成，坏图持续到元数据变化
    await expect(fs.access(externalThumb)).resolves.toBeUndefined()
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
    expect(await cancel(makeEvent())).toEqual({ ok: true })
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
    expect(await cancel(makeEvent())).toEqual({ ok: false })
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

  it('切库扫描失败时回滚主进程根目录，保持原激活库（V-02）', async () => {
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-scan-rollback-'))
    roots.push(rootB)
    await updateSettings({ modelsFolder: root, modelsFolders: [root, rootB] })
    vi.mocked(scanModels).mockRejectedValue(new Error('磁盘错误'))
    const scan = getRegisteredHandler('models:scan')

    const res = await scan(makeEvent(), { folder: rootB })

    expect(res.error).toContain('磁盘错误')
    // 已切到 rootB 后扫描失败：必须回滚到原根，避免渲染层旧列表与主进程根错位
    expect(getCurrentRoot()).toBe(root)
    const { modelsFolder } = await loadSettings()
    expect(modelsFolder).toBe(root)
  })
})

describe('扫描完成以最新设置同步目录监控（E8 竞态回归）', () => {
  it('扫描期间 settings:update 变更 excludeDirs 后，扫描完成同步 watcher 用新名单而非扫描前快照', async () => {
    vi.mocked(syncWatcher).mockClear()
    const scan = getRegisteredHandler('models:scan')
    const update = getRegisteredHandler('settings:update')
    await registerLibrary(root)

    // 扫描挂起期间，用户经 settings:update 更新排除名单
    hangScanModels()
    const pending = scan(makeEvent(), { folder: root })
    await waitForScanStarted()
    await update(makeEvent(), { excludeDirs: ['temp-out'] })
    expect(syncWatcher).toHaveBeenCalledWith(root, false, ['temp-out'])

    // 扫描完成后的同步调用必须携带最新名单（旧实现回退为扫描前的 []）
    releaseScan()
    await pending
    const calls = vi.mocked(syncWatcher).mock.calls
    expect(calls.at(-1)).toEqual([root, false, ['temp-out']])
  })
})

describe('models:loadStore', () => {
  it('返回设置与元数据映射；连续调用结果一致（ensureRootStore 不重复加载）', async () => {
    await updateSettings({ modelsFolder: root })
    const loadStore = getRegisteredHandler('models:loadStore')
    const first = await loadStore(makeEvent())
    expect(first.settings.modelsFolder).toBe(root)
    expect(first.models).toEqual({})
    const second = await loadStore(makeEvent())
    expect(second.models).toEqual(first.models)
    expect(second.settings.modelsFolder).toBe(root)
  })

  it('已设置的目录不存在时跳过关联存储加载，返回空元数据映射（C6 任意目录写入防护）', async () => {
    await updateSettings({ modelsFolder: root })
    await fs.rm(root, { recursive: true, force: true })
    const loadStore = getRegisteredHandler('models:loadStore')
    const res = await loadStore(makeEvent())
    expect(res.settings.modelsFolder).toBe(root)
    expect(res.models).toEqual({})
  })
})

describe('models:chooseFolder', () => {
  it('对话框确认后加入库列表并返回所选目录，激活由扫描成功后提交（V-02）', async () => {
    const chooseFolder = getRegisteredHandler('models:chooseFolder')
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [root] })
    expect(await chooseFolder(makeEvent())).toBe(root)
    const settings = await loadSettings()
    // 目录进入库列表（供后续 models:scan 白名单校验），但不提前成为激活库
    expect(settings.modelsFolders).toContain(root)
    expect(settings.modelsFolder).not.toBe(root)
  })

  it('对话框取消返回 null 且不修改设置', async () => {
    const chooseFolder = getRegisteredHandler('models:chooseFolder')
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await chooseFolder(makeEvent())).toBeNull()
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

  it('已登记模型库可被设置为激活根', async () => {
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-scan-b-'))
    roots.push(rootB)
    await updateSettings({ modelsFolder: root, modelsFolders: [root, rootB] })
    const update = getRegisteredHandler('settings:update')
    const res = await update(makeEvent(), { modelsFolder: rootB })
    expect(res.error).toBeUndefined()
    expect(res.settings.modelsFolder).toBe(rootB)
  })

  it('变更 modelsFolder 为真实存在但未登记的目录时拒绝且不落盘（新增库只能走对话框）', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-scan-outside-'))
    roots.push(outside)
    const update = getRegisteredHandler('settings:update')
    const res = await update(makeEvent(), { modelsFolder: outside })
    expect(res.error).toContain('不在模型库列表')
    const settings = await loadSettings()
    expect(settings.modelsFolder).toBe('')
    expect(settings.modelsFolders).toEqual([])
  })

  it('modelsFolders 新增未登记目录时拒绝，移除现有库仍允许', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-scan-outside-'))
    roots.push(outside)
    const update = getRegisteredHandler('settings:update')
    const rejected = await update(makeEvent(), { modelsFolders: [root, outside] })
    expect(rejected.error).toContain('不在模型库列表')

    await updateSettings({ modelsFolder: root, modelsFolders: [root] })
    const removed = await update(makeEvent(), { modelsFolders: [] })
    expect(removed.error).toBeUndefined()
    const settings = await loadSettings()
    // 激活库恒保留在列表中，移除仅作用于其余条目
    expect(settings.modelsFolders).toEqual([root])
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
