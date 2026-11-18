import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * 导入挂起窗口内新旧任务的 finally 竞态（#60）回归测试：
 * 正常/取消路径先释放 importing，再经动态 import('./partial-scan') 挂起；
 * 若新导入恰在该窗口启动，旧任务 finally 不得清掉新任务的 importing/
 * importProgress/activeImportOpId（否则新导入失去取消能力与进度显示）。
 */
vi.mock('../src/renderer/src/store/toast.js', async (importOriginal) => ({
  ...(await importOriginal()),
  toast: vi.fn(),
}))

vi.mock(
  '../src/renderer/src/store/partial-scan.js',
  async (importOriginal) => ({
    ...(await importOriginal()),
    partialScanModels: vi.fn(async () => {}),
  }),
)

import { makeApiMock, resetStoreTestState } from './helpers/storeTest'
import { state } from '../src/renderer/src/store/state'
import { partialScanModels } from '../src/renderer/src/store/partial-scan'
import {
  cancelImport,
  importModels,
} from '../src/renderer/src/store/model-actions'

let api

beforeEach(() => {
  api = makeApiMock()
  resetStoreTestState(api)
})

describe('导入挂起窗口内新旧任务的 finally 竞态（#60）', () => {
  it('旧任务 finally 不清掉挂起窗口内启动的新导入状态与取消令牌', async () => {
    state.folder = 'D:\\models'
    let resolveNested
    const nestedPending = new Promise((resolve) => {
      resolveNested = resolve
    })
    // 第一次 IPC（旧任务）立即成功返回；新导入（窗口内启动）挂起在途
    api.models.importModels
      .mockResolvedValueOnce({
        imported: 1,
        renamed: 0,
        failed: [],
        warnings: [],
        targetRelDir: 'dst',
      })
      .mockImplementation(() => nestedPending)
    let nested
    // 旧任务的局部扫描挂起点内启动新导入（复现动态 chunk 加载窗口）
    vi.mocked(partialScanModels).mockImplementationOnce(async () => {
      nested = importModels('copy') // 不 await：让新导入走到 IPC 挂起
      await Promise.resolve()
    })

    expect(await importModels('copy')).toBe(true)

    // 旧任务已收尾而新导入仍在途：其导入标志、进度与取消令牌必须完整保留
    expect(state.importing).toBe(true)
    expect(state.importProgress).not.toBeNull()
    cancelImport()
    expect(api.models.cancelOp).toHaveBeenCalledTimes(1)

    // 新导入完成后自行收尾：状态正常清理
    resolveNested({
      imported: 1,
      renamed: 0,
      failed: [],
      warnings: [],
      targetRelDir: 'dst',
    })
    expect(await nested).toBe(true)
    expect(state.importing).toBe(false)
    expect(state.importProgress).toBeNull()
  })
})
