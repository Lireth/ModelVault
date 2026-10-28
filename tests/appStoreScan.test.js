import { describe, it, expect, beforeEach } from 'vitest'
import {
  makeApiMock,
  resetStoreTestState,
  makeModel,
} from './helpers/storeTest'
import {
  partialScanModels,
  replaceModels,
  scanModels,
  state,
} from '../src/renderer/src/store/appStore'

/**
 * appStoreScan.test.js（ENG-1 自 appStore.test.js 按域拆分，用例内容保持原样）
 */

let api

beforeEach(() => {
  api = makeApiMock()
  resetStoreTestState(api)
})

describe('partialScanModels 增量合并（A-03）', () => {
  function setGrid(models) {
    state.folder = 'D:\\models'
    state.models = models
  }

  it('新模型并入列表，子树外模型保持不动', async () => {
    setGrid([
      makeModel('D:\\models\\keep.safetensors', { name: 'keep', relDir: '' }),
      makeModel('D:\\models\\lora\\a.safetensors', {
        name: 'a',
        relDir: 'lora',
      }),
    ])
    api.models.partialScan.mockResolvedValue({
      models: [
        makeModel('D:\\models\\lora\\a.safetensors', {
          name: 'a',
          relDir: 'lora',
        }),
        makeModel('D:\\models\\lora\\b.safetensors', {
          name: 'b',
          relDir: 'lora',
        }),
      ],
      dirs: ['lora'],
      relinked: 0,
    })

    await partialScanModels(['lora'])

    const ids = state.models.map((m) => m.id)
    expect(ids).toContain('D:\\models\\keep.safetensors') // 子树外不动
    expect(ids).toContain('D:\\models\\lora\\a.safetensors') // 子树内存量被新结果替换
    expect(ids).toContain('D:\\models\\lora\\b.safetensors') // 新增
    expect(state.models).toHaveLength(3)
    // IPC 入参透传子树
    expect(api.models.partialScan).toHaveBeenCalledWith({
      folder: 'D:\\models',
      dirs: ['lora'],
    })
  })

  it('子树内消失的模型从列表移除，子树外模型保留', async () => {
    setGrid([
      makeModel('D:\\models\\lora\\gone.safetensors', {
        name: 'gone',
        relDir: 'lora',
      }),
      makeModel('D:\\models\\keep.safetensors', { name: 'keep', relDir: '' }),
    ])
    api.models.partialScan.mockResolvedValue({
      models: [],
      dirs: ['lora'],
      relinked: 0,
    })

    await partialScanModels(['lora'])

    const ids = state.models.map((m) => m.id)
    expect(ids).not.toContain('D:\\models\\lora\\gone.safetensors')
    expect(ids).toContain('D:\\models\\keep.safetensors')
  })

  it('dirs 含根目录空串时影响根直属模型，但不影响子目录模型', async () => {
    setGrid([
      makeModel('D:\\models\\root-file.safetensors', {
        name: 'root-file',
        relDir: '',
      }),
      makeModel('D:\\models\\lora\\deep.safetensors', {
        name: 'deep',
        relDir: 'lora',
      }),
    ])
    api.models.partialScan.mockResolvedValue({
      models: [],
      dirs: [''],
      relinked: 0,
    })

    await partialScanModels([''])

    const ids = state.models.map((m) => m.id)
    expect(ids).not.toContain('D:\\models\\root-file.safetensors')
    expect(ids).toContain('D:\\models\\lora\\deep.safetensors')
  })

  it('合并后同步清理多选选区中已消失的 id', async () => {
    setGrid([
      makeModel('D:\\models\\lora\\gone.safetensors', {
        name: 'gone',
        relDir: 'lora',
      }),
      makeModel('D:\\models\\keep.safetensors', { name: 'keep', relDir: '' }),
    ])
    state.multiSelect.active = true
    state.multiSelect.ids = [
      'D:\\models\\lora\\gone.safetensors',
      'D:\\models\\keep.safetensors',
    ]
    api.models.partialScan.mockResolvedValue({
      models: [],
      dirs: ['lora'],
      relinked: 0,
    })

    await partialScanModels(['lora'])

    expect(state.multiSelect.ids).toEqual(['D:\\models\\keep.safetensors'])
  })

  it('子树内当前打开详情的模型消失时关闭详情', async () => {
    setGrid([
      makeModel('D:\\models\\lora\\gone.safetensors', {
        name: 'gone',
        relDir: 'lora',
      }),
    ])
    state.selectedId = 'D:\\models\\lora\\gone.safetensors'
    api.models.partialScan.mockResolvedValue({
      models: [],
      dirs: ['lora'],
      relinked: 0,
    })

    await partialScanModels(['lora'])

    expect(state.selectedId).toBeNull()
  })

  it('dirs 为空/缺省时回退全量扫描（防御 watcher 载荷异常）', async () => {
    setGrid([])
    api.models.scan.mockResolvedValue({ models: [makeModel('m1')], errors: [] })
    api.models.partialScan.mockResolvedValue({
      models: [makeModel('m2')],
      dirs: [],
    })

    await partialScanModels([])

    expect(api.models.scan).toHaveBeenCalled()
    expect(api.models.partialScan).not.toHaveBeenCalled()
  })

  it('IPC 返回错误时 toast 提示且不改动列表', async () => {
    setGrid([makeModel('keep-id')])
    api.models.partialScan.mockRejectedValue(new Error('局部扫描失败'))

    await partialScanModels(['lora'])

    expect(state.models.map((m) => m.id)).toEqual(['keep-id'])
    expect(state.toasts.some((t) => t.type === 'error')).toBe(true)
  })

  it('O3：子树超过上限时收敛为一级目录后发送，不静默截断', async () => {
    setGrid([])
    api.models.partialScan.mockResolvedValue({
      models: [],
      dirs: ['bulk'],
      relinked: 0,
    })
    const dirs = Array.from({ length: 205 }, (_, i) => `bulk/item-${i}`)

    await partialScanModels(dirs)

    expect(api.models.partialScan).toHaveBeenCalledWith({
      folder: 'D:\\models',
      dirs: ['bulk'],
    })
  })

  it('O3：一级目录仍超过上限时降级全量扫描', async () => {
    setGrid([makeModel('keep-id')])
    api.models.scan.mockResolvedValue({
      models: [makeModel('keep-id')],
      errors: [],
    })
    const dirs = Array.from({ length: 205 }, (_, i) => `top${i}`)

    await partialScanModels(dirs)

    expect(api.models.partialScan).not.toHaveBeenCalled()
    expect(api.models.scan).toHaveBeenCalled()
    expect(
      state.toasts.some(
        (t) => t.type === 'warn' && t.text.includes('变更目录过多'),
      ),
    ).toBe(true)
  })

  it('O3：主进程返回 fullScanRequired 时降级全量扫描', async () => {
    setGrid([makeModel('keep-id')])
    api.models.partialScan.mockResolvedValue({ fullScanRequired: true })
    api.models.scan.mockResolvedValue({
      models: [makeModel('keep-id')],
      errors: [],
    })

    await partialScanModels(['lora'])
    // fallback 全量扫描在 finalize 中异步发起
    await new Promise((resolve) => setImmediate(resolve))

    expect(api.models.scan).toHaveBeenCalled()
    expect(
      state.toasts.some(
        (t) => t.type === 'warn' && t.text.includes('变更目录过多'),
      ),
    ).toBe(true)
  })

  it('请求发出后切库：旧根响应丢弃，不覆盖新库列表（B-01）', async () => {
    setGrid([
      makeModel('D:\\models\\lora\\a.safetensors', {
        name: 'a',
        relDir: 'lora',
      }),
    ])
    let resolveRequest
    api.models.partialScan.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve
      }),
    )

    const pending = partialScanModels(['lora'])
    // 模拟切库：根与列表已换成新库
    state.folder = 'D:\\other'
    replaceModels([
      makeModel('D:\\other\\new.safetensors', { name: 'new', relDir: '' }),
    ])
    resolveRequest({
      models: [
        makeModel('D:\\models\\lora\\b.safetensors', {
          name: 'b',
          relDir: 'lora',
        }),
      ],
      dirs: ['lora'],
      relinked: 0,
    })
    await pending

    expect(state.models.map((m) => m.id)).toEqual([
      'D:\\other\\new.safetensors',
    ])
    expect(state.partialScanning).toBe(false)
  })

  it('并发局部扫描串行化：在途变更合并后补扫一次（B-01）', async () => {
    setGrid([
      makeModel('D:\\models\\keep.safetensors', { name: 'keep', relDir: '' }),
    ])
    let resolveFirst
    api.models.partialScan.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve
      }),
    )

    const first = partialScanModels(['lora'])
    api.models.partialScan.mockResolvedValue({
      models: [],
      dirs: ['vae'],
      relinked: 0,
    })
    // 在途期间的新变更不并发发起，合并入队
    await partialScanModels(['vae'])
    expect(api.models.partialScan).toHaveBeenCalledTimes(1)

    resolveFirst({ models: [], dirs: ['lora'], relinked: 0 })
    await first
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(api.models.partialScan).toHaveBeenCalledTimes(2)
    expect(api.models.partialScan.mock.calls[1][0]).toEqual({
      folder: 'D:\\models',
      dirs: ['vae'],
    })
    expect(state.partialScanning).toBe(false)
  })

  it('局部扫描失败降级全量扫描时，不会因锁标志被自身拦截（B-01）', async () => {
    setGrid([])
    api.models.partialScan.mockResolvedValue({
      error: '该目录不在模型库列表中',
    })
    api.models.scan.mockResolvedValue({ models: [makeModel('m1')], errors: [] })

    await partialScanModels(['lora'])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(api.models.scan).toHaveBeenCalledTimes(1)
    expect(state.partialScanning).toBe(false)
  })
})

