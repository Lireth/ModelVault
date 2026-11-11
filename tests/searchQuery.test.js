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

  it('使用轨迹语法：opened 年龄/never 与 uses 次数（F3）', () => {
    expect(parseSearchQuery('opened:>30d').filters).toEqual([
      {
        kind: 'opened',
        never: false,
        op: '>',
        ms: 30 * 24 * 3600 * 1000,
      },
    ])
    expect(parseSearchQuery('opened:never').filters).toEqual([
      { kind: 'opened', never: true },
    ])
    // 缺省单位 d
    expect(parseSearchQuery('opened:7').filters[0]).toMatchObject({
      kind: 'opened',
      never: false,
      op: '=',
      ms: 7 * 24 * 3600 * 1000,
    })
    expect(parseSearchQuery('uses:>=5').filters).toEqual([
      { kind: 'uses', op: '>=', value: 5 },
    ])
    expect(parseSearchQuery('uses:0').filters).toEqual([
      { kind: 'uses', op: '=', value: 0 },
    ])
    // 非法值整段回退自由文本
    expect(parseSearchQuery('opened:soon').filters).toEqual([])
    expect(parseSearchQuery('uses:x').filters).toEqual([])
  })

  it('整理类语法：cover/note/params/ext/path/dup（F4）', () => {
    expect(parseSearchQuery('cover:no').filters).toEqual([
      { kind: 'cover', value: false },
    ])
    expect(parseSearchQuery('NOTE:yes').filters).toEqual([
      { kind: 'note', value: true },
    ])
    expect(parseSearchQuery('params:1').filters).toEqual([
      { kind: 'params', value: true },
    ])
    expect(parseSearchQuery('ext:.SAFETENSORS').filters).toEqual([
      { kind: 'ext', text: 'safetensors' },
    ])
    expect(parseSearchQuery('path:"D:\\Models\\LoRA"').filters).toEqual([
      { kind: 'path', text: 'd:\\models\\lora' },
    ])
    expect(parseSearchQuery('dup:no').filters).toEqual([
      { kind: 'dup', value: false },
    ])
    // 非法布尔/空扩展名整段回退自由文本
    expect(parseSearchQuery('cover:maybe').filters).toEqual([])
    expect(parseSearchQuery('ext:.').filters).toEqual([])
  })

  it('broken 布尔语法：主前缀与 suspect 别名（FEAT-01）', () => {
    expect(parseSearchQuery('broken:yes').filters).toEqual([
      { kind: 'broken', value: true },
    ])
    expect(parseSearchQuery('SUSPECT:no').filters).toEqual([
      { kind: 'broken', value: false },
    ])
    // 非法值回退自由文本
    expect(parseSearchQuery('broken:maybe').filters).toEqual([])
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
    // 疑似损坏（FEAT-01）：suspect 字段与 broken 语法同语义
    expect(
      matchSearchFilters(
        model({ suspect: true }),
        parseSearchQuery('broken:yes').filters,
      ),
    ).toBe(true)
    expect(
      matchSearchFilters(
        model({ suspect: false }),
        parseSearchQuery('broken:yes').filters,
      ),
    ).toBe(false)
    expect(
      matchSearchFilters(
        model({ suspect: false }),
        parseSearchQuery('broken:no').filters,
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

  it('cover/note/params/ext/path/dup 命中语义（F4）', () => {
    const coverNo = parseSearchQuery('cover:no').filters
    const coverYes = parseSearchQuery('cover:yes').filters
    expect(matchSearchFilters(model({}), coverNo)).toBe(true)
    expect(matchSearchFilters(model({ cover: 'D:/x.png' }), coverNo)).toBe(
      false,
    )
    expect(
      matchSearchFilters(model({ covers: [{ rel: 'covers/x.png' }] }), coverNo),
    ).toBe(false)
    expect(matchSearchFilters(model({ coverUrl: 'mvimg://x' }), coverYes)).toBe(
      true,
    )

    const noteYes = parseSearchQuery('note:yes').filters
    const noteNo = parseSearchQuery('note:no').filters
    expect(matchSearchFilters(model({ note: '备注' }), noteYes)).toBe(true)
    expect(matchSearchFilters(model({ note: '   ' }), noteNo)).toBe(true)
    expect(matchSearchFilters(model({ note: '备注' }), noteNo)).toBe(false)

    const paramsYes = parseSearchQuery('params:yes').filters
    const paramsNo = parseSearchQuery('params:no').filters
    expect(
      matchSearchFilters(model({ params: { sampler: 'euler' } }), paramsYes),
    ).toBe(true)
    expect(
      matchSearchFilters(model({ params: { steps: 20 } }), paramsYes),
    ).toBe(true)
    expect(
      matchSearchFilters(
        model({ params: { steps: null, sampler: '', resMin: null } }),
        paramsNo,
      ),
    ).toBe(true)

    const ext = parseSearchQuery('ext:safetensors').filters
    expect(matchSearchFilters(model({ ext: '.SAFETENSORS' }), ext)).toBe(true)
    expect(
      matchSearchFilters(model({ id: 'D:/x/a.safetensors.disabled' }), ext),
    ).toBe(true)
    expect(matchSearchFilters(model({ id: 'D:/x/a.ckpt' }), ext)).toBe(false)

    const path = parseSearchQuery('path:LoRA').filters
    expect(
      matchSearchFilters(model({ id: 'D:/Models/LoRA/a.safetensors' }), path),
    ).toBe(true)
    expect(
      matchSearchFilters(model({ id: 'D:/Models/VAE/a.safetensors' }), path),
    ).toBe(false)

    const dupYes = parseSearchQuery('dup:yes').filters
    const isDup = (m) => m.id === 'a'
    expect(
      matchSearchFilters(model({ id: 'a' }), dupYes, undefined, null, isDup),
    ).toBe(true)
    expect(
      matchSearchFilters(model({ id: 'b' }), dupYes, undefined, null, isDup),
    ).toBe(false)
    // 未注入重复解析器：dup:yes 恒不命中
    expect(matchSearchFilters(model({ id: 'a' }), dupYes)).toBe(false)
  })

  it('opened/uses 命中语义（F3）：从未打开按无穷大年龄参与比较', () => {
    const DAY = 24 * 3600 * 1000
    const old = parseSearchQuery('opened:>30d').filters
    const recent = parseSearchQuery('opened:<7d').filters
    const never = parseSearchQuery('opened:never').filters
    expect(
      matchSearchFilters(model({ lastOpenedAt: Date.now() - 40 * DAY }), old),
    ).toBe(true)
    expect(
      matchSearchFilters(model({ lastOpenedAt: Date.now() - 1 * DAY }), old),
    ).toBe(false)
    // 从未打开：> / >= 命中（年龄无穷大），< 不命中
    expect(matchSearchFilters(model({ lastOpenedAt: 0 }), old)).toBe(true)
    expect(
      matchSearchFilters(model({ lastOpenedAt: Date.now() - 1 * DAY }), recent),
    ).toBe(true)
    expect(matchSearchFilters(model({ lastOpenedAt: 0 }), recent)).toBe(false)
    expect(matchSearchFilters(model({ lastOpenedAt: 0 }), never)).toBe(true)
    expect(matchSearchFilters(model({ lastOpenedAt: Date.now() }), never)).toBe(
      false,
    )

    const uses = parseSearchQuery('uses:>=3').filters
    expect(matchSearchFilters(model({ openCount: 3 }), uses)).toBe(true)
    expect(matchSearchFilters(model({ openCount: 2 }), uses)).toBe(false)
    expect(matchSearchFilters(model({}), uses)).toBe(false)
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

  it('resolveFlags 注入时 score:/fav:/nsfw: 经覆盖解析器命中（P1-1）', () => {
    // filter.js 传入标注覆盖解析器：即时标注后未重扫的值参与 token 命中；
    // 未注入（默认 null）时回退模型自带字段（纯函数测试路径不受影响）
    const resolvers = {
      favorite: (m) => m.id === 'm1',
      nsfw: (m) => m.id === 'm1',
      rating: (m) => (m.id === 'm1' ? 4 : 0),
    }
    const fav = parseSearchQuery('fav:yes').filters
    const score = parseSearchQuery('score:>=4').filters
    const nsfw = parseSearchQuery('nsfw:yes').filters
    const m1 = model({ id: 'm1', favorite: false, rating: 0, nsfw: false })
    const m2 = model({ id: 'm2', favorite: false, rating: 0, nsfw: false })
    expect(matchSearchFilters(m1, fav, undefined, resolvers)).toBe(true)
    expect(matchSearchFilters(m2, fav, undefined, resolvers)).toBe(false)
    expect(matchSearchFilters(m1, score, undefined, resolvers)).toBe(true)
    expect(matchSearchFilters(m2, score, undefined, resolvers)).toBe(false)
    expect(matchSearchFilters(m1, nsfw, undefined, resolvers)).toBe(true)
    // 未注入解析器：回退模型自带字段（对象值仍为未标注态）
    expect(matchSearchFilters(m1, fav)).toBe(false)
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

  it('整理类 token 与重复组解析器接线（F4）', () => {
    replaceModels([
      model({
        id: 'd1',
        name: 'a.safetensors',
        hash: 'h'.repeat(64),
        cover: 'D:/covers/a.png',
      }),
      model({ id: 'd2', name: 'b.safetensors', hash: 'h'.repeat(64) }),
      model({ id: 'd3', name: 'c.safetensors', hash: '' }),
    ])
    const ids = () => filteredModels.value.map((m) => m.id).sort()
    state.search = 'dup:yes'
    expect(ids()).toEqual(['d1', 'd2'])
    state.search = 'dup:no'
    expect(ids()).toEqual(['d3'])
    // 多条件 AND：无封面 + 无备注 + 无推荐参数
    state.search = 'cover:no note:no params:no'
    expect(ids()).toEqual(['d2', 'd3'])
    state.search = ''
  })

  it('无语法时行为与既有子串搜索一致（回归锚点）', () => {
    state.search = 'ILLUSTRIOUS'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['b'])
  })
})
