import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  buildCsv,
  buildExportRows,
  buildJson,
  buildMarkdown,
} from '../src/renderer/src/store/model-export'
import { replaceModels, state } from '../src/renderer/src/store/appStore'

/**
 * 模型清单导出（FN-04）：
 * 纯构造器测试覆盖字段映射、CSV/Markdown 转义与 JSON 结构。
 */

function model(overrides = {}) {
  return {
    id: 'D:\\models\\a.safetensors',
    name: 'a.safetensors',
    type: 'lora',
    subCategory: 'role',
    baseModel: 'Pony V6',
    size: 1024,
    mtimeMs: Date.UTC(2026, 0, 2, 3, 4, 5),
    rating: 4,
    favorite: true,
    nsfw: false,
    tags: ['角色', '风格'],
    triggerWords: 'neon, cyber',
    note: '第一行\n第二行, 含逗号 "引号" | 竖线',
    params: { steps: 28, cfgMin: 4, cfgMax: 7, sampler: 'euler' },
    civitaiUrl: 'https://civitai.com/models/1',
    ...overrides,
  }
}

describe('buildExportRows', () => {
  it('映射展示字段、参数摘要与 ISO 时间', () => {
    const [row] = buildExportRows([model()])
    expect(row.typeLabel).toContain('LoRA')
    expect(row.subCategoryLabel).toBeTruthy()
    expect(row.baseModel).toBe('Pony V6')
    expect(row.paramsSummary).toContain('28 步')
    expect(row.mtime).toBe('2026-01-02T03:04:05.000Z')
    expect(row.favorite).toBe(true)
    expect(row.tags).toEqual(['角色', '风格'])
    expect(row.path).toBe('D:\\models\\a.safetensors')
  })

  it('空/缺失字段容错', () => {
    const [row] = buildExportRows([{ id: 'x', name: 'x', type: 'weird' }])
    expect(row.sizeBytes).toBe(0)
    expect(row.rating).toBe(0)
    expect(row.tags).toEqual([])
    expect(row.typeLabel).toBe('其他模型')
  })
})

describe('格式化输出', () => {
  const rows = buildExportRows([model()])

  it('CSV：带 BOM、表头、逗号/引号/换行转义', () => {
    const csv = buildCsv(rows)
    expect(csv.startsWith('\uFEFF')).toBe(true)
    expect(csv).toContain('名称,别名,分类')
    // 备注中的引号翻倍、换行被包在引号单元格内
    expect(csv).toContain('"第一行\n第二行, 含逗号 ""引号"" | 竖线"')
    expect(csv).toContain('角色 | 风格')
  })

  it('Markdown：竖线转义、换行折叠', () => {
    const md = buildMarkdown(rows)
    expect(md).toContain('| 名称 | 别名 |')
    expect(md).toContain('\\|')
    // 换行折叠为空格，表格不破行
    expect(md).toContain('第一行 第二行')
  })

  it('JSON：保留结构化参数与布尔值', () => {
    const parsed = JSON.parse(buildJson(rows))
    expect(parsed).toHaveLength(1)
    expect(parsed[0].params.steps).toBe(28)
    expect(parsed[0].favorite).toBe(true)
    expect(parsed[0].tags).toEqual(['角色', '风格'])
  })
})

describe('exportModelList 集成', () => {
  beforeEach(() => {
    state.search = ''
    state.typeFilter = 'all'
    vi.stubGlobal('window', {
      api: {
        models: {
          exportModelList: vi
            .fn()
            .mockResolvedValue({ ok: true, path: 'list.csv' }),
        },
      },
    })
  })

  it('按当前结果生成内容并调用主进程保存', async () => {
    const { exportModelList } =
      await import('../src/renderer/src/store/model-export')
    replaceModels([model()])
    const ok = await exportModelList('csv')
    expect(ok).toBe(true)
    const payload = window.api.models.exportModelList.mock.calls[0][0]
    expect(payload.format).toBe('csv')
    expect(payload.content.startsWith('\uFEFF')).toBe(true)
  })

  it('空结果不调用 IPC', async () => {
    const { exportModelList } =
      await import('../src/renderer/src/store/model-export')
    replaceModels([])
    const ok = await exportModelList('json')
    expect(ok).toBe(false)
    expect(window.api.models.exportModelList).not.toHaveBeenCalled()
  })
})
