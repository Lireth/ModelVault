import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  makeApiMock,
  resetStoreTestState,
  makeModel,
} from './helpers/storeTest'
import {
  addModelTag,
  batchEditTags,
  deleteModel,
  moveModelTo,
  removeModelTag,
  renameModel,
  revealModel,
  replaceModels,
  setModelTags,
  showContextMenu,
  state,
  toggleDisabledModel,
} from '../src/renderer/src/store/appStore'

/**
 * appStoreFiles.test.js（ENG-1 自 appStore.test.js 按域拆分，用例内容保持原样）
 */

let api

beforeEach(() => {
  api = makeApiMock()
  resetStoreTestState(api)
})

describe('自由标签 per-id 串行队列（B2 回归）', () => {
  /** 可控 IPC 桩：每次调用返回一个手动 settle 的 Promise */
  function makeDeferredApi() {
    const calls = []
    api.models.setModelTags.mockImplementation(
      () =>
        new Promise((resolve) => {
          calls.push({ resolve })
        }),
    )
    return calls
  }

  beforeEach(() => {
    state.folder = 'D:\\models'
  })

  it('连续快速添加两个标签：串行执行且后一次基于前一次结果，不丢标签', async () => {
    replaceModels([makeModel('m1', { tags: ['旧'] })])
    const calls = makeDeferredApi()

    const p1 = addModelTag('m1', 'A')
    const p2 = addModelTag('m1', 'B') // 第一次 IPC 在途时发起（B2 原始触发路径）

    // 串行：第一次未落定时第二次不得发起 IPC
    expect(api.models.setModelTags).toHaveBeenCalledTimes(1)
    expect(api.models.setModelTags).toHaveBeenNthCalledWith(1, 'm1', [
      '旧',
      'A',
    ])
    calls[0].resolve({ meta: { tags: ['旧', 'A'] } })
    expect(await p1).toBe(true)

    // 第二次在第一次落定后执行，基于最新标签计算
    expect(api.models.setModelTags).toHaveBeenCalledTimes(2)
    expect(api.models.setModelTags).toHaveBeenNthCalledWith(2, 'm1', [
      '旧',
      'A',
      'B',
    ])
    calls[1].resolve({ meta: { tags: ['旧', 'A', 'B'] } })
    expect(await p2).toBe(true)
    expect(state.models[0].tags).toEqual(['旧', 'A', 'B'])
  })

  it('添加在途时删除另一标签：以含新标签的最新列表为基计算', async () => {
    replaceModels([makeModel('m1', { tags: ['x', 'y'] })])
    const calls = makeDeferredApi()

    const p1 = addModelTag('m1', 'A')
    const p2 = removeModelTag('m1', 'y')

    calls[0].resolve({ meta: { tags: ['x', 'y', 'A'] } })
    await p1
    // 删除基于含 A 的最新列表，不会把 A 抹掉
    expect(api.models.setModelTags).toHaveBeenNthCalledWith(2, 'm1', ['x', 'A'])
    calls[1].resolve({ meta: { tags: ['x', 'A'] } })
    expect(await p2).toBe(true)
    expect(state.models[0].tags).toEqual(['x', 'A'])
  })

  it('写盘失败：状态保持原值并给出可见反馈，且队列不被失败阻塞', async () => {
    replaceModels([makeModel('m1', { tags: ['旧'] })])
    const calls = makeDeferredApi()

    const p1 = addModelTag('m1', 'A')
    const p2 = addModelTag('m1', 'B')

    // 第一次失败：不落盘（返回 error），本地状态不变，toast 可见
    calls[0].resolve({ error: '磁盘写入失败' })
    expect(await p1).toBe(false)
    expect(state.models[0].tags).toEqual(['旧'])
    expect(
      state.toasts.some(
        (t) => t.type === 'error' && t.text.includes('磁盘写入失败'),
      ),
    ).toBe(true)

    // 第二次不受前一次失败影响，基于原值继续
    expect(api.models.setModelTags).toHaveBeenNthCalledWith(2, 'm1', [
      '旧',
      'B',
    ])
    calls[1].resolve({ meta: { tags: ['旧', 'B'] } })
    expect(await p2).toBe(true)
    expect(state.models[0].tags).toEqual(['旧', 'B'])
  })

  it('IPC 抛异常：toast 可见且状态不变', async () => {
    replaceModels([makeModel('m1', { tags: ['旧'] })])
    api.models.setModelTags.mockRejectedValue(new Error('IPC 通道断开'))
    expect(await addModelTag('m1', 'A')).toBe(false)
    expect(state.models[0].tags).toEqual(['旧'])
    expect(
      state.toasts.some(
        (t) => t.type === 'error' && t.text.includes('IPC 通道断开'),
      ),
    ).toBe(true)
  })

  it('重复添加（含在途未落定）在执行时拦截并提示，不发冗余 IPC', async () => {
    replaceModels([makeModel('m1', { tags: [] })])
    const calls = makeDeferredApi()

    const p1 = addModelTag('m1', 'A')
    const p2 = addModelTag('m1', 'a') // 大小写变体：本地尚无 A，点击期校验拦不住
    calls[0].resolve({ meta: { tags: ['A'] } })
    await p1
    expect(await p2).toBe(false)
    expect(api.models.setModelTags).toHaveBeenCalledTimes(1)
    expect(state.toasts.some((t) => t.text.includes('标签已存在'))).toBe(true)
  })

  it('与批量标签编辑交错：批量锁串行化，双方均基于最新标签（C1/B2）', async () => {
    replaceModels([makeModel('m1', { tags: ['旧'] })])
    state.multiSelect.active = true
    state.multiSelect.ids = ['m1']
    // 详情即时编辑的 per-id 队列桩
    const calls = makeDeferredApi()
    // 批量标签单次 IPC 桩
    const bulkCalls = []
    api.models.setModelTagsBulk.mockImplementation(
      (items) =>
        new Promise((resolve) => {
          bulkCalls.push({ items, resolve })
        }),
    )

    // 批量「添加 批」发起后在途，详情页再即时添加「详」
    const pBatch = batchEditTags({ mode: 'add', tags: ['批'] })
    const pDetail = addModelTag('m1', '详')

    await vi.waitFor(() =>
      expect(api.models.setModelTagsBulk).toHaveBeenCalledTimes(1),
    )
    // 批量以当前最新标签计算；详情编辑被批量锁挡住，尚未发 IPC
    expect(bulkCalls[0].items).toEqual([{ id: 'm1', tags: ['旧', '批'] }])
    expect(api.models.setModelTags).not.toHaveBeenCalled()

    bulkCalls[0].resolve({
      updated: [{ id: 'm1', tags: ['旧', '批'] }],
      failed: [],
    })
    await pBatch

    // 批量落定并回写本地状态后，详情编辑才开始：以含「批」的最新列表为基
    await vi.waitFor(() =>
      expect(api.models.setModelTags).toHaveBeenCalledTimes(1),
    )
    expect(api.models.setModelTags).toHaveBeenNthCalledWith(1, 'm1', [
      '旧',
      '批',
      '详',
    ])
    calls[0].resolve({ meta: { tags: ['旧', '批', '详'] } })
    await pDetail
    expect(state.models[0].tags).toEqual(['旧', '批', '详'])
  })
})

