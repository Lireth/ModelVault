import { describe, it, expect, beforeEach } from 'vitest'
import {
  makeApiMock,
  resetStoreTestState,
  makeModel,
} from './helpers/storeTest'
import {
  moveModelTo,
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
})
