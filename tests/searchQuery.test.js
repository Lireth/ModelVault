import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseSearchQuery,
  matchSearchFilters,
} from '../src/renderer/src/store/search-query'
import {
  filteredModels,
  replaceModels,
  state,
} from '../src/renderer/src/store/appStore'

/**
 * 高级搜索语法（F3）：
 * - 解析器：token 拆分、引号值、未知前缀/不合法值回退自由文本、空值容错
 * - 匹配器：base 家族/子串双语义、tag 包含、type、size 运算与单位、
 *   score 运算、fav/nsfw 布尔、多条件 AND
 * - 集成：filteredModels 与自由关键词、侧栏筛选叠加（AND 语义）
 */

/** 最小模型对象（未给出的字段按需覆盖） */
function model(overrides = {}) {
  return {
    id: 'm',
    name: 'model.safetensors',
    type: 'lora',
    baseModel: '',
    size: 0,
    rating: 0,
    favorite: false,
    nsfw: false,
    tags: [],
    ...overrides,
  }
}

describe('parseSearchQuery 解析器', () => {
  it('纯自由文本：原样保留（合并空白），无结构化条件', () => {
    const { text, filters } = parseSearchQuery('  赛博朋克   风格  ')
    expect(text).toBe('赛博朋克 风格')
    expect(filters).toEqual([])
  })

  it('结构化 token 拆分：前缀大小写不敏感，值去引号，剩余文本保留', () => {
    const { text, filters } = parseSearchQuery(
      'pony BASE:Pony tag:"我的 标签" cute',
    )
    expect(filters).toEqual([
      { kind: 'base', family: 'pony', text: 'pony' },
      { kind: 'tag', text: '我的 标签' },
    ])
    expect(text).toBe('pony cute')
  })

  it('未知前缀与不合法值整段回退自由文本（Windows 路径容错）', () => {
    const { text, filters } = parseSearchQuery(
      'c:\\models\\x size:abc note: hi',
    )
    expect(filters).toEqual([])
    expect(text).toBe('c:\\models\\x size:abc note: hi')
  })

  it('size/score 解析：运算符与单位，裸值语义（size 精确 / score 精确）', () => {
    expect(parseSearchQuery('size:>1.5gb').filters).toEqual([
      { kind: 'size', op: '>', bytes: 1.5 * 1024 ** 3 },
    ])
    expect(parseSearchQuery('size:<=500mb').filters).toEqual([
      { kind: 'size', op: '<=', bytes: 500 * 1024 ** 2 },
    ])
    // 缺省单位 mb；缺省运算符为精确
    expect(parseSearchQuery('size:20').filters).toEqual([
      { kind: 'size', op: '=', bytes: 20 * 1024 ** 2 },
    ])
    expect(parseSearchQuery('score:>=4').filters).toEqual([
      { kind: 'score', op: '>=', value: 4 },
    ])
    expect(parseSearchQuery('score:5').filters).toEqual([
      { kind: 'score', op: '=', value: 5 },
    ])
  })

  it('OP 扩展：mtime 时间运算、author/trigger/hash 前缀', () => {
    expect(parseSearchQuery('mtime:<7d').filters).toEqual([
      { kind: 'mtime', op: '<', ms: 7 * 24 * 3600 * 1000 },
    ])
    // 缺省单位 d；支持 h/w/y
    expect(parseSearchQuery('mtime:>30').filters[0]).toMatchObject({
      kind: 'mtime',
      op: '>',
      ms: 30 * 24 * 3600 * 1000,
    })
    expect(parseSearchQuery('mtime:<=12h').filters[0]).toMatchObject({
      op: '<=',
      ms: 12 * 3600 * 1000,
    })
    expect(parseSearchQuery('author:Alice').filters).toEqual([
      { kind: 'author', text: 'alice' },
    ])
    expect(parseSearchQuery('trigger:neon').filters).toEqual([
      { kind: 'trigger', text: 'neon' },
    ])
    expect(parseSearchQuery('hash:ABCD1234').filters).toEqual([
      { kind: 'hash', text: 'abcd1234' },
    ])
    // 非法值整段回退自由文本
    expect(parseSearchQuery('mtime:soon').filters).toEqual([])
    expect(parseSearchQuery('hash:xyz').filters).toEqual([])
  })

  it('空输入返回空', () => {
    expect(parseSearchQuery('')).toEqual({ text: '', filters: [] })
    expect(parseSearchQuery('   ')).toEqual({ text: '', filters: [] })
  })
})

