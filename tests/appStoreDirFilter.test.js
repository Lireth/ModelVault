import { describe, it, expect, beforeEach } from 'vitest'
import { filteredModels, resetViews, state, typeCounts } from '../src/renderer/src/store/appStore'

/**
 * B-01 目录筛选派生测试：
 * 选中目录含其全部后代；分类计数随目录子树同口径限定；目录筛选与分类/收藏叠加。
 */

function model(id, type, relDir, { favorite = false, size = 100, mtimeMs = 0 } = {}) {
  return { id, name: id, type, relDir, favorite, size, mtimeMs }
}

beforeEach(() => {
  resetViews()
  state.models = []
  state.dirFilter = ''
  state.typeFilter = 'all'
  state.subFilter = ''
  state.showFavoritesOnly = false
  state.search = ''
  state.sortBy = 'name'
  state.sortAsc = true
})

describe('filteredModels 目录筛选', () => {
  beforeEach(() => {
    state.models = [
      model('D:\\m\\root.safetensors', 'checkpoint', ''),
      model('D:\\m\\lora\\a.safetensors', 'lora', 'lora'),
      model('D:\\m\\lora\\role\\b.safetensors', 'lora', 'lora/role'),
      model('D:\\m\\lora\\role\\c.safetensors', 'lora', 'lora/role'),
      model('D:\\m\\vae\\v.safetensors', 'vae', 'vae')
    ]
  })

  it('无目录筛选时返回全部', () => {
    expect(filteredModels.value).toHaveLength(5)
  })

  it('选中目录包含其直属与全部后代模型，排除其他目录', () => {
    state.dirFilter = 'lora'
    expect(filteredModels.value.map((m) => m.id).sort()).toEqual(
      [
        'D:\\m\\lora\\a.safetensors',
        'D:\\m\\lora\\role\\b.safetensors',
        'D:\\m\\lora\\role\\c.safetensors'
      ].sort()
    )
  })

  it('深层目录只含自身子树', () => {
    state.dirFilter = 'lora/role'
    expect(filteredModels.value).toHaveLength(2)
  })

  it('目录筛选与分类、收藏条件叠加', () => {
    state.dirFilter = 'lora'
    state.typeFilter = 'lora'
    expect(filteredModels.value).toHaveLength(3)
    state.showFavoritesOnly = true
    expect(filteredModels.value).toHaveLength(0)
  })

  it('前缀近似但非子目录的模型不被误纳入（lora2 不算 lora 后代）', () => {
    state.models.push(model('D:\\m\\lora2\\x.safetensors', 'lora', 'lora2'))
    state.dirFilter = 'lora'
    expect(filteredModels.value.some((m) => m.relDir === 'lora2')).toBe(false)
  })
})

describe('typeCounts 目录同口径', () => {
  beforeEach(() => {
    state.models = [
      model('D:\\m\\root.safetensors', 'checkpoint', ''),
      model('D:\\m\\lora\\a.safetensors', 'lora', 'lora'),
      model('D:\\m\\lora\\b.safetensors', 'lora', 'lora/role'),
      model('D:\\m\\vae\\v.safetensors', 'vae', 'vae')
    ]
  })

  it('无目录筛选时统计全库', () => {
    expect(typeCounts.value.all).toBe(4)
    expect(typeCounts.value.lora).toBe(2)
  })

  it('目录筛选后计数限定在子树内（侧栏计数与网格同口径）', () => {
    state.dirFilter = 'lora'
    expect(typeCounts.value.all).toBe(2)
    expect(typeCounts.value.lora).toBe(2)
    expect(typeCounts.value.checkpoint).toBeUndefined()
  })
})
