import { describe, it, expect, beforeEach } from 'vitest'
import {
  activeDynamicViewKey,
  applyDynamicView,
  dynamicViews,
  filteredModels,
  replaceModels,
  state
} from '../src/renderer/src/store/appStore'

/**
 * 内置动态智能视图（FN-07）：
 * 规则计数随模型实时求值；应用时复位窄化筛选并可再次点击取消。
 */

const DAY = 24 * 3600 * 1000

function model(id, overrides = {}) {
  return {
    id,
    name: id,
    type: 'lora',
    size: 1,
    mtimeMs: Date.now() - DAY,
    rating: 0,
    favorite: false,
    nsfw: false,
    tags: [],
    triggerWords: '',
    note: '',
    baseModel: '',
    ...overrides
  }
}

beforeEach(() => {
  state.search = ''
  state.typeFilter = 'all'
  state.subFilter = ''
  state.baseFilter = ''
  state.tagFilter = ''
  state.showFavoritesOnly = false
  state.showDuplicatesOnly = false
  replaceModels([
    model('unrated-recent', { rating: 0, mtimeMs: Date.now() - DAY }),
    model('rated-old', { rating: 3, mtimeMs: Date.now() - 40 * DAY }),
    model('unrated-old', { rating: 0, mtimeMs: Date.now() - 40 * DAY }),
    model('no-mtime', { rating: 5, mtimeMs: 0 })
  ])
})

describe('dynamicViews 计数', () => {
  it('未评分 / 近 30 天 / 30 天未更新按规则实时统计', () => {
    const byKey = Object.fromEntries(dynamicViews.value.map((v) => [v.key, v.count]))
    expect(byKey.unrated).toBe(2)
    expect(byKey.recent).toBe(1)
    expect(byKey.stale).toBe(2)
    // 三条规则均存在且带搜索语法
    expect(dynamicViews.value.map((v) => v.search)).toEqual([
      'score:0',
      'mtime:<30d',
      'mtime:>30d'
    ])
  })
})

describe('applyDynamicView', () => {
  it('应用规则、复位其他筛选并高亮；再次点击取消', () => {
    state.typeFilter = 'lora'
    state.showFavoritesOnly = true
    applyDynamicView('unrated')
    expect(state.search).toBe('score:0')
    expect(state.typeFilter).toBe('all')
    expect(state.showFavoritesOnly).toBe(false)
    expect(activeDynamicViewKey.value).toBe('unrated')
    // 结果与规则一致（按名称排序）
    expect(filteredModels.value.map((m) => m.id).sort()).toEqual(['unrated-old', 'unrated-recent'])

    applyDynamicView('unrated')
    expect(state.search).toBe('')
    expect(activeDynamicViewKey.value).toBe('')
  })

  it('其他筛选存在时不算命中动态视图', () => {
    applyDynamicView('recent')
    expect(activeDynamicViewKey.value).toBe('recent')
    state.tagFilter = '风格'
    expect(activeDynamicViewKey.value).toBe('')
  })
})
