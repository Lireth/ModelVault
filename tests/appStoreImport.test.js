import { describe, it, expect, beforeEach } from 'vitest'
import { makeApiMock, resetStoreTestState } from './helpers/storeTest'
import {
  cancelImport,
  importModels,
  state,
} from '../src/renderer/src/store/appStore'

/**
 * appStoreImport.test.js（ENG-1 自 appStore.test.js 按域拆分，用例内容保持原样）
 */

let api

beforeEach(() => {
  api = makeApiMock()
  resetStoreTestState(api)
})

describe('F2 模型导入', () => {
  it('导入成功后提示并对目标子树执行局部扫描', async () => {
    state.folder = 'D:\\models'
    api.models.importModels.mockResolvedValue({
      imported: 2,
      renamed: 1,
      failed: [],
      warnings: [],
      targetRelDir: 'lora',
    })
    api.models.partialScan.mockResolvedValue({
      models: [],
      dirs: ['lora'],
      relinked: 0,
    })

    const ok = await importModels('copy')

    expect(ok).toBe(true)
    expect(api.models.importModels).toHaveBeenCalledWith(
      'copy',
      expect.any(String),
    )
    expect(api.models.partialScan).toHaveBeenCalledWith({
      folder: 'D:\\models',
      dirs: ['lora'],
    })
    expect(
      state.toasts.some(
        (t) => t.type === 'success' && t.text.includes('2 个模型'),
      ),
    ).toBe(true)
    expect(state.importing).toBe(false)
  })

  it('取消在途导入：发出 cancelOp，已完成条目保留并局部扫描（OPT-02）', async () => {
    state.folder = 'D:\\models'
    let resolveImport
    api.models.importModels.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveImport = resolve
        }),
    )
    api.models.partialScan.mockResolvedValue({
      models: [],
      dirs: ['lora'],
      relinked: 0,
    })

    const pending = importModels('copy')
    // 等 importModels 完成前置检查并真正发出 IPC（拿到 opId）
    await Promise.resolve()
    const opId = api.models.importModels.mock.calls[0][1]
    expect(typeof opId).toBe('string')
    cancelImport()
    expect(api.models.cancelOp).toHaveBeenCalledWith(opId)
    expect(state.importProgress.canceling).toBe(true)

    resolveImport({
      canceled: true,
      imported: 1,
      renamed: 0,
      failed: [],
      warnings: [],
      targetRelDir: 'lora',
    })
    expect(await pending).toBe(true)
    expect(api.models.partialScan).toHaveBeenCalledWith({
      folder: 'D:\\models',
      dirs: ['lora'],
    })
    expect(state.importing).toBe(false)
    expect(state.importProgress).toBeNull()
    expect(
      state.toasts.some(
        (t) => t.type === 'warn' && t.text.includes('导入已取消'),
      ),
    ).toBe(true)
  })

  it('F-4 拖拽导入：来源路径透传给主进程（跳过来源选择框）', async () => {
    state.folder = 'D:\\models'
    api.models.importModels.mockResolvedValue({
      imported: 1,
      renamed: 0,
      failed: [],
      warnings: [],
      targetRelDir: 'lora',
    })
    api.models.partialScan.mockResolvedValue({
      models: [],
      dirs: ['lora'],
      relinked: 0,
    })

    const ok = await importModels('move', ['D:\\src\\drag.safetensors'])

    expect(ok).toBe(true)
    expect(api.models.importModels).toHaveBeenCalledWith(
      'move',
      expect.any(String),
      ['D:\\src\\drag.safetensors'],
    )
    expect(api.models.partialScan).toHaveBeenCalledWith({
      folder: 'D:\\models',
      dirs: ['lora'],
    })
  })

  it('全部失败时不触发局部扫描；扫描中拒绝导入', async () => {
    state.folder = 'D:\\models'
    api.models.importModels.mockResolvedValue({
      imported: 0,
      renamed: 0,
      failed: [{ source: 'x', error: '不支持' }],
      warnings: [],
      targetRelDir: '',
    })
    expect(await importModels('copy')).toBe(false)
    expect(api.models.partialScan).not.toHaveBeenCalled()
    expect(
      state.toasts.some(
        (t) => t.type === 'warn' && t.text.includes('导入失败'),
      ),
    ).toBe(true)

    state.scanning = true
    expect(await importModels('copy')).toBe(false)
    expect(api.models.importModels).toHaveBeenCalledTimes(1)
  })
})