describe('scanModels 重关联提示（A-02）', () => {
  beforeEach(() => {
    state.folder = 'D:\\models'
  })

  it('扫描响应含 relinked>0 时成功提示追加「自动重新关联 N 个」', async () => {
    api.models.scan.mockResolvedValue({
      models: [makeModel('m1')],
      errors: [],
      relinked: 2,
    })
    await scanModels()
    const notice = state.toasts.find((t) => t.type === 'success')
    expect(notice.text).toContain('发现 1 个模型')
    expect(notice.text).toContain('自动重新关联 2 个')
  })

  it('relinked 缺省或为 0 时维持原提示文案', async () => {
    api.models.scan.mockResolvedValue({ models: [makeModel('m1')], errors: [] })
    await scanModels()
    const notice = state.toasts.find((t) => t.type === 'success')
    expect(notice.text).toBe('扫描完成：发现 1 个模型')
  })

  it('存在读取错误时重关联计数仍在警告提示中展示', async () => {
    api.models.scan.mockResolvedValue({
      models: [makeModel('m1')],
      errors: [{ dir: 'x', message: 'denied' }],
      relinked: 1,
    })
    await scanModels()
    const notice = state.toasts.find((t) => t.type === 'warn')
    expect(notice.text).toContain('1 个目录无法读取')
    expect(notice.text).toContain('自动重新关联 1 个')
  })
})
