import { describe, it, expect, beforeEach } from 'vitest'
import { makeApiMock, resetStoreTestState } from './helpers/storeTest'
import { importModels, state } from '../src/renderer/src/store/appStore'

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
    expect(api.models.importModels).toHaveBeenCalledWith('copy')
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
