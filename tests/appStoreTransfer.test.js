import { describe, it, expect, beforeEach } from 'vitest'
import { makeApiMock, resetStoreTestState } from './helpers/storeTest'
import {
  closeTransfer,
  confirmTransfer,
  openTransferToLibrary,
  state,
  targetDisplayName,
  transferState,
  transferTargets,
} from '../src/renderer/src/store/appStore'

/**
 * appStoreTransfer.test.js（ENG-1 自 appStore.test.js 按域拆分，用例内容保持原样）
 */

let api

beforeEach(() => {
  api = makeApiMock()
  resetStoreTestState(api)
})

describe('跨库传输编排（F-3）', () => {
  beforeEach(() => {
    state.folder = 'D:\\models\\A'
    state.settings.modelsFolders = ['D:\\models\\A', 'D:\\models\\B']
    api.models.scan.mockResolvedValue({
      models: [],
      errors: [],
      byType: {},
      durationMs: 1,
    })
  })

  it('可选目标库排除当前库；无其他库时不打开浮层并提示', () => {
    expect(transferTargets.value).toEqual(['D:\\models\\B'])

    state.settings.modelsFolders = ['D:\\models\\A']
    expect(transferTargets.value).toEqual([])
    openTransferToLibrary('D:\\models\\A\\x.safetensors')

    expect(transferState.visible).toBe(false)
    expect(
      state.toasts.some((t) => t.text.includes('当前只有这一个模型库')),
    ).toBe(true)
  })

  it('单模型默认移动、多模型默认复制；空输入不改变浮层', () => {
    openTransferToLibrary('D:\\models\\A\\x.safetensors')
    expect(transferState).toMatchObject({
      visible: true,
      mode: 'move',
      ids: ['D:\\models\\A\\x.safetensors'],
    })

    closeTransfer()
    openTransferToLibrary(['a', 'b'])
    expect(transferState).toMatchObject({
      visible: true,
      mode: 'copy',
      ids: ['a', 'b'],
    })

    closeTransfer()
    openTransferToLibrary([])
    expect(transferState.visible).toBe(false)
  })

  it('目标库显示名取目录名，盘符根回退规范化路径', () => {
    expect(targetDisplayName('D:\\libs\\B\\')).toBe('B')
    expect(targetDisplayName('D:\\')).toBe('D:')
  })

  it('传输进行中不可关闭；空闲关闭清空待传输 id', () => {
    openTransferToLibrary('a')
    transferState.busy = true
    closeTransfer()
    expect(transferState.visible).toBe(true)
    expect(transferState.ids).toEqual(['a'])

    transferState.busy = false
    closeTransfer()
    expect(transferState.visible).toBe(false)
    expect(transferState.ids).toEqual([])
  })

  it('复制成功：payload 正确、汇总提示、关闭浮层并重扫', async () => {
    openTransferToLibrary(['a', 'b'])
    api.models.transferToLibrary.mockResolvedValue({
      transferred: 2,
      mode: 'copy',
      skipped: [],
      failed: [],
    })

    await confirmTransfer('D:\\models\\B')

    expect(api.models.transferToLibrary).toHaveBeenCalledWith({
      ids: ['a', 'b'],
      targetRoot: 'D:\\models\\B',
      mode: 'copy',
    })
    expect(transferState.visible).toBe(false)
    expect(transferState.ids).toEqual([])
    expect(
      state.toasts.some(
        (t) =>
          t.type === 'success' && t.text.includes('跨库传输完成：复制 2 个'),
      ),
    ).toBe(true)
    expect(api.models.scan).toHaveBeenCalledTimes(1)
  })

  it('部分跳过/失败以 warn 汇总；零传输以 info 提示并关闭浮层', async () => {
    openTransferToLibrary(['a', 'b', 'c'])
    api.models.transferToLibrary.mockResolvedValue({
      transferred: 1,
      mode: 'copy',
      skipped: [{ id: 'b', reason: 'exists' }],
      failed: [{ id: 'c', error: '磁盘错误' }],
    })

    await confirmTransfer('D:\\models\\B')

    const warn = state.toasts.find(
      (t) => t.type === 'warn' && t.text.includes('跨库传输完成'),
    )
    expect(warn.text).toContain('跳过 1 个')
    expect(warn.text).toContain('失败 1 个')

    state.toasts.splice(0, state.toasts.length)
    openTransferToLibrary('a')
    api.models.transferToLibrary.mockResolvedValue({
      transferred: 0,
      mode: 'move',
      skipped: [{ id: 'a', reason: 'exists' }],
      failed: [],
    })
    await confirmTransfer('D:\\models\\B')

    expect(
      state.toasts.some(
        (t) => t.type === 'info' && t.text.includes('未传输任何模型'),
      ),
    ).toBe(true)
    expect(transferState.visible).toBe(false)
  })

  it('主进程返回 error：提示并保留浮层便于重试，不触发重扫', async () => {
    openTransferToLibrary('a')
    api.models.transferToLibrary.mockResolvedValue({ error: '目标库不可用' })

    await confirmTransfer('D:\\models\\B')

    expect(transferState.visible).toBe(true)
    expect(transferState.busy).toBe(false)
    expect(
      state.toasts.some(
        (t) => t.type === 'error' && t.text.includes('目标库不可用'),
      ),
    ).toBe(true)
    expect(api.models.scan).not.toHaveBeenCalled()
  })

  it('IPC reject：错误提示并复位 busy', async () => {
    openTransferToLibrary('a')
    api.models.transferToLibrary.mockRejectedValue(new Error('通道断开'))

    await confirmTransfer('D:\\models\\B')

    expect(transferState.busy).toBe(false)
    expect(
      state.toasts.some(
        (t) => t.type === 'error' && t.text.includes('跨库传输失败'),
      ),
    ).toBe(true)
  })

  it('缺少目标库 / 无待传输项 / busy 时不发 IPC', async () => {
    await confirmTransfer('')
    expect(api.models.transferToLibrary).not.toHaveBeenCalled()

    await confirmTransfer('D:\\models\\B')
    expect(api.models.transferToLibrary).not.toHaveBeenCalled()

    openTransferToLibrary('a')
    transferState.busy = true
    await confirmTransfer('D:\\models\\B')
    expect(api.models.transferToLibrary).not.toHaveBeenCalled()
  })
})
