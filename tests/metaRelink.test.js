import { describe, it, expect } from 'vitest'
import { isEmptyModelMeta, planMetaRelinks, splitRelKey } from '../src/main/services/meta-relink'

/**
 * 元数据重关联规划器单元测试（A-02）：
 * 库内移动/重命名模型后，相对路径键失效导致标注失联。规划器仅依据
 * 「旧键结构（目录/文件名/扩展名）+ 哈希履历 mtime」与「本次扫描的新模型」
 * 做确定性配对，任何歧义（多个候选）都放弃自动关联，交给保守保留策略。
 *
 * 分层（按强度依次，每层只取唯一匹配）：
 * - R1 移动不改名：同名同扩展名且全局唯一；
 * - R2 同目录改名：同目录内孤儿与新模型恰好一一对应；
 * - R3 哈希履历：新文件 mtime 与该模型曾计算哈希时的 mtimeMs 精确一致且唯一
 *   （覆盖移动并改名、解压工具保留时间戳等场景）。
 */

/** 构造孤儿条目（旧键 + 元数据中的哈希履历） */
function orphan(key, overrides = {}) {
  return { ...splitRelKey(key), key, hash: '', hashMtime: 0, ...overrides }
}

/** 构造新扫描到的模型条目 */
function newcomer(key, overrides = {}) {
  return {
    size: 1024,
    mtimeMs: 1000,
    ...splitRelKey(key),
    key,
    ...overrides
  }
}

/** 以映射形式快速断言重关联结果 */
function relinkMap(result) {
  return Object.fromEntries(result.relinks)
}

describe('splitRelKey（相对键解析）', () => {
  it('解析目录段/文件名/扩展名（扩展名小写）', () => {
    expect(splitRelKey('lora/style/a.safetensors')).toEqual({
      dir: 'lora/style',
      name: 'a',
      ext: '.safetensors'
    })
  })

  it('根目录文件 dir 为空串；无扩展名时 ext 为空串', () => {
    expect(splitRelKey('a')).toEqual({ dir: '', name: 'a', ext: '' })
  })
})

describe('planMetaRelinks R1：移动不改名', () => {
  it('同名同扩展名且唯一时关联（无论目录如何变化）', () => {
    const result = planMetaRelinks(
      [orphan('old/sub/a.safetensors')],
      [newcomer('new/place/a.safetensors')]
    )
    expect(relinkMap(result)).toEqual({
      'old/sub/a.safetensors': 'new/place/a.safetensors'
    })
    expect(result.unmatchedOrphanKeys).toEqual([])
  })

  it('扩展名不同不关联（同名的 .ckpt 与 .safetensors 不是同一文件）', () => {
    const result = planMetaRelinks(
      [orphan('a.ckpt')],
      [newcomer('a.safetensors')]
    )
    expect(result.relinks).toEqual([])
    expect(result.unmatchedOrphanKeys).toEqual(['a.ckpt'])
  })

  it('同名候选存在多个（歧义）时放弃，宁可不关联也不绑错', () => {
    const result = planMetaRelinks(
      [orphan('old/a.safetensors')],
      [newcomer('new1/a.safetensors'), newcomer('new2/a.safetensors')]
    )
    expect(result.relinks).toEqual([])
    expect(result.unmatchedOrphanKeys).toEqual(['old/a.safetensors'])
  })

  it('两个同名孤儿争夺唯一新候选时双方都不关联', () => {
    const result = planMetaRelinks(
      [orphan('d1/a.safetensors'), orphan('d2/a.safetensors')],
      [newcomer('d3/a.safetensors')]
    )
    expect(result.relinks).toEqual([])
    expect(result.unmatchedOrphanKeys).toHaveLength(2)
  })
})

describe('planMetaRelinks R2：同目录改名（1:1）', () => {
  it('同目录内恰有 1 个孤儿与 1 个新模型（名字不同）时关联', () => {
    const result = planMetaRelinks(
      [orphan('lora/old-name.safetensors')],
      [newcomer('lora/new-name.safetensors')]
    )
    expect(relinkMap(result)).toEqual({
      'lora/old-name.safetensors': 'lora/new-name.safetensors'
    })
  })

  it('同目录批量改动（多孤儿多新模型）无法一一对应，全部保留不关联', () => {
    const result = planMetaRelinks(
      [orphan('d/a.safetensors'), orphan('d/b.safetensors')],
      [newcomer('d/a2.safetensors'), newcomer('d/b2.safetensors')]
    )
    expect(result.relinks).toEqual([])
    expect(result.unmatchedOrphanKeys).toHaveLength(2)
  })
})

