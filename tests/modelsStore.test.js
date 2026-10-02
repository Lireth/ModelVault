import { describe, it, expect, vi } from 'vitest'
import { fakeUserData } from './setup'
import path from 'node:path'

/**
 * models 域辅助纯函数特征测试（D1，先测后拆基线）：
 * - sidecarFilesFor：删除模型时需一并清理的同名 sidecar 清单（deleteModel 正确性核心）
 * - paramSummaryFromMeta：右键菜单「复制推荐参数」的格式化
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  BrowserWindow: Object.assign(vi.fn(), {
    fromWebContents: vi.fn(),
    getAllWindows: vi.fn(() => [])
  }),
  clipboard: { read: vi.fn(), writeText: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  shell: { trashItem: vi.fn(), showItemInFolder: vi.fn() },
  net: { fetch: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() }
}))

import { paramSummaryFromMeta, sidecarFilesFor } from '../src/main/ipc/models/misc'

describe('sidecarFilesFor', () => {
  it('返回同名 .txt 与全部预览图候选（与展示侧 SIDECAR_PREVIEW_EXTS 一致，B17）', () => {
    const dir = path.join('D:', 'models', 'loras')
    const files = sidecarFilesFor(path.join(dir, 'style-a.safetensors'))
    expect(files[0]).toBe(path.join(dir, 'style-a.txt'))
    // .txt 之后逐个列出预览图候选（.png/.preview.png/.jpg/.jpeg/.webp/.gif/.bmp，共 7 个）
    expect(files.length).toBe(1 + 7)
    expect(files).toContain(path.join(dir, 'style-a.preview.png'))
    expect(files).toContain(path.join(dir, 'style-a.bmp'))
  })

  it('文件名含多个点时仅按最后一个扩展名取基名', () => {
    const files = sidecarFilesFor(path.join('D:', 'm', 'flux.1.dev.safetensors'))
    expect(files[0]).toBe(path.join('D:', 'm', 'flux.1.dev.txt'))
  })
})

describe('paramSummaryFromMeta', () => {
  it('空参数返回空字符串（右键菜单不显示「复制推荐参数」）', () => {
    expect(paramSummaryFromMeta(null)).toBe('')
    expect(paramSummaryFromMeta({})).toBe('')
  })

  it('cfg 区间与单值两种格式', () => {
    expect(paramSummaryFromMeta({ cfgMin: 7, cfgMax: 7 })).toBe('CFG: 7')
    expect(paramSummaryFromMeta({ cfgMin: 4, cfgMax: 12 })).toBe('CFG: 4~12')
  })

  it('全字段按固定顺序拼接', () => {
    const summary = paramSummaryFromMeta({
      steps: 28,
      cfgMin: 4,
      cfgMax: 12,
      sampler: 'euler',
      scheduler: 'karras',
      resMin: 512,
      resMax: 1024
    })
    expect(summary).toBe('Steps: 28, CFG: 4~12, Sampler: euler, Scheduler: karras, Size: 512x1024')
  })
})
