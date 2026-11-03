// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { useBackupTransfer } from '../src/renderer/src/composables/useBackupTransfer'
import { replaceModels, state } from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * 备份导出/恢复 UI 逻辑测试（C4 数据关键 UI 补齐）：
 * useBackupTransfer 此前仅 4.1% 覆盖率，但它承载「覆盖用户数据」的唯一
 * 恢复入口。本文件覆盖三种导出范围、取消/业务错误/IPC 异常、忙碌标志，
 * 以及恢复成功后的设置重载、主题/排序应用、当前库重扫与部分合并文案。
 */

setupComponentTest()

/** 最近一条 toast（断言提示分级与文案） */
function lastToast() {
  return state.toasts[state.toasts.length - 1]
}

/** 播种模型（filteredModels 用于「导出当前筛选」的 ids 载荷） */
function seedModels() {
  replaceModels(
    ['m1', 'm2'].map((id) => ({
      id,
      name: id,
      type: 'checkpoint',
      size: 1000,
      mtimeMs: 1000,
      favorite: false,
      nsfw: false,
      rating: 0,
      alias: '',
      note: '',
      subCategory: '',
      triggerWords: '',
    })),
  )
}

describe('useBackupTransfer 导出', () => {
  it('完整备份默认 mode=full，成功提示包含模型标注与封面数量', async () => {
    const { onExportBackup, backupBusy } = useBackupTransfer()
    window.api.models.exportBackup.mockResolvedValue({
      path: 'D:\\backup.zip',
      mode: 'full',
      library: true,
      models: 2,
      covers: 3,
    })

    await onExportBackup()

    expect(window.api.models.exportBackup).toHaveBeenCalledWith({
      mode: 'full',
    })
    expect(backupBusy.value).toBe(false)
    expect(lastToast()).toMatchObject({ type: 'success' })
    expect(lastToast().text).toContain('完整备份已导出')
    expect(lastToast().text).toContain('2 个模型标注 / 3 张封面')
  })

  it('无标注库导出成功时提示「应用设置」而非空数量', async () => {
    const { onExportBackup } = useBackupTransfer()
    window.api.models.exportBackup.mockResolvedValue({
      path: 'D:\\backup.zip',
      mode: 'full',
      library: false,
      models: 0,
      covers: 0,
    })

    await onExportBackup()

    expect(lastToast().type).toBe('success')
    expect(lastToast().text).toContain('应用设置（当前库暂无标注数据）')
  })

  it('「当前筛选」导出携带 filteredModels 的 ids', async () => {
    seedModels()
    const { onExportSelectedBackup } = useBackupTransfer()
    window.api.models.exportBackup.mockResolvedValue({
      path: 'D:\\backup.zip',
      mode: 'selected',
      library: true,
      models: 2,
      covers: 0,
    })

    onExportSelectedBackup()
    await flushPromises()

    expect(window.api.models.exportBackup).toHaveBeenCalledWith({
      mode: 'selected',
      ids: ['m1', 'm2'],
    })
    expect(lastToast().text).toContain('当前筛选备份已导出')
  })

  it('「仅标注」导出携带 mode=metadata', async () => {
    const { onExportMetadataBackup } = useBackupTransfer()
    window.api.models.exportBackup.mockResolvedValue({
      path: 'D:\\backup.zip',
      mode: 'metadata',
      library: true,
      models: 1,
      covers: 0,
    })

    onExportMetadataBackup()
    await flushPromises()

    expect(window.api.models.exportBackup).toHaveBeenCalledWith({
      mode: 'metadata',
    })
    expect(lastToast().text).toContain('仅标注备份已导出')
  })

  it('用户取消不弹提示且复位忙碌标志', async () => {
    const { onExportBackup, backupBusy } = useBackupTransfer()
    window.api.models.exportBackup.mockResolvedValue({ canceled: true })
    const before = state.toasts.length

    await onExportBackup()

    expect(state.toasts.length).toBe(before)
    expect(backupBusy.value).toBe(false)
  })

  it('业务错误与 IPC 异常均以 error 提示，不误报成功', async () => {
    const { onExportBackup, backupBusy } = useBackupTransfer()
    window.api.models.exportBackup.mockResolvedValue({
      error: '磁盘空间不足',
    })

    await onExportBackup()
    expect(lastToast()).toMatchObject({
      type: 'error',
      text: '磁盘空间不足',
    })

    state.toasts.splice(0, state.toasts.length)
    window.api.models.exportBackup.mockRejectedValue(new Error('IPC 通道断开'))
    await onExportBackup()
    expect(lastToast().type).toBe('error')
    expect(lastToast().text).toContain('备份导出失败: IPC 通道断开')
    expect(backupBusy.value).toBe(false)
  })

  it('导出期间 backupBusy 置位，落定后复位', async () => {
    const { onExportBackup, backupBusy } = useBackupTransfer()
    let resolveExport
    window.api.models.exportBackup.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveExport = resolve
        }),
    )

    const pending = onExportBackup()
    await Promise.resolve()
    expect(backupBusy.value).toBe(true)

    resolveExport({ path: 'D:\\b.zip', mode: 'full', library: false })
    await pending
    expect(backupBusy.value).toBe(false)
  })
})

