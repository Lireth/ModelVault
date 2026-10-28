import { describe, it, expect } from 'vitest'
import {
  SEARCH_SYNTAX,
  applySearchSuggestion,
  caretAfterSuggestion,
  suggestSearchSyntax,
} from '../src/renderer/src/store/search-syntax'
import { parseSearchQuery } from '../src/renderer/src/store/search-query'

/**
 * 结构化搜索语法目录与输入辅助（FEAT-1）：
 * - 目录与 search-query.js 解析器双向对账：每个示例都能解析为结构化条件，
 *   前缀集合一一对应（任一侧漏改即测试失败）；
 * - 前缀/值两级补全建议的区间计算、过滤与边界（freeform 值不提示、
 *   空白词边界不提示、未知前缀不提示）；
 * - 补全应用的文本替换与光标落点。
 */

describe('SEARCH_SYNTAX 目录与 search-query 对账', () => {
  it('每个示例都能被 parseSearchQuery 解析为一条结构化条件', () => {
    for (const s of SEARCH_SYNTAX) {
      const parsed = parseSearchQuery(s.example)
      expect(parsed.filters, s.example).toHaveLength(1)
      expect(parsed.text, s.example).toBe('')
    }
  })

  it('操作符集合与解析器支持的前缀一一对应', () => {
    expect(SEARCH_SYNTAX.map((s) => s.prefix)).toEqual([
      'base',
      'tag',
      'type',
      'size',
      'score',
      'fav',
      'nsfw',
      'mtime',
      'author',
      'trigger',
      'hash',
    ])
  })
})

describe('suggestSearchSyntax 前缀建议', () => {
  it('输入操作符前缀时给出补全，替换区间覆盖已输入前缀', () => {
    const s = suggestSearchSyntax('ba', 2)
    expect(s).not.toBeNull()
    expect(s.start).toBe(0)
    expect(s.end).toBe(2)
    expect(s.items.map((i) => i.insert)).toEqual(['base:'])
  })

  it('中间词输入（前面有空格）只替换当前词', () => {
    const s = suggestSearchSyntax('pony b', 6)
    expect(s.start).toBe(5)
    expect(s.end).toBe(6)
    expect(s.items[0].insert).toBe('base:')
  })

  it('光标位于冒号前时替换区间只覆盖前缀部分', () => {
    const s = suggestSearchSyntax('ba:xxx', 1)
    expect(s.start).toBe(0)
    expect(s.end).toBe(2)
  })

  it('未知前缀 / 自由词 / 空白词边界不提示', () => {
    expect(suggestSearchSyntax('hello', 5)).toBeNull()
    expect(suggestSearchSyntax('c:', 2)).toBeNull()
    expect(suggestSearchSyntax('pony ', 5)).toBeNull()
    expect(suggestSearchSyntax('', 0)).toBeNull()
  })

  it('光标缺省取文本末尾', () => {
    const s = suggestSearchSyntax('si')
    expect(s.items[0].insert).toBe('size:')
  })
})

describe('suggestSearchSyntax 值建议', () => {
  it('type: 冒号后给出全部分类值（带空格结尾的插入文本）', () => {
    const s = suggestSearchSyntax('type:', 5)
    expect(s.start).toBe(5)
    expect(s.end).toBe(5)
    expect(s.items.length).toBeGreaterThan(1)
    expect(s.items.every((i) => i.insert.endsWith(' '))).toBe(true)
  })

  it('值前缀过滤：type:lo → lora', () => {
    const s = suggestSearchSyntax('type:lo', 7)
    expect(s.items.map((i) => i.insert.trim())).toEqual(['lora'])
  })

  it('fav: 给出 yes/no', () => {
    const s = suggestSearchSyntax('fav:', 4)
    expect(s.items.map((i) => i.insert.trim())).toEqual(['yes', 'no'])
  })

  it('base: 给出家族值建议', () => {
    const s = suggestSearchSyntax('base:', 5)
    expect(s.items.length).toBeGreaterThan(0)
  })

  it('freeform 值位置不提示（tag/size 等）', () => {
    expect(suggestSearchSyntax('tag:', 4)).toBeNull()
    expect(suggestSearchSyntax('size:', 5)).toBeNull()
    expect(suggestSearchSyntax('hash:', 5)).toBeNull()
  })
})

describe('applySearchSuggestion 补全应用', () => {
  it('前缀补全替换区间并返回光标落点', () => {
    const s = suggestSearchSyntax('ba', 2)
    expect(applySearchSuggestion('ba', s, s.items[0])).toBe('base:')
    expect(caretAfterSuggestion(s, s.items[0])).toBe(5)
  })

  it('值补全保留冒号前内容并追加空格', () => {
    const s = suggestSearchSyntax('type:lo', 7)
    expect(applySearchSuggestion('type:lo', s, s.items[0])).toBe('type:lora ')
  })

  it('中间词补全不影响其它 token', () => {
    const s = suggestSearchSyntax('pony b', 6)
    expect(applySearchSuggestion('pony b', s, s.items[0])).toBe('pony base:')
  })
})
