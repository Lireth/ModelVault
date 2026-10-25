// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  civitaiComplete,
  civitaiIdentify,
  civitaiImportImages,
  replaceModels,
  state,
} from '../src/renderer/src/store/appStore'

/**
 * Civitai 在线识别 store 模块测试（O7 补强：此前 civitai-store.js 近零覆盖）：
 * - IPC 异常 / 业务错误 → toast 提示且不触碰本地列表
 * - 识别成功 → 模型条目同步 civitaiUrl/baseModel/触发词/备注；
 *   本地已有 baseModel（autoInfo 解析值）不覆盖
 * - 一键补全 → applied 字段映射为中文文案的 success toast
 * - 示例图导入 → 封面字段与 hasManualCover 同步、成败混合文案
 */

function makeApiMock() {
  return {
    models: {
      civitaiIdentify: vi.fn(),
      civitaiComplete: vi.fn(),
      civitaiImportImages: vi.fn(),
    },
  }
}

/** 种子两个模型条目（m1 已有 baseModel，验证不覆盖语义） */
function seedModels() {
  replaceModels([
    {
      id: 'D:\\m\\a.safetensors',
      name: 'a.safetensors',
      baseModel: 'Pony',
      civitaiUrl: '',
      cover: '',
      coverUrl: '',
      covers: [],
      hasManualCover: false,
    },
    {
      id: 'D:\\m\\b.safetensors',
      name: 'b.safetensors',
      baseModel: '',
      civitaiUrl: '',
      cover: '',
      coverUrl: '',
      covers: [],
      hasManualCover: false,
    },
  ])
}

/** 最近一条 toast */
function lastToast() {
  return state.toasts[state.toasts.length - 1]
}

beforeEach(() => {
  window.api = makeApiMock()
  seedModels()
  state.toasts.splice(0, state.toasts.length)
})

describe('civitaiIdentify', () => {
  it('IPC 异常与业务错误均 toast 提示且返回 found:false', async () => {
    window.api.models.civitaiIdentify.mockRejectedValue(new Error('IPC 断开'))
    const res1 = await civitaiIdentify('D:\\m\\a.safetensors')
    expect(res1).toEqual({ found: false, error: 'IPC 断开' })
    expect(lastToast().type).toBe('error')

    window.api.models.civitaiIdentify.mockResolvedValue({ error: '触发限流' })
    const res2 = await civitaiIdentify('D:\\m\\a.safetensors')
    expect(res2).toEqual({ found: false, error: '触发限流' })
    expect(lastToast().text).toContain('触发限流')
    expect(state.models[0].civitaiUrl).toBe('')
  })

  it('识别成功同步 civitaiUrl/baseModel/触发词/备注，已有 baseModel 不覆盖', async () => {
    window.api.models.civitaiIdentify.mockResolvedValue({
      found: true,
      url: 'https://civitai.com/models/1',
      meta: {
        civitaiUrl: 'https://civitai.com/models/1',
        baseModel: 'SDXL',
        triggerWords: 'x',
        note: 'n',
      },
    })
    const res = await civitaiIdentify('D:\\m\\a.safetensors')
    expect(res.found).toBe(true)
    expect(state.models[0]).toMatchObject({
      civitaiUrl: 'https://civitai.com/models/1',
      baseModel: 'Pony',
      triggerWords: 'x',
      note: 'n',
    })

    // 本地无 baseModel 的条目：应用识别值
    await civitaiIdentify('D:\\m\\b.safetensors')
    expect(state.models[1].baseModel).toBe('SDXL')
  })

  it('meta 缺省或 id 不在列表时安全无操作', async () => {
    window.api.models.civitaiIdentify.mockResolvedValue({
      found: true,
      url: 'u',
      meta: null,
    })
    await expect(civitaiIdentify('D:\\m\\a.safetensors')).resolves.toBeTruthy()
    await expect(
      civitaiIdentify('D:\\m\\missing.safetensors'),
    ).resolves.toBeTruthy()
    expect(state.models[0].civitaiUrl).toBe('')
  })
})

describe('civitaiComplete', () => {
  it('applied 字段映射为中文文案的 success toast', async () => {
    window.api.models.civitaiComplete.mockResolvedValue({
      found: true,
      applied: ['triggerWords', 'note', 'customField'],
      meta: { civitaiUrl: 'u', triggerWords: 'x', note: 'n' },
    })
    const res = await civitaiComplete('D:\\m\\a.safetensors')
    expect(res.found).toBe(true)
    expect(state.models[0].triggerWords).toBe('x')
    expect(lastToast().type).toBe('success')
    expect(lastToast().text).toBe('已补全：触发词、备注、customField')
  })

  it('无空缺字段时不出 success toast', async () => {
    window.api.models.civitaiComplete.mockResolvedValue({
      found: true,
      applied: [],
      meta: null,
    })
    const res = await civitaiComplete('D:\\m\\a.safetensors')
    expect(res.applied).toEqual([])
    expect(state.toasts.length).toBe(0)
  })

  it('IPC 异常与业务错误 toast 提示', async () => {
    window.api.models.civitaiComplete.mockRejectedValue(new Error('boom'))
    const res = await civitaiComplete('D:\\m\\a.safetensors')
    expect(res).toEqual({ found: false, error: 'boom' })
    expect(lastToast().text).toContain('Civitai 补全失败')

    window.api.models.civitaiComplete.mockResolvedValue({ error: 'bad' })
    expect(await civitaiComplete('D:\\m\\a.safetensors')).toEqual({
      found: false,
      error: 'bad',
    })
  })
})

describe('civitaiImportImages', () => {
  it('成功导入同步封面字段与 hasManualCover，混合失败文案', async () => {
    window.api.models.civitaiImportImages.mockResolvedValue({
      added: 2,
      failed: [{ url: 'u2', error: '网络错误' }],
      cover: 'covers/c.png',
      coverUrl: 'mvimg:///c.png',
      covers: ['covers/c.png'],
    })
    const res = await civitaiImportImages('D:\\m\\a.safetensors', [
      { url: 'u1' },
      { url: 'u2' },
    ])
    expect(res.added).toBe(2)
    expect(state.models[0]).toMatchObject({
      cover: 'covers/c.png',
      coverUrl: 'mvimg:///c.png',
      covers: ['covers/c.png'],
      hasManualCover: true,
    })
    expect(lastToast().text).toBe('已添加 2 张示例图（1 张失败）')

    // 无失败时文案不同
    state.toasts.splice(0, state.toasts.length)
    window.api.models.civitaiImportImages.mockResolvedValue({
      added: 1,
      failed: [],
      cover: 'covers/d.png',
      coverUrl: 'mvimg:///d.png',
      covers: ['covers/d.png'],
    })
    await civitaiImportImages('D:\\m\\a.safetensors', [{ url: 'u1' }])
    expect(lastToast().text).toBe('已添加 1 张示例图')
  })

  it('业务错误 toast 且返回原结果；IPC 异常返回 error', async () => {
    window.api.models.civitaiImportImages.mockResolvedValue({
      error: '未选择要导入的示例图',
    })
    const res1 = await civitaiImportImages('D:\\m\\a.safetensors', [])
    expect(res1).toEqual({ error: '未选择要导入的示例图' })
    expect(lastToast().text).toBe('未选择要导入的示例图')

    window.api.models.civitaiImportImages.mockRejectedValue(new Error('oops'))
    const res2 = await civitaiImportImages('D:\\m\\a.safetensors', [])
    expect(res2).toEqual({ error: 'oops' })
    expect(state.models[0].covers).toEqual([])
  })
})