describe('matchSearchFilters 匹配器', () => {
  it('base：可归一化按家族精确命中，不可归一化退化为子串', () => {
    const family = parseSearchQuery('base:pony').filters[0]
    expect(
      matchSearchFilters(model({ baseModel: 'Pony Diffusion V6 XL' }), [
        family,
      ]),
    ).toBe(true)
    expect(
      matchSearchFilters(model({ baseModel: 'Illustrious-XL' }), [family]),
    ).toBe(false)

    const loose = parseSearchQuery('base:noobai-v').filters[0]
    // 'noobai-v' 无法归一化为已知家族 → 子串包含
    expect(
      matchSearchFilters(model({ baseModel: 'NoobAI-Vpred' }), [loose]),
    ).toBe(true)
  })

  it('tag 包含命中（大小写不敏感），type 精确匹配', () => {
    const tag = parseSearchQuery('tag:角色').filters[0]
    expect(
      matchSearchFilters(model({ tags: ['赛博朋克', '角色'] }), [tag]),
    ).toBe(true)
    expect(matchSearchFilters(model({ tags: ['风格'] }), [tag])).toBe(false)

    const type = parseSearchQuery('type:checkpoint').filters[0]
    expect(matchSearchFilters(model({ type: 'checkpoint' }), [type])).toBe(true)
    expect(matchSearchFilters(model({ type: 'lora' }), [type])).toBe(false)
  })

  it('size 运算与缺失值不命中；score/fav/nsfw 布尔语义', () => {
    const big = parseSearchQuery('size:>1gb').filters[0]
    expect(matchSearchFilters(model({ size: 2 * 1024 ** 3 }), [big])).toBe(true)
    expect(matchSearchFilters(model({ size: 1024 ** 3 }), [big])).toBe(false)
    expect(matchSearchFilters(model({}), [big])).toBe(false)

    expect(
      matchSearchFilters(
        model({ rating: 4 }),
        parseSearchQuery('score:>=4').filters,
      ),
    ).toBe(true)
    expect(
      matchSearchFilters(
        model({ rating: 3 }),
        parseSearchQuery('score:>=4').filters,
      ),
    ).toBe(false)
    expect(
      matchSearchFilters(
        model({ favorite: true }),
        parseSearchQuery('fav:yes').filters,
      ),
    ).toBe(true)
    expect(
      matchSearchFilters(
        model({ favorite: true }),
        parseSearchQuery('fav:no').filters,
      ),
    ).toBe(false)
    expect(
      matchSearchFilters(
        model({ nsfw: true }),
        parseSearchQuery('nsfw:1').filters,
      ),
    ).toBe(true)
  })

  it('mtime/author/trigger/hash 命中语义', () => {
    const DAY = 24 * 3600 * 1000
    const old = parseSearchQuery('mtime:>30d').filters
    const recent = parseSearchQuery('mtime:<7d').filters
    expect(
      matchSearchFilters(model({ mtimeMs: Date.now() - 40 * DAY }), old),
    ).toBe(true)
    expect(
      matchSearchFilters(model({ mtimeMs: Date.now() - 1 * DAY }), old),
    ).toBe(false)
    expect(
      matchSearchFilters(model({ mtimeMs: Date.now() - 1 * DAY }), recent),
    ).toBe(true)
    expect(matchSearchFilters(model({}), old)).toBe(false)

    const author = parseSearchQuery('author:alice').filters
    expect(
      matchSearchFilters(model({ autoInfo: { author: 'Alice' } }), author),
    ).toBe(true)
    expect(
      matchSearchFilters(model({ autoInfo: { author: 'Bob' } }), author),
    ).toBe(false)

    const trigger = parseSearchQuery('trigger:neon').filters
    expect(
      matchSearchFilters(model({ triggerWords: 'cyberpunk, NEON' }), trigger),
    ).toBe(true)
    expect(
      matchSearchFilters(
        model({ autoInfo: { triggerCandidates: ['neon lights'] } }),
        trigger,
      ),
    ).toBe(true)
    expect(
      matchSearchFilters(model({ triggerWords: 'portrait' }), trigger),
    ).toBe(false)

    const hash = parseSearchQuery('hash:abcdef12').filters
    expect(
      matchSearchFilters(model({ hash: 'ABCDEF12' + '0'.repeat(56) }), hash),
    ).toBe(true)
    expect(matchSearchFilters(model({ hash: '1234abcd' }), hash)).toBe(false)
  })

  it('多条件 AND', () => {
    const filters = parseSearchQuery('type:lora fav:yes tag:风格').filters
    expect(
      matchSearchFilters(
        model({ type: 'lora', favorite: true, tags: ['风格'] }),
        filters,
      ),
    ).toBe(true)
    expect(
      matchSearchFilters(
        model({ type: 'lora', favorite: false, tags: ['风格'] }),
        filters,
      ),
    ).toBe(false)
  })
})

