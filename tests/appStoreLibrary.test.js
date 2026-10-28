import { describe, it, expect, beforeEach } from 'vitest'
import {
  makeApiMock,
  resetStoreTestState,
  makeModel,
} from './helpers/storeTest'
import {
  initApp,
  partialScanModels,
  relocateFolder,
  replaceModels,
  scanModels,
  state,
  switchRoot,
} from '../src/renderer/src/store/appStore'

/**
 * appStoreLibrary.test.js（ENG-1 自 appStore.test.js 按域拆分，用例内容保持原样）
 */

let api

beforeEach(() => {
  api = makeApiMock()
  resetStoreTestState(api)
})

describe('切库状态机（V-02）', () => {
  it('目标库扫描成功后提交 state.folder 并替换列表', async () => {
    state.folder = 'D:\\models'
    replaceModels([makeModel('D:\\models\\old.safetensors')])
    api.models.scan.mockResolvedValue({
      root: 'D:\\other',
      models: [makeModel('D:\\other\\new.safetensors')],
      errors: [],
    })

    await switchRoot('D:\\other')

    expect(state.folder).toBe('D:\\other')
    expect(state.models.map((m) => m.id)).toEqual([
      'D:\\other\\new.safetensors',
    ])
  })

  it('目标库扫描失败时保持原库与旧列表', async () => {
    state.folder = 'D:\\models'
    replaceModels([makeModel('D:\\models\\old.safetensors')])
    api.models.scan.mockResolvedValue({ error: '模型文件夹不存在或不是目录' })

    await switchRoot('D:\\other')

    expect(state.folder).toBe('D:\\models')
    expect(state.models.map((m) => m.id)).toEqual([
      'D:\\models\\old.safetensors',
    ])
    expect(state.toasts.some((t) => t.type === 'error')).toBe(true)
  })

  it('扫描被取消时保持原库与旧列表', async () => {
    state.folder = 'D:\\models'
    replaceModels([makeModel('D:\\models\\old.safetensors')])
    api.models.scan.mockResolvedValue({ canceled: true })

    await switchRoot('D:\\other')

    expect(state.folder).toBe('D:\\models')
    expect(state.models.map((m) => m.id)).toEqual([
      'D:\\models\\old.safetensors',
    ])
  })
})

describe('F1 本地索引：秒切库与后台校验', () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve))

  it('switchRoot 有索引时立即展示缓存，再后台校验并替换为磁盘结果', async () => {
    state.folder = 'D:\\models'
    state.settings.autoScan = true
    replaceModels([makeModel('D:\\models\\old.safetensors')])
    api.models.openLibrary.mockResolvedValue({
      root: 'D:\\other',
      cached: true,
      durationMs: 5,
      models: [makeModel('D:\\other\\cached.safetensors')],
      settings: { modelsFolder: 'D:\\other', autoScan: true },
    })
    let releaseScan
    api.models.scan.mockReturnValue(
      new Promise((resolve) => {
        releaseScan = resolve
      }),
    )

    await switchRoot('D:\\other')

    expect(state.folder).toBe('D:\\other')
    expect(state.models.map((m) => m.id)).toEqual([
      'D:\\other\\cached.safetensors',
    ])
    expect(state.backgroundScanning).toBe(true)
    expect(
      state.toasts.some(
        (t) => t.type === 'success' && t.text.includes('秒开本地索引'),
      ),
    ).toBe(true)
    expect(api.models.scan).toHaveBeenCalledWith('D:\\other')

    releaseScan({
      root: 'D:\\other',
      models: [makeModel('D:\\other\\fresh.safetensors')],
      errors: [],
      durationMs: 10,
    })
    await tick()
    expect(state.backgroundScanning).toBe(false)
    expect(state.models.map((m) => m.id)).toEqual([
      'D:\\other\\fresh.safetensors',
    ])
  })

  it('后台校验失败时保留缓存列表且不进入全屏错误态', async () => {
    state.folder = 'D:\\models'
    state.settings.autoScan = true
    api.models.openLibrary.mockResolvedValue({
      root: 'D:\\other',
      cached: true,
      models: [makeModel('D:\\other\\cached.safetensors')],
      settings: { modelsFolder: 'D:\\other', autoScan: true },
    })
    api.models.scan.mockResolvedValue({ error: '磁盘读取失败' })

    await switchRoot('D:\\other')
    await tick()

    expect(state.models.map((m) => m.id)).toEqual([
      'D:\\other\\cached.safetensors',
    ])
    expect(state.scanError).toBe('')
    expect(state.backgroundScanning).toBe(false)
    expect(
      state.toasts.some(
        (t) => t.type === 'warn' && t.text.includes('后台校验失败'),
      ),
    ).toBe(true)
  })

  it('initApp 有缓存时先展示并后台校验；autoScan=false 时只展示', async () => {
    state.booting = true
    api.models.loadStore.mockResolvedValue({
      settings: { modelsFolder: 'D:\\lib', autoScan: true },
      models: {},
      cachedIndex: {
        models: [makeModel('D:\\lib\\cached.safetensors')],
        durationMs: 3,
      },
    })
    let releaseScan
    api.models.scan.mockReturnValue(
      new Promise((resolve) => {
        releaseScan = resolve
      }),
    )

    await initApp()

    expect(state.booting).toBe(false)
    expect(state.folder).toBe('D:\\lib')
    expect(state.models.map((m) => m.id)).toEqual([
      'D:\\lib\\cached.safetensors',
    ])
    expect(state.backgroundScanning).toBe(true)

    releaseScan({
      root: 'D:\\lib',
      models: [makeModel('D:\\lib\\fresh.safetensors')],
      errors: [],
    })
    await tick()
    expect(state.backgroundScanning).toBe(false)
    expect(state.models.map((m) => m.id)).toEqual([
      'D:\\lib\\fresh.safetensors',
    ])
  })

  it('initApp autoScan=false 且有缓存：展示缓存但不触发扫描', async () => {
    state.booting = true
    api.models.loadStore.mockResolvedValue({
      settings: { modelsFolder: 'D:\\lib', autoScan: false },
      models: {},
      cachedIndex: {
        models: [makeModel('D:\\lib\\cached.safetensors')],
        durationMs: 3,
      },
    })

    await initApp()

    expect(state.booting).toBe(false)
    expect(state.models.map((m) => m.id)).toEqual([
      'D:\\lib\\cached.safetensors',
    ])
    expect(state.backgroundScanning).toBe(false)
    expect(api.models.scan).not.toHaveBeenCalled()
  })
})

