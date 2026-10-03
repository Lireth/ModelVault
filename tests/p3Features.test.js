import { describe, it, expect, vi } from 'vitest'
import { fakeUserData } from './setup'

/**
 * P3 新功能纯函数特征测试：
 * - buildModelsCsv（E2 列表导出）：列顺序、CSV 转义、BOM
 * - compareVersions（E1 更新检查）：数字段比较
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true },
  net: { fetch: vi.fn() }
}))

import { buildModelsCsv } from '../src/main/ipc/models/misc'
import { compareVersions } from '../src/main/services/updater'

describe('buildModelsCsv（E2 导出）', () => {
  it('包含 BOM、表头与数据行；参数区间拼接为单列', () => {
    const csv = buildModelsCsv([
      {
        id: 'D:/m/a.safetensors',
        name: 'a.safetensors',
        alias: '模型A',
        type: 'lora',
        subCategory: 'style',
        favorite: true,
        nsfw: false,
        rating: 4,
        triggerWords: 't1, t2',
        note: '备注',
        size: 1234,
        mtimeMs: Date.UTC(2026, 0, 2, 3, 4, 5),
        params: { steps: 28, cfgMin: 4, cfgMax: 12, sampler: 'euler', resMin: 512, resMax: 1024 }
      }
    ])
    expect(csv.startsWith('\uFEFF')).toBe(true)
    const lines = csv.replace(/^\uFEFF/, '').trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('名称,备注名,分类')
    expect(lines[0]).toContain('文件路径')
    // 收藏为「是」，评分 4，CFG 区间与分辨率区间拼接
    expect(lines[1]).toContain(',是,4,')
    expect(lines[1]).toContain('4~12')
    expect(lines[1]).toContain('512x1024')
    expect(lines[1]).toContain('a.safetensors')
  })

  it('含逗号/引号/换行的字段被引号包裹且内部引号翻倍', () => {
    const csv = buildModelsCsv([
      { id: 'x', name: 'a', note: '含,逗号"和"换行\n符' }
    ])
    expect(csv).toContain('"含,逗号""和""换行\n符"')
  })

  it('缺省字段输出为空（params 为 null 时不抛错）', () => {
    const csv = buildModelsCsv([{ id: 'x', name: 'b', type: 'other', params: null }])
    const lines = csv.replace(/^\uFEFF/, '').trimEnd().split('\n')
    expect(lines[1]).toBe('b,,other,,,,,,,,,,,,,,,x')
  })
})

describe('compareVersions（E1 更新检查）', () => {
  it('逐段数字比较，支持不等长版本号', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1)
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('0.1.0', '0.2.0')).toBe(-1)
    expect(compareVersions('1.0', '0.9.9')).toBe(1)
    expect(compareVersions('0.1', '0.1.1')).toBe(-1)
  })

  it('非数字段按 0 处理（beta 后缀场景回退安全）', () => {
    expect(compareVersions('0.1.0', '0.1.0-beta')).toBe(0)
  })
})