describe('filteredModels 集成（F3 与自由关键词/侧栏筛选叠加）', () => {
  const models = [
    model({
      id: 'a',
      name: 'pony-char.safetensors',
      type: 'lora',
      baseModel: 'Pony Diffusion V6 XL',
      size: 2 * 1024 ** 3,
      rating: 4,
      favorite: true,
      tags: ['角色'],
    }),
    model({
      id: 'b',
      name: 'illustrious-style.safetensors',
      type: 'lora',
      baseModel: 'Illustrious-XL',
      size: 300 * 1024 ** 2,
      rating: 5,
      favorite: false,
      tags: ['风格'],
    }),
    model({
      id: 'c',
      name: 'big-checkpoint.safetensors',
      type: 'checkpoint',
      baseModel: 'SDXL 1.0',
      size: 7 * 1024 ** 3,
      rating: 0,
      favorite: false,
      tags: [],
    }),
  ]

  beforeEach(() => {
    replaceModels(models.map((m) => ({ ...m })))
    state.typeFilter = 'all'
    state.showFavoritesOnly = false
    state.search = ''
  })

  it('结构化 token 过滤：base + size 组合', () => {
    state.search = 'base:pony size:>1gb'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['a'])
  })

  it('token 与自由关键词 AND（token 打断后的文本各自连续匹配）', () => {
    state.search = 'tag:风格 checkpoint'
    // b：tag 命中但自由词 checkpoint 不在其搜索域 → 排除；c：tag 未命中
    expect(filteredModels.value.map((m) => m.id)).toEqual([])
    state.search = 'tag:风格 illustrious'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['b'])
  })

  it('token 与侧栏筛选叠加（AND）；清空搜索恢复全量', () => {
    const ids = () => filteredModels.value.map((m) => m.id).sort()
    state.typeFilter = 'lora'
    state.search = 'score:>=4'
    expect(ids()).toEqual(['a', 'b'])
    state.search = 'fav:yes'
    expect(ids()).toEqual(['a'])
    state.search = ''
    expect(ids()).toEqual(['a', 'b'])
  })

  it('无语法时行为与既有子串搜索一致（回归锚点）', () => {
    state.search = 'ILLUSTRIOUS'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['b'])
  })
})
