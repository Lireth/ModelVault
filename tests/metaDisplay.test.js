import { describe, it, expect } from 'vitest'
import { metaDisplayFields } from '../src/main/ipc/models/meta-display'

/**
 * metaDisplayFields 单元测试（OPT-06 单一来源）：
 * 「meta → 展示字段」合成此前在 decorate 装饰路径与 store 索引覆盖路径
 * 各自手写且已漂移（索引路径漏 baseModel/civitaiUrl）；收敛为纯函数后
 * 用本文件锁定字段映射、subCategory 合成优先级与 baseModel/hash 兜底链。
 */

describe('metaDisplayFields（meta → 展示字段单一来源，OPT-06）', () => {
  it('meta 值逐字段映射（标量/对象/数组）', () => {
    const fields = metaDisplayFields(
      { type: 'lora' },
      {
        alias: '别名',
        note: '备注',
        noteSource: 'sidecar',
        favorite: true,
        nsfw: false,
        rating: 4,
        params: { steps: 20 },
        tags: ['a', 'b'],
        triggerWords: 'tw',
        triggerWordsSource: 'civitai',
        hash: 'h'.repeat(64),
        civitaiUrl: 'https://civitai.com/models/9',
      },
    )
    expect(fields).toMatchObject({
      alias: '别名',
      note: '备注',
      noteSource: 'sidecar',
      favorite: true,
      nsfw: false,
      rating: 4,
      params: { steps: 20 },
      tags: ['a', 'b'],
      triggerWords: 'tw',
      triggerWordsSource: 'civitai',
      hash: 'h'.repeat(64),
      civitaiUrl: 'https://civitai.com/models/9',
    })
  })

  it('meta 为空时全量安全默认值（不可信输入容错）', () => {
    const fields = metaDisplayFields({ type: 'other' }, null)
    expect(fields).toMatchObject({
      alias: '',
      note: '',
      noteSource: '',
      favorite: false,
      nsfw: false,
      rating: 0,
      params: null,
      tags: [],
      triggerWords: '',
      triggerWordsSource: '',
      subCategory: '',
      hash: '',
      civitaiUrl: '',
      baseModel: '',
    })
  })

  it('subCategory 优先级：lora 文件夹标签 > meta 值 > checkpoint 基底', () => {
    expect(
      metaDisplayFields(
        { type: 'lora', folderSubCategory: 'role' },
        { subCategory: 'style' },
      ).subCategory,
    ).toBe('role')
    expect(
      metaDisplayFields({ type: 'lora' }, { subCategory: 'style' }).subCategory,
    ).toBe('style')
    expect(metaDisplayFields({ type: 'checkpoint' }, {}).subCategory).toBe(
      'base',
    )
    // folderSubCategory 仅对 lora 生效：checkpoint 携带时忽略
    expect(
      metaDisplayFields({ type: 'checkpoint', folderSubCategory: 'role' }, {})
        .subCategory,
    ).toBe('base')
    expect(metaDisplayFields({ type: 'other' }, {}).subCategory).toBe('')
  })

  it('baseModel 优先级：覆盖值（autoInfo/索引快照代理）> meta 回填 > 模型兜底', () => {
    const model = { type: 'lora' }
    expect(
      metaDisplayFields(model, { baseModel: 'Pony' }, { baseModel: 'Flux.1' })
        .baseModel,
    ).toBe('Flux.1')
    expect(metaDisplayFields(model, { baseModel: 'Pony' }, {}).baseModel).toBe(
      'Pony',
    )
    expect(metaDisplayFields(model, {}, {}).baseModel).toBe('')
    expect(
      metaDisplayFields({ type: 'lora', baseModel: 'Snap' }, {}, {}).baseModel,
    ).toBe('Snap')
  })

  it('hash：meta 优先，模型条目（索引快照）兜底', () => {
    expect(
      metaDisplayFields({ type: 'lora', hash: 'snap' }, { hash: 'meta' }).hash,
    ).toBe('meta')
    expect(metaDisplayFields({ type: 'lora', hash: 'snap' }, {}).hash).toBe(
      'snap',
    )
  })
})