describe('planMetaRelinks R3：哈希履历 mtime', () => {
  it('移动并改名后，新文件 mtime 与哈希履历精确一致且唯一时关联', () => {
    const result = planMetaRelinks(
      [orphan('lora/a.safetensors', { hash: 'h'.repeat(64), hashMtime: 1700000000000 })],
      [newcomer('lora/renamed.safetensors', { mtimeMs: 1700000000000 })]
    )
    expect(relinkMap(result)).toEqual({
      'lora/a.safetensors': 'lora/renamed.safetensors'
    })
  })

  it('mtime 命中但有多个同 mtime 候选（歧义）时不关联', () => {
    const result = planMetaRelinks(
      [orphan('a.safetensors', { hash: 'h'.repeat(64), hashMtime: 1700000000000 })],
      [
        newcomer('x.safetensors', { mtimeMs: 1700000000000 }),
        newcomer('y.safetensors', { mtimeMs: 1700000000000 })
      ]
    )
    expect(result.relinks).toEqual([])
    expect(result.unmatchedOrphanKeys).toEqual(['a.safetensors'])
  })

  it('无哈希履历（hashMtime=0）的孤儿不进入 R3（不同目录、不同名时三层皆不命中）', () => {
    const result = planMetaRelinks(
      [orphan('dir-a/a.safetensors')],
      [newcomer('dir-b/b.safetensors', { mtimeMs: 0 })]
    )
    expect(result.relinks).toEqual([])
    expect(result.unmatchedOrphanKeys).toEqual(['dir-a/a.safetensors'])
  })
})

describe('planMetaRelinks 分层协作', () => {
  it('R1 先消费明确的同名匹配，剩余目录内 1:1 改名由 R2 关联', () => {
    const result = planMetaRelinks(
      [
        orphan('old/moved.safetensors'),
        orphan('keep-dir/renamed-old.safetensors')
      ],
      [
        newcomer('new/moved.safetensors'),
        newcomer('keep-dir/renamed-new.safetensors')
      ]
    )
    expect(relinkMap(result)).toEqual({
      'old/moved.safetensors': 'new/moved.safetensors',
      'keep-dir/renamed-old.safetensors': 'keep-dir/renamed-new.safetensors'
    })
    expect(result.unmatchedOrphanKeys).toEqual([])
  })

  it('空入参返回空结果', () => {
    expect(planMetaRelinks([], [])).toEqual({ relinks: [], unmatchedOrphanKeys: [] })
  })

  it('一个新模型不会被两个孤儿先后重复占用', () => {
    // R1：o1 与 n1 同名先绑定；R3 中 o2 的 mtime 虽也命中 n1，但 n1 已被占用，
    // 且无其他候选，o2 留在未匹配
    const result = planMetaRelinks(
      [
        orphan('dir-a/same.safetensors'),
        orphan('dir-b/other.safetensors', { hash: 'h'.repeat(64), hashMtime: 5000 })
      ],
      [newcomer('dir-c/same.safetensors', { mtimeMs: 5000 })]
    )
    expect(result.relinks).toEqual([['dir-a/same.safetensors', 'dir-c/same.safetensors']])
    expect(result.unmatchedOrphanKeys).toEqual(['dir-b/other.safetensors'])
  })
})

describe('isEmptyModelMeta（失效空条目判定）', () => {
  const empty = () => ({
    cover: '',
    covers: [],
    alias: '',
    note: '',
    subCategory: '',
    triggerWords: '',
    favorite: false,
    nsfw: false,
    rating: 0,
    hash: '',
    noteSource: '',
    triggerWordsSource: '',
    params: {
      steps: null,
      cfgMin: null,
      cfgMax: null,
      sampler: '',
      scheduler: '',
      precision: '',
      resMin: null,
      resMax: null
    }
  })

  it('全字段为空时判定为空条目（可安全清理）', () => {
    expect(isEmptyModelMeta(empty())).toBe(true)
  })

  it.each([
    ['cover', { cover: '.modelvault/covers/x.png' }],
    ['covers', { covers: ['x.png'] }],
    ['alias', { alias: '别名' }],
    ['note', { note: '备注' }],
    ['subCategory', { subCategory: 'role' }],
    ['triggerWords', { triggerWords: 'word' }],
    ['favorite', { favorite: true }],
    ['nsfw', { nsfw: true }],
    ['rating', { rating: 3 }],
    ['hash', { hash: 'a'.repeat(64) }],
    ['noteSource', { noteSource: 'sidecar' }],
    ['params.steps', { params: { steps: 20 } }],
    ['params.sampler', { params: { sampler: 'euler' } }]
  ])('%s 有值时不视为空条目（必须保留）', (_key, overrides) => {
    const meta = empty()
    if (overrides.params) meta.params = { ...meta.params, ...overrides.params }
    Object.assign(meta, overrides)
    expect(isEmptyModelMeta(meta)).toBe(false)
  })

  it('null/非法入参安全返回 true（调用方据此可清理）', () => {
    expect(isEmptyModelMeta(null)).toBe(true)
    expect(isEmptyModelMeta(undefined)).toBe(true)
  })
})