describe('useBackupTransfer 恢复', () => {
  it('恢复成功：重载设置、应用主题/排序，并在当前库恢复后重扫', async () => {
    const onRestored = vi.fn()
    const { onImportBackup, backupBusy } = useBackupTransfer({ onRestored })
    state.folder = 'D:\\models\\A'
    window.api.models.importBackup.mockResolvedValue({
      settingsRestored: true,
      libraryRestored: { root: 'D:\\models\\A', models: 4, covers: 2 },
    })
    window.api.models.loadStore.mockResolvedValue({
      settings: { theme: 'light', sortBy: 'size', sortAsc: false },
    })
    window.api.models.scan.mockResolvedValue({
      models: [],
      errors: [],
      byType: {},
      durationMs: 1,
    })

    await onImportBackup()

    expect(onRestored).toHaveBeenCalledTimes(1)
    expect(window.api.window.setTheme).toHaveBeenLastCalledWith('light')
    expect(state.sortBy).toBe('size')
    expect(state.sortAsc).toBe(false)
    expect(window.api.models.scan).toHaveBeenCalledTimes(1)
    expect(backupBusy.value).toBe(false)
    expect(lastToast().type).toBe('success')
    expect(lastToast().text).toContain('应用设置')
    expect(lastToast().text).toContain('模型库数据（4 个模型 / 2 张封面）')
  })

  it('部分合并提示新增/更新数量；非当前库恢复不触发重扫', async () => {
    const onRestored = vi.fn()
    const { onImportBackup } = useBackupTransfer({ onRestored })
    state.folder = 'D:\\models\\A'
    window.api.models.importBackup.mockResolvedValue({
      settingsRestored: false,
      libraryRestored: {
        root: 'D:\\models\\B',
        partial: true,
        models: 5,
        added: 2,
        updated: 3,
        covers: 4,
      },
    })

    await onImportBackup()

    expect(onRestored).not.toHaveBeenCalled()
    expect(window.api.models.scan).not.toHaveBeenCalled()
    expect(lastToast().text).toContain('合并 5 个模型标注')
    expect(lastToast().text).toContain('新增 2 / 更新 3 / 4 张封面')
  })

  it('备份无数据时给 warn 提示，不误报恢复成功', async () => {
    const { onImportBackup, backupBusy } = useBackupTransfer()
    window.api.models.importBackup.mockResolvedValue({})

    await onImportBackup()

    expect(lastToast()).toMatchObject({ type: 'warn' })
    expect(lastToast().text).toContain('备份中无可恢复的数据')
    expect(backupBusy.value).toBe(false)
  })

  it('取消/业务错误/IPC 异常分支均有明确反馈', async () => {
    const { onImportBackup } = useBackupTransfer()

    window.api.models.importBackup.mockResolvedValue({ canceled: true })
    const before = state.toasts.length
    await onImportBackup()
    expect(state.toasts.length).toBe(before)

    window.api.models.importBackup.mockResolvedValue({
      error: '备份格式不支持',
    })
    await onImportBackup()
    expect(lastToast()).toMatchObject({
      type: 'error',
      text: '备份格式不支持',
    })

    window.api.models.importBackup.mockRejectedValue(new Error('IPC 通道断开'))
    await onImportBackup()
    expect(lastToast().type).toBe('error')
    expect(lastToast().text).toContain('备份恢复失败: IPC 通道断开')
  })

  it('恢复期间 backupBusy 置位，设置重载失败也不阻断结果提示', async () => {
    const { onImportBackup, backupBusy } = useBackupTransfer()
    let resolveImport
    window.api.models.importBackup.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveImport = resolve
        }),
    )
    window.api.models.loadStore.mockRejectedValue(new Error('读取设置失败'))

    const pending = onImportBackup()
    await Promise.resolve()
    expect(backupBusy.value).toBe(true)

    resolveImport({ settingsRestored: true })
    await pending

    expect(backupBusy.value).toBe(false)
    expect(lastToast()).toMatchObject({ type: 'success' })
    expect(lastToast().text).toContain('备份已恢复')
  })
})
