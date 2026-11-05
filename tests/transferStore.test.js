import { describe, it, expect, beforeEach } from 'vitest'
import { makeApiMock, resetStoreTestState } from './helpers/storeTest'
import {
  cancelTransfer,
  closeTransfer,
  confirmTransfer,
  openTransferToLibrary,
  targetDisplayName,
  transferState,
  transferTargets,
} from '../src/renderer/src/store/transfer'
import { defaultSettings, state } from '../src/renderer/src/store/appStore'

/**
 * 跨库移动/复制渲染层编排测试（F-3，O-1 覆盖盲区回补）：
 * transfer.js 此前仅 4.7% 覆盖。用例覆盖：
 * - 目标库派生（已保存库去掉当前库）与展示名
 * - 浮层开合守卫（空列表/唯一库提示/批量默认 copy、单模型默认 move/busy 拦截）
 * - confirmTransfer 全部分支：成功/失败明细/零传输/业务错误/取消（零完成与
 *   有完成两种）/IPC 异常/扫描进行中不重复发起/OPT-18 取消令牌
 */

const CUR = 'D:\\lib\\cur'
const OTHER = 'D:\\lib\\other'
const THIRD = 'D:\\lib\\third'

/** scanModels 重扫收敛所需的最小扫描响应 */
function scanOk() {
  return Promise.resolve({
    models: [],
    root: state.folder || CUR,
    durationMs: 1,
    errors: [],
    relinked: 0,
    settings: defaultSettings(),
  })
}

let api

beforeEach(() => {
  api = makeApiMock()
  resetStoreTestState(api)
  // 跨库传输浮层进度为模块级单例：逐用例复位（storeTest 未覆盖 progress 字段）
  Object.assign(transferState, {
    visible: false,
    ids: [],
    mode: 'copy',
    busy: false,
    progress: null,
  })
  Object.assign(state.settings, defaultSettings())
})

describe('transferTargets 与展示名', () => {
  it('可选目标 = 已保存库列表去掉当前库（过滤空值与非字符串）', () => {
    state.folder = CUR
    state.settings.modelsFolders = [CUR, OTHER, '', null, THIRD]
    expect(transferTargets.value).toEqual([OTHER, THIRD])
  })

  it('targetDisplayName 取目录名并去除尾部分隔符', () => {
    expect(targetDisplayName('D:\\models\\vault\\')).toBe('vault')
    expect(targetDisplayName('D:/models/vault/')).toBe('vault')
    expect(targetDisplayName('vault')).toBe('vault')
    expect(targetDisplayName('')).toBe('')
  })

  it('盘符根回退显示自身（base 非空时直接使用）', () => {
    expect(targetDisplayName('C:\\')).toBe('C:')
  })
})

describe('openTransferToLibrary / closeTransfer', () => {
  it('空列表不打开浮层', () => {
    openTransferToLibrary([])
    openTransferToLibrary('')
    expect(transferState.visible).toBe(false)
  })

  it('非字符串项被过滤，仅剩有效项时按有效项打开', () => {
    state.folder = CUR
    state.settings.modelsFolders = [CUR, OTHER]
    openTransferToLibrary(['', 42, OTHER])
    expect(transferState.visible).toBe(true)
    expect(transferState.ids).toEqual([OTHER])
  })

  it('没有其他已保存库时提示且不打开', () => {
    state.folder = CUR
    state.settings.modelsFolders = [CUR]
    openTransferToLibrary([`${CUR}\\m.safetensors`])
    expect(transferState.visible).toBe(false)
    expect(state.toasts.some((t) => t.text.includes('只有这一个模型库'))).toBe(
      true,
    )
  })

  it('单模型默认 move（整理语义），多模型默认 copy（安全）', () => {
    state.folder = CUR
    state.settings.modelsFolders = [CUR, OTHER]

    openTransferToLibrary([`${CUR}\\a.safetensors`])
    expect(transferState.mode).toBe('move')
    expect(transferState.ids).toHaveLength(1)

    openTransferToLibrary([`${CUR}\\a.safetensors`, `${CUR}\\b.safetensors`])
    expect(transferState.mode).toBe('copy')
    expect(transferState.ids).toHaveLength(2)
  })

  it('busy 时 closeTransfer 被拦截，空闲时关闭并清空 ids', () => {
    transferState.visible = true
    transferState.ids = ['x']
    transferState.busy = true
    closeTransfer()
    expect(transferState.visible).toBe(true)

    transferState.busy = false
    closeTransfer()
    expect(transferState.visible).toBe(false)
    expect(transferState.ids).toEqual([])
  })
})