describe('库路径失效闭环（F1-offline）', () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve))

  it('initApp：folderMissing 响应置位离线态、回填失效清单并跳过注定失败的自动扫描', async () => {
    state.booting = true
    api.models.loadStore.mockResolvedValue({
      settings: { modelsFolder: 'D:\\gone', autoScan: true },
      folderMissing: true,
      rootStatuses: [
        { folder: 'D:\\gone', exists: false },
        { folder: 'E:\\fine', exists: true },
      ],
    })

    await initApp()

    expect(state.folderMissing).toBe(true)
    // 小写化回填（侧栏按小写比较），仅收录失效条目
    expect(state.missingRoots).toEqual(['d:\\gone'])
    // 不触发自动扫描、不弹错误 toast（离线页承担提示）
    expect(api.models.scan).not.toHaveBeenCalled()
    expect(state.toasts.some((t) => t.type === 'error')).toBe(false)
    expect(state.booting).toBe(false)
  })

  it('initApp：无 folderMissing 字段（旧响应形态）时保持原有自动扫描流程', async () => {
    state.booting = true
    api.models.loadStore.mockResolvedValue({
      settings: { modelsFolder: 'D:\\lib', autoScan: true },
    })
    api.models.scan.mockResolvedValue({
      root: 'D:\\lib',
      models: [],
      errors: [],
      durationMs: 1,
    })

    await initApp()

    expect(state.folderMissing).toBe(false)
    expect(state.missingRoots).toEqual([])
    expect(api.models.scan).toHaveBeenCalled()
  })

  it('scanModels：folderMissing 响应置位离线态，不弹错误 toast 也不置 scanError', async () => {
    state.folder = 'D:\\gone'
    api.models.scan.mockResolvedValue({
      error: '模型文件夹不存在或不是目录',
      folderMissing: true,
    })

    const ok = await scanModels()

    expect(ok).toBe(false)
    expect(state.folderMissing).toBe(true)
    expect(state.scanError).toBe('')
    expect(state.toasts.some((t) => t.type === 'error')).toBe(false)
    expect(state.scanning).toBe(false)
  })

  it('scanModels：扫描成功清除离线态并把该库移出失效清单', async () => {
    state.folder = 'D:\\back'
    state.folderMissing = true
    state.missingRoots = ['d:\\back', 'e:\\other']
    api.models.scan.mockResolvedValue({
      root: 'D:\\back',
      models: [makeModel('D:\\back\\a.safetensors')],
      errors: [],
      durationMs: 1,
    })

    const ok = await scanModels()

    expect(ok).toBe(true)
    expect(state.folderMissing).toBe(false)
    expect(state.missingRoots).toEqual(['e:\\other'])
  })

  it('scanModels：普通错误清除残留离线态并照常提示（存在性校验已通过，语义非离线）', async () => {
    state.folder = 'D:\\lib'
    state.folderMissing = true
    api.models.scan.mockResolvedValue({ error: '磁盘读取失败' })

    const ok = await scanModels()

    expect(ok).toBe(false)
    expect(state.folderMissing).toBe(false)
    expect(state.scanError).toBe('磁盘读取失败')
    expect(state.toasts.some((t) => t.type === 'error')).toBe(true)
  })

  it('partialScanModels：folderMissing 置位离线态，不降级全量扫描也不提示降级', async () => {
    state.folder = 'D:\\gone'
    replaceModels([makeModel('D:\\gone\\a.safetensors')])
    api.models.partialScan.mockResolvedValue({
      error: '模型文件夹不存在或不是目录',
      folderMissing: true,
    })

    await partialScanModels(['lora'])

    expect(state.folderMissing).toBe(true)
    expect(api.models.scan).not.toHaveBeenCalled()
    expect(state.toasts.some((t) => t.text.includes('增量刷新失败'))).toBe(
      false,
    )
    expect(state.partialScanning).toBe(false)
  })

  it('switchRoot：目标库失效时提交目标身份进入离线态（空库全屏形态），并登记失效清单', async () => {
    state.folder = 'D:\\libA'
    replaceModels([makeModel('D:\\libA\\a.safetensors')])
    api.models.openLibrary.mockResolvedValue({
      error: '模型文件夹不存在或不是目录',
      folderMissing: true,
    })

    await switchRoot('D:\\goneB')

    expect(state.folder).toBe('D:\\goneB')
    expect(state.folderMissing).toBe(true)
    expect(state.models).toEqual([])
    expect(state.missingRoots).toContain('d:\\goneb')
    // 不走笼统错误 toast
    expect(state.toasts.some((t) => t.type === 'error')).toBe(false)
  })

  it('switchRoot：秒开可用库时清除离线残留（folderMissing 恒描述当前库）', async () => {
    state.folder = 'D:\\gone'
    state.folderMissing = true
    state.missingRoots = ['d:\\gone', 'd:\\fine']
    api.models.openLibrary.mockResolvedValue({
      root: 'D:\\fine',
      cached: true,
      models: [makeModel('D:\\fine\\cached.safetensors')],
      settings: { modelsFolder: 'D:\\fine', autoScan: false },
      durationMs: 3,
    })
    api.models.scan.mockResolvedValue({
      root: 'D:\\fine',
      models: [],
      errors: [],
      durationMs: 1,
    })

    await switchRoot('D:\\fine')
    await tick()

    expect(state.folderMissing).toBe(false)
    expect(state.missingRoots).toEqual(['d:\\gone'])
  })

  it('relocateFolder：取消选择保持离线态不变', async () => {
    state.folder = 'D:\\gone'
    state.folderMissing = true
    api.models.chooseFolder.mockResolvedValue(null)

    await relocateFolder()

    expect(state.folder).toBe('D:\\gone')
    expect(state.folderMissing).toBe(true)
    expect(api.settings.update).not.toHaveBeenCalled()
    expect(api.models.scan).not.toHaveBeenCalled()
  })

  it('relocateFolder：选择新路径后立即把旧失效路径移出库列表并扫描', async () => {
    state.folder = 'D:\\gone'
    state.folderMissing = true
    state.missingRoots = ['d:\\gone']
    state.settings.modelsFolders = ['D:\\gone', 'E:\\other']
    api.models.chooseFolder.mockResolvedValue('F:\\new-home')
    api.settings.update.mockImplementation((patch) =>
      Promise.resolve({ settings: { ...state.settings, ...patch } }),
    )
    api.models.scan.mockResolvedValue({
      root: 'F:\\new-home',
      models: [makeModel('F:\\new-home\\a.safetensors')],
      errors: [],
      durationMs: 1,
    })

    await relocateFolder()

    // 立即清理死条目（不等扫描结果）
    expect(api.settings.update).toHaveBeenCalledWith({
      modelsFolders: ['E:\\other'],
    })
    expect(api.models.scan).toHaveBeenCalledWith('F:\\new-home')
    // 扫描成功：离线态清除，新路径成为激活库
    expect(state.folder).toBe('F:\\new-home')
    expect(state.folderMissing).toBe(false)
    expect(state.missingRoots).toEqual([])
  })

  it('relocateFolder：清理死条目失败仅 toast，不阻断扫描恢复', async () => {
    state.folder = 'D:\\gone'
    state.folderMissing = true
    state.settings.modelsFolders = ['D:\\gone']
    api.models.chooseFolder.mockResolvedValue('F:\\new-home')
    api.settings.update.mockResolvedValue({ error: '设置保存失败' })
    api.models.scan.mockResolvedValue({
      root: 'F:\\new-home',
      models: [],
      errors: [],
      durationMs: 1,
    })

    await relocateFolder()

    expect(state.toasts.some((t) => t.type === 'error')).toBe(true)
    // 清理失败不阻断：扫描仍发起并完成恢复
    expect(api.models.scan).toHaveBeenCalledWith('F:\\new-home')
    expect(state.folderMissing).toBe(false)
  })
})

/** 生成测试模型对象 */