describe('文件操作编排（F10/F11）', () => {
  beforeEach(() => {
    state.folder = 'D:\\models'
    api.models.scan.mockResolvedValue({
      models: [],
      errors: [],
      byType: {},
      durationMs: 1,
    })
  })

  it('setModelTags 成功同步标签；业务错误保留原值并提示', async () => {
    replaceModels([makeModel('m1', { tags: ['旧标签'] })])
    api.models.setModelTags.mockResolvedValue({
      meta: { tags: ['新A', '新B'] },
    })

    expect(await setModelTags('m1', ['新A', '新B'])).toBe(true)
    expect(state.models[0].tags).toEqual(['新A', '新B'])

    api.models.setModelTags.mockResolvedValue({ error: '标签超限' })
    expect(await setModelTags('m1', ['x'])).toBe(false)
    expect(state.models[0].tags).toEqual(['新A', '新B'])
    expect(state.toasts.some((t) => t.text.includes('标签超限'))).toBe(true)
  })

  it('revealModel 调用定位 IPC；失败时提示错误', async () => {
    api.models.reveal.mockResolvedValue({ ok: true })
    await revealModel('D:\\models\\a.safetensors')
    expect(api.models.reveal).toHaveBeenCalledWith('D:\\models\\a.safetensors')

    api.models.reveal.mockResolvedValue({ error: '路径越界' })
    await revealModel('D:\\models\\a.safetensors')
    expect(state.toasts.some((t) => t.text.includes('路径越界'))).toBe(true)
  })

  it('toggleDisabledModel 成功提示并重扫；扫描进行中不重扫', async () => {
    api.models.toggleDisabled.mockResolvedValue({
      path: 'D:\\models\\a.safetensors.disabled',
    })

    expect(await toggleDisabledModel('a', true)).toBe(true)
    expect(state.toasts.some((t) => t.text.includes('已禁用'))).toBe(true)
    expect(api.models.scan).toHaveBeenCalledTimes(1)

    state.scanning = true
    api.models.scan.mockClear()
    expect(await toggleDisabledModel('a', false)).toBe(true)
    expect(api.models.scan).not.toHaveBeenCalled()
  })

  it('moveModelTo：取消静默返回、成功提示并重扫、错误提示', async () => {
    api.models.moveModelTo.mockResolvedValue({ canceled: true })
    expect(await moveModelTo('a')).toBe(false)
    expect(api.models.scan).not.toHaveBeenCalled()

    api.models.moveModelTo.mockResolvedValue({
      path: 'D:\\models\\LoRA\\a.safetensors',
    })
    expect(await moveModelTo('a')).toBe(true)
    expect(state.toasts.some((t) => t.text.includes('已移动到'))).toBe(true)
    expect(api.models.scan).toHaveBeenCalledTimes(1)

    api.models.moveModelTo.mockResolvedValue({ error: '目标目录不可写' })
    expect(await moveModelTo('a')).toBe(false)
    expect(state.toasts.some((t) => t.text.includes('目标目录不可写'))).toBe(
      true,
    )
  })

  it('showContextMenu 调用原生菜单；IPC 异常时提示错误', async () => {
    api.models.popupMenu.mockResolvedValue({ ok: true })
    await showContextMenu('m1')
    expect(api.models.popupMenu).toHaveBeenCalledWith('m1')

    api.models.popupMenu.mockRejectedValue(new Error('窗口已关闭'))
    await showContextMenu('m1')
    expect(state.toasts.some((t) => t.text.includes('打开右键菜单失败'))).toBe(
      true,
    )
  })

  it('renameModel 成功：关闭详情、提示并重扫；未变化时提示且不重扫', async () => {
    replaceModels([makeModel('m1')])
    state.selectedId = 'm1'
    api.models.renameModel.mockResolvedValue({
      path: 'D:\\models\\b.safetensors',
      renamedSidecars: 2,
      sidecarWarnings: [],
    })

    expect(await renameModel('m1', ' b ')).toBe(true)
    expect(api.models.renameModel).toHaveBeenCalledWith('m1', 'b')
    expect(state.selectedId).toBeNull()
    expect(state.toasts.some((t) => t.text.includes('已重命名为「b」'))).toBe(
      true,
    )
    expect(api.models.scan).toHaveBeenCalledTimes(1)

    api.models.scan.mockClear()
    api.models.renameModel.mockResolvedValue({
      path: 'm1',
      sidecarWarnings: [],
    })
    expect(await renameModel('m1', 'm1')).toBe(true)
    expect(state.toasts.some((t) => t.text.includes('文件名未变化'))).toBe(true)
    expect(api.models.scan).not.toHaveBeenCalled()
  })

  it('renameModel sidecar 未迁移时以 warn 提示', async () => {
    api.models.renameModel.mockResolvedValue({
      path: 'D:\\models\\b.safetensors',
      sidecarWarnings: ['a.txt 的目标已存在，已跳过'],
    })

    expect(await renameModel('m1', 'b')).toBe(true)
    expect(
      state.toasts.some(
        (t) => t.type === 'warn' && t.text.includes('1 个 sidecar 未迁移'),
      ),
    ).toBe(true)
  })

  it('renameModel 空名/扫描中不发起 IPC；业务错误与 IPC reject 均提示', async () => {
    expect(await renameModel('m1', '   ')).toBe(false)
    state.scanning = true
    expect(await renameModel('m1', 'b')).toBe(false)
    state.scanning = false
    expect(api.models.renameModel).not.toHaveBeenCalled()

    api.models.renameModel.mockResolvedValue({ error: '目标文件名已存在' })
    expect(await renameModel('m1', 'b')).toBe(false)
    expect(state.toasts.some((t) => t.text.includes('目标文件名已存在'))).toBe(
      true,
    )

    api.models.renameModel.mockRejectedValue(new Error('通道断开'))
    expect(await renameModel('m1', 'b')).toBe(false)
    expect(state.toasts.some((t) => t.text.includes('重命名失败'))).toBe(true)
  })

  it('deleteModel 删除当前打开模型：selectedId 与 detailDirty 同步清除（FIX-9）', async () => {
    api.models.deleteModel.mockResolvedValue({ ok: true })
    replaceModels([makeModel('m1'), makeModel('m2')])

    // 删除非当前打开模型：选中与脏标记不受影响
    state.selectedId = 'm2'
    state.detailDirty = true
    expect(await deleteModel('m1')).toBe(true)
    expect(state.selectedId).toBe('m2')
    expect(state.detailDirty).toBe(true)

    // 删除当前打开模型：详情被强制关闭，MetaForm 已卸载、无人写回脏标记，
    // 不同步清除会让下一次 openDetail 误弹「放弃修改」确认（幽灵确认框）
    expect(await deleteModel('m2')).toBe(true)
    expect(state.selectedId).toBeNull()
    expect(state.detailDirty).toBe(false)
  })

  it('renameModel 重命名当前打开模型：detailDirty 同步清除（FIX-9）', async () => {
    api.models.renameModel.mockResolvedValue({
      path: 'D:\\models\\b.safetensors',
      sidecarWarnings: [],
    })
    replaceModels([makeModel('m1')])
    state.selectedId = 'm1'
    state.detailDirty = true

    expect(await renameModel('m1', 'b')).toBe(true)
    expect(state.selectedId).toBeNull()
    expect(state.detailDirty).toBe(false)
  })
})