describe('confirmTransfer', () => {
  it('守卫：busy / 空目标 / 空 ids 时不发起 IPC', async () => {
    transferState.ids = ['x']
    transferState.busy = true
    await confirmTransfer(OTHER)
    expect(api.models.transferToLibrary).not.toHaveBeenCalled()

    transferState.busy = false
    await confirmTransfer('')
    expect(api.models.transferToLibrary).not.toHaveBeenCalled()

    transferState.ids = []
    await confirmTransfer(OTHER)
    expect(api.models.transferToLibrary).not.toHaveBeenCalled()
  })

  it('成功 copy：成功提示、浮层关闭、整表重扫收敛、busy/progress 复位', async () => {
    state.folder = CUR
    state.settings.modelsFolders = [CUR, OTHER]
    openTransferToLibrary([`${CUR}\\a.safetensors`, `${CUR}\\b.safetensors`])
    api.models.transferToLibrary.mockResolvedValue({
      transferred: 2,
      mode: 'copy',
      targetRoot: OTHER,
      failed: [],
      skipped: [],
    })
    api.models.scan.mockImplementation(() => scanOk())

    await confirmTransfer(OTHER)

    expect(api.models.transferToLibrary).toHaveBeenCalledTimes(1)
    const payload = api.models.transferToLibrary.mock.calls[0][0]
    expect(payload).toMatchObject({
      ids: [`${CUR}\\a.safetensors`, `${CUR}\\b.safetensors`],
      targetRoot: OTHER,
      mode: 'copy',
    })
    expect(typeof payload.opId).toBe('string')
    expect(
      state.toasts.some(
        (t) => t.type === 'success' && t.text.includes('复制 2 个'),
      ),
    ).toBe(true)
    expect(transferState.visible).toBe(false)
    expect(transferState.ids).toEqual([])
    expect(transferState.busy).toBe(false)
    expect(transferState.progress).toBeNull()
    // move 后源 id 已变化 / copy 后目标库待扫描：整表重扫收敛
    expect(api.models.scan).toHaveBeenCalledTimes(1)
  })

  it('部分失败：warn 提示聚合失败与跳过明细', async () => {
    transferState.ids = ['a', 'b', 'c']
    api.models.transferToLibrary.mockResolvedValue({
      transferred: 1,
      mode: 'copy',
      failed: [{ id: 'b', error: 'e' }],
      skipped: [{ id: 'c', reason: 'r' }],
    })
    api.models.scan.mockImplementation(() => scanOk())

    await confirmTransfer(OTHER)

    const warn = state.toasts.find((t) => t.type === 'warn')
    expect(warn.text).toContain('跳过 1 个')
    expect(warn.text).toContain('失败 1 个')
  })

  it('零传输：info 提示且仍然关闭浮层', async () => {
    transferState.ids = ['a']
    api.models.transferToLibrary.mockResolvedValue({
      transferred: 0,
      mode: 'copy',
      failed: [],
      skipped: [],
    })
    api.models.scan.mockImplementation(() => scanOk())

    await confirmTransfer(OTHER)

    expect(state.toasts.some((t) => t.text.includes('未传输任何模型'))).toBe(
      true,
    )
    expect(transferState.visible).toBe(false)
  })

  it('业务错误（res.error）：提示错误、浮层保持打开、busy 复位、不重扫', async () => {
    state.folder = CUR
    state.settings.modelsFolders = [CUR, OTHER]
    openTransferToLibrary([`${CUR}\\a.safetensors`])
    api.models.transferToLibrary.mockResolvedValue({
      error: '目标库不能是当前模型库',
    })

    await confirmTransfer(OTHER)

    expect(
      state.toasts.some((t) => t.text.includes('目标库不能是当前模型库')),
    ).toBe(true)
    // 错误路径不清浮层：用户可换目标重试；busy/progress 经 finally 复位
    expect(transferState.visible).toBe(true)
    expect(transferState.ids).toHaveLength(1)
    expect(transferState.busy).toBe(false)
    expect(api.models.scan).not.toHaveBeenCalled()
  })

  it('取消（零完成）：warn 提示、浮层关闭、不重扫', async () => {
    transferState.ids = ['a']
    api.models.transferToLibrary.mockResolvedValue({
      canceled: true,
      transferred: 0,
      mode: 'copy',
      failed: [],
      skipped: [],
    })

    await confirmTransfer(OTHER)

    expect(
      state.toasts.some((t) => t.type === 'warn' && t.text.includes('已取消')),
    ).toBe(true)
    expect(transferState.visible).toBe(false)
    expect(api.models.scan).not.toHaveBeenCalled()
  })

  it('取消（有完成）：提示已完成部分保留并触发重扫收敛', async () => {
    state.folder = CUR
    transferState.ids = ['a', 'b']
    api.models.transferToLibrary.mockResolvedValue({
      canceled: true,
      transferred: 1,
      mode: 'move',
      failed: [],
      skipped: [],
    })
    api.models.scan.mockImplementation(() => scanOk())

    await confirmTransfer(OTHER)

    expect(state.toasts.some((t) => t.text.includes('已完成 1 个'))).toBe(true)
    expect(api.models.scan).toHaveBeenCalledTimes(1)
  })

  it('IPC 通道异常：错误提示、busy 复位', async () => {
    transferState.ids = ['a']
    api.models.transferToLibrary.mockRejectedValue(new Error('通道断开'))

    await confirmTransfer(OTHER)

    expect(state.toasts.some((t) => t.text.includes('跨库传输失败'))).toBe(true)
    expect(transferState.busy).toBe(false)
  })

  it('扫描进行中不重复发起重扫', async () => {
    state.folder = CUR
    state.scanning = true
    transferState.ids = ['a']
    api.models.transferToLibrary.mockResolvedValue({
      transferred: 1,
      mode: 'copy',
      failed: [],
      skipped: [],
    })

    await confirmTransfer(OTHER)

    expect(api.models.transferToLibrary).toHaveBeenCalledTimes(1)
    expect(api.models.scan).not.toHaveBeenCalled()
  })

  it('OPT-18：busy 期间 cancelTransfer 经 models:cancelOp 中止在途传输', async () => {
    let release
    let sentOpId = null
    transferState.ids = ['a']
    api.models.transferToLibrary.mockImplementation((payload) => {
      sentOpId = payload.opId
      return new Promise((resolve) => {
        release = () =>
          resolve({
            canceled: true,
            transferred: 0,
            mode: 'copy',
            failed: [],
            skipped: [],
          })
      })
    })

    const pending = confirmTransfer(OTHER)
    await new Promise((r) => setTimeout(r, 0))
    expect(sentOpId).toBeTruthy()

    cancelTransfer()
    expect(api.models.cancelOp).toHaveBeenCalledWith(sentOpId)

    // 空闲后（无 activeOpId）再点取消不再发 IPC
    release()
    await pending
    cancelTransfer()
    expect(api.models.cancelOp).toHaveBeenCalledTimes(1)
    expect(transferState.busy).toBe(false)
  })
})
