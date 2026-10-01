import { describe, it, expect, vi } from 'vitest'
import { fakeUserData } from './setup'

/**
 * models:saveModelData 合并逻辑回归测试（B2）：
 * 局部保存（仅传部分字段）时不得将未传字段静默清空。
 * models.js 依赖链较重，此处对 electron 提供完整最小桩。
 */
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  clipboard: { readImage: vi.fn() },
  net: { fetch: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() }
}))

import { mergeSaveModelData } from '../src/main/ipc/models'

const baseMeta = {
  alias: '旧别名',
  params: { steps: 28, cfg: 7 },
  note: '旧备注',
  noteSource: 'sidecar',
  subCategory: 'Pony',
  covers: ['covers/a.png'],
  cover: 'covers/a.png'
}

describe('mergeSaveModelData', () => {
  it('全字段显式传入时正常覆盖', () => {
    const merged = mergeSaveModelData(baseMeta, {
      alias: '新别名',
      params: { steps: 30 },
      note: '新备注',
      subCategory: 'SDXL'
    })
    expect(merged.alias).toBe('新别名')
    expect(merged.params).toEqual({ steps: 30 })
    expect(merged.note).toBe('新备注')
    expect(merged.subCategory).toBe('SDXL')
    // 用户编辑备注后清除 sidecar 来源标记
    expect(merged.noteSource).toBe('')
  })

  it('局部保存仅传 note 时，其余字段保留原值不被清空', () => {
    const merged = mergeSaveModelData(baseMeta, { note: '只改备注' })
    expect(merged.note).toBe('只改备注')
    expect(merged.alias).toBe('旧别名')
    expect(merged.params).toEqual({ steps: 28, cfg: 7 })
    expect(merged.subCategory).toBe('Pony')
    expect(merged.noteSource).toBe('')
  })

  it('patch 全部未传时 existing 字段原样保留（含 noteSource）', () => {
    const merged = mergeSaveModelData(baseMeta, {})
    expect(merged).toEqual(baseMeta)
  })

  it('显式传 null/空串仍视为有效覆盖（允许主动清空）', () => {
    const merged = mergeSaveModelData(baseMeta, { params: null, subCategory: '' })
    expect(merged.params).toBeNull()
    expect(merged.subCategory).toBe('')
    expect(merged.alias).toBe('旧别名')
  })

  it('纯函数不修改入参', () => {
    const snapshot = { ...baseMeta }
    mergeSaveModelData(baseMeta, { note: '改', alias: '改' })
    expect(baseMeta).toEqual(snapshot)
  })
})
