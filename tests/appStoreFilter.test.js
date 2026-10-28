import { describe, it, expect, beforeEach } from 'vitest'
import { effectiveModelHash } from '../src/renderer/src/store/state'
import {
  makeApiMock,
  resetStoreTestState,
  makeModel,
} from './helpers/storeTest'
import {
  allFilteredSelected,
  applyHashUpdate,
  duplicateGroups,
  duplicateIdSet,
  duplicateWastedBytes,
  allTags,
  filteredModels,
  formatSize,
  multiSelectIdSet,
  replaceModels,
  selectedModel,
  sortDirectional,
  state,
  typeCounts,
} from '../src/renderer/src/store/appStore'

/**
 * appStoreFilter.test.js（ENG-1 自 appStore.test.js 按域拆分，用例内容保持原样）
 */

let api

beforeEach(() => {
  api = makeApiMock()
  resetStoreTestState(api)
})

describe('formatSize', () => {
  it('按区间选单位；非法输入返回 -', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(2048)).toBe('2.0 KB')
    expect(formatSize(1024 * 1024 * 3.5)).toBe('3.5 MB')
    expect(formatSize(-1)).toBe('-')
    expect(formatSize(Number.NaN)).toBe('-')
  })
})

describe('筛选与排序（filteredModels）', () => {
  beforeEach(() => {
    state.models = [
      makeModel('a', {
        name: '动漫风格',
        type: 'lora',
        favorite: true,
        rating: 4,
        size: 300,
        mtimeMs: 30,
      }),
      makeModel('b', {
        name: '写实大模型',
        type: 'checkpoint',
        rating: 5,
        size: 900,
        mtimeMs: 10,
      }),
      makeModel('c', {
        name: 'quick-fix',
        type: 'vae',
        size: 600,
        mtimeMs: 20,
        alias: '快速修复',
      }),
    ]
  })

  it('按分类筛选；LoRA 子分类仅在选中 LoRA 时生效', () => {
    state.typeFilter = 'lora'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['a'])
    state.typeFilter = 'all'
    expect(filteredModels.value).toHaveLength(3)
  })

  it('搜索覆盖名称/备注名/备注/触发词/分类中文标签', () => {
    state.search = '写实'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['b'])
    state.search = '快速'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['c'])
  })

  it('搜索命中分类标签中文标签（放大模型）', () => {
    state.models = [makeModel('u', { type: 'other', subCategory: 'upscale' })]
    state.search = '放大'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['u'])
  })

  it('搜索域缓存随模型对象替换失效（O3）：新备注可命中、旧备注不再命中', () => {
    state.models = [makeModel('m1', { note: '旧备注内容' })]
    state.search = '旧备注'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['m1'])
    // 模拟标注保存路径：整体替换元素对象（note 变更）
    state.models = [makeModel('m1', { note: '新备注内容' })]
    state.search = '旧备注'
    expect(filteredModels.value).toHaveLength(0)
    state.search = '新备注'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['m1'])
  })

  it('搜索域纳入 safetensors 自动解析信息（F2）：作者/基底模型/训练标签可命中', () => {
    state.models = [
      makeModel('lora1', {
        name: '神秘模型',
        autoInfo: {
          baseModel: 'sd_xl_base_1.0',
          author: 'KohyaStyle',
          triggerCandidates: ['masterpiece', 'best quality'],
        },
      }),
      makeModel('lora2', { name: '普通模型', autoInfo: null }),
    ]
    // 按基底模型搜（「那个 SDXL 的 LoRA 在哪」；真实头部值形如 sd_xl_base_1.0，
    // 搜索为子串匹配——搜「sd_xl」或「xl_base」均可命中）
    state.search = 'sd_xl'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['lora1'])
    // 按作者搜
    state.search = 'kohya'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['lora1'])
    // 按训练标签候选搜
    state.search = 'masterpiece'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['lora1'])
    // 无 autoInfo 的模型不受空字段干扰
    state.search = '普通'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['lora2'])
    state.search = ''
  })

  it('自由标签筛选与标签池（F-5/FEAT-01）：单标签命中、多标签 AND、跨类型不清空', () => {
    state.models = [
      makeModel('a', { type: 'lora', tags: ['赛博朋克', '服装'] }),
      makeModel('b', { type: 'checkpoint', tags: ['赛博朋克'] }),
      makeModel('c', { type: 'vae', tags: [] }),
    ]
    // 标签池：按使用次数降序
    expect(allTags.value).toEqual(['赛博朋克', '服装'])
    // 筛选：包含该标签的模型命中（跨类型）
    state.tagFilters = ['赛博朋克']
    expect(filteredModels.value.map((m) => m.id)).toEqual(['a', 'b'])
    state.tagFilters = ['服装']
    expect(filteredModels.value.map((m) => m.id)).toEqual(['a'])
    // 多标签为 AND：同时包含两个标签才命中
    state.tagFilters = ['赛博朋克', '服装']
    expect(filteredModels.value.map((m) => m.id)).toEqual(['a'])
    // 跨类型维度：切主分类不清空（与 subFilter/baseFilter 不同）
    state.typeFilter = 'lora'
    expect(state.tagFilters).toEqual(['赛博朋克', '服装'])
    expect(filteredModels.value.map((m) => m.id)).toEqual(['a'])
    state.typeFilter = 'all'
    state.tagFilters = []
    // 库内无标签时标签池为空
    state.models = [makeModel('x', { tags: [] })]
    expect(allTags.value).toEqual([])
  })

  it('收藏优先排序：收藏在前，组内按名称；固定语义不响应方向翻转（O1）', () => {
    state.models = [
      makeModel('x', { name: 'a', favorite: false }),
      makeModel('y', { name: 'b', favorite: true }),
      makeModel('z', { name: 'c', favorite: true }),
    ]
    state.sortBy = 'favorite'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['y', 'z', 'x'])
    state.sortAsc = false
    expect(filteredModels.value.map((m) => m.id)).toEqual(['y', 'z', 'x'])
  })

  it('按评分排序：高分在前，同分按名称；固定语义不响应方向翻转（O1）', () => {
    state.models = [
      makeModel('a', { name: 'a', rating: 4 }),
      makeModel('b', { name: 'b', rating: 5 }),
      makeModel('c', { name: 'c', rating: 0 }),
    ]
    state.sortBy = 'rating'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['b', 'a', 'c'])
    state.sortAsc = false
    expect(filteredModels.value.map((m) => m.id)).toEqual(['b', 'a', 'c'])
  })

  it('sortDirectional 标记固定语义排序（O1）：favorite/rating 不支持方向切换', () => {
    expect(sortDirectional('name')).toBe(true)
    expect(sortDirectional('type')).toBe(true)
    expect(sortDirectional('size')).toBe(true)
    expect(sortDirectional('mtime')).toBe(true)
    expect(sortDirectional('added')).toBe(true)
    expect(sortDirectional('favorite')).toBe(false)
    expect(sortDirectional('rating')).toBe(false)
  })

  it('按大小/修改时间排序（比较器恒为大/新在前），sortAsc=false 翻转', () => {
    state.sortBy = 'size'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['b', 'c', 'a'])
    state.sortAsc = false
    expect(filteredModels.value.map((m) => m.id)).toEqual(['a', 'c', 'b'])
    state.sortBy = 'mtime'
    state.sortAsc = true
    expect(filteredModels.value.map((m) => m.id)).toEqual(['a', 'c', 'b'])
  })

  it('按添加时间排序（OPT-1）：ctimeMs 新在前，缺失时回退 mtimeMs，sortAsc=false 翻转', () => {
    // c（ctime 最新）> b（无 ctimeMs，回退 mtime 旧值）> a（ctime 最早）
    replaceModels([
      makeModel('a', { ctimeMs: 100 }),
      makeModel('b', { mtimeMs: 300 }),
      makeModel('c', { ctimeMs: 500, mtimeMs: 200 }),
    ])
    state.sortBy = 'added'
    state.sortAsc = true
    expect(filteredModels.value.map((m) => m.id)).toEqual(['c', 'b', 'a'])
    state.sortAsc = false
    expect(filteredModels.value.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('按分类排序遵循固定分类顺序（checkpoint → vae → lora 依 MODEL_TYPES）', () => {
    state.sortBy = 'type'
    expect(filteredModels.value.map((m) => m.id)).toEqual(['b', 'c', 'a'])
  })

  it('typeCounts 从当前模型列表派生', () => {
    expect(typeCounts.value).toEqual({ all: 3, lora: 1, checkpoint: 1, vae: 1 })
  })
})

describe('派生查找优化（O4）', () => {
  it('selectedModel 按 id O(1) 命中，未知 id 返回 null', () => {
    state.models = [makeModel('a'), makeModel('b')]
    state.selectedId = 'b'
    expect(selectedModel.value?.id).toBe('b')
    state.selectedId = 'missing'
    expect(selectedModel.value).toBeNull()
  })

  it('selectedModel 随元素替换同步（元数据更新后读到新引用字段）', () => {
    state.models = [makeModel('a', { alias: '' })]
    state.selectedId = 'a'
    state.models = [makeModel('a', { alias: '备注名' })]
    expect(selectedModel.value?.alias).toBe('备注名')
  })

  it('multiSelectIdSet 随 ids 同步，has 判断 O(1) 语义与 includes 一致', () => {
    state.multiSelect.ids = ['a', 'b']
    expect(multiSelectIdSet.value.has('a')).toBe(true)
    expect(multiSelectIdSet.value.has('c')).toBe(false)
    state.multiSelect.ids = []
    expect(multiSelectIdSet.value.size).toBe(0)
  })

  it('allFilteredSelected 基于选中集合：全选为 true、部分选中为 false', () => {
    state.models = [makeModel('a'), makeModel('b')]
    state.multiSelect.ids = ['a']
    expect(allFilteredSelected.value).toBe(false)
    state.multiSelect.ids = ['a', 'b']
    expect(allFilteredSelected.value).toBe(true)
    // 列表新增未选中项后自动变回 false
    state.models = [makeModel('a'), makeModel('b'), makeModel('c')]
    expect(allFilteredSelected.value).toBe(false)
  })
})

describe('重复模型检测与筛选（FEAT-1）', () => {
  /** 注入两重复组 + 干扰项：A 组（p1/p2 同哈希，p2 评分更高）、B 组（q1/q2 同哈希）、s 独立。
   * 须经 replaceModels 注入（包 shallowReactive）；s 与 A 组同大小，便于回填同哈希后入组 */
  function seedDupes() {
    replaceModels([
      makeModel('p1', {
        hash: 'a'.repeat(64),
        size: 100,
        mtimeMs: 1,
        rating: 0,
      }),
      makeModel('p2', {
        hash: 'a'.repeat(64),
        size: 100,
        mtimeMs: 2,
        rating: 4,
      }),
      makeModel('q1', { hash: 'b'.repeat(64), size: 50, mtimeMs: 1 }),
      makeModel('q2', { hash: 'b'.repeat(64), size: 50, mtimeMs: 2 }),
      makeModel('s', { hash: '', size: 100 }),
    ])
  }

  it('按哈希分组：仅保留成员数大于 1 的组，冗余空间按 (n-1)×大小 计', () => {
    seedDupes()
    expect(duplicateGroups.value).toHaveLength(2)
    expect(duplicateGroups.value[0]).toMatchObject({
      hash: 'a'.repeat(64),
      wastedBytes: 100,
    })
    expect(duplicateGroups.value[0].models.map((m) => m.id)).toEqual([
      'p1',
      'p2',
    ])
    // 无哈希的独立模型不入组
    expect(duplicateIdSet.value.has('s')).toBe(false)
    expect(duplicateWastedBytes.value).toBe(150)
  })

  it('重复筛选：仅保留组内成员；哈希回填后分组即时出现（渐进可用）', () => {
    seedDupes()
    state.showDuplicatesOnly = true
    expect(filteredModels.value.map((m) => m.id)).toEqual([
      'p1',
      'p2',
      'q1',
      'q2',
    ])

    // 独立模型的哈希经预热完成事件回填为与 p1 相同 → 立即进入重复组
    applyHashUpdate({ active: false, id: 's', hash: 'a'.repeat(64) })
    expect(effectiveModelHash(state.models.find((m) => m.id === 's'))).toBe(
      'a'.repeat(64),
    )
    expect(duplicateGroups.value[0].models.map((m) => m.id)).toEqual([
      'p1',
      'p2',
      's',
    ])
    // a 组 3 成员冗余 2×100，b 组 2 成员冗余 1×50
    expect(duplicateWastedBytes.value).toBe(250)
    expect(filteredModels.value.map((m) => m.id)).toEqual([
      'p1',
      'p2',
      's',
      'q1',
      'q2',
    ])
  })

  it('重复筛选下按哈希稳定排序聚拢同组（组内保持既有排序结果）', () => {
    seedDupes()
    state.showDuplicatesOnly = true
    // mtime 排序制造 A/B 组交错（q2 mtime 3 > p2 2 > q1 1.5 > p1 1）：
    // sortBy=mtime 的基础比较器为「新在前」，sortAsc=true 不翻转 → 纯 mtime
    // 降序为 q2/p2/q1/p1（A/B 交错）；重复筛选下按哈希稳定排序聚拢为
    // a 组（p2/p1）在前、b 组（q2/q1）在后，组内 mtime 降序保持
    replaceModels([
      makeModel('p1', { hash: 'a'.repeat(64), size: 100, mtimeMs: 1 }),
      makeModel('p2', { hash: 'a'.repeat(64), size: 100, mtimeMs: 2 }),
      makeModel('q1', { hash: 'b'.repeat(64), size: 50, mtimeMs: 1.5 }),
      makeModel('q2', { hash: 'b'.repeat(64), size: 50, mtimeMs: 3 }),
    ])
    state.sortBy = 'mtime'
    state.sortAsc = true
    expect(filteredModels.value.map((m) => m.id)).toEqual([
      'p2',
      'p1',
      'q2',
      'q1',
    ])
  })

  it('applyHashUpdate：写覆盖映射且对象引用不变；进行中/未知/同值安全跳过', () => {
    seedDupes()
    const sIdx = 4 // s 为 seedDupes 的最后一个模型
    const before = state.models[sIdx]
    // 进行中事件（active=true）不回填
    applyHashUpdate({ active: true, id: 's', hash: 'c'.repeat(64) })
    expect(effectiveModelHash(state.models[sIdx])).toBe('')
    // 未知 id / 空 hash 忽略
    applyHashUpdate({ active: false, id: 'no-such', hash: 'c'.repeat(64) })
    applyHashUpdate({ active: false, id: 's', hash: '' })
    expect(state.models[sIdx]).toBe(before)
    // 首次回填：O7 写覆盖映射，模型对象保持引用稳定（列表派生不失效）
    applyHashUpdate({ active: false, id: 's', hash: 'c'.repeat(64) })
    expect(state.models[sIdx]).toBe(before)
    expect(state.models[sIdx].hash).toBe('')
    expect(effectiveModelHash(state.models[sIdx])).toBe('c'.repeat(64))
    // 同值幂等：覆盖值不变
    applyHashUpdate({ active: false, id: 's', hash: 'c'.repeat(64) })
    expect(effectiveModelHash(state.models[sIdx])).toBe('c'.repeat(64))
  })

  it('O7 批次：completions 一次回填多个模型，未知/同值项安全跳过且不换对象', () => {
    seedDupes()
    const beforeP1 = state.models[0]
    applyHashUpdate({
      active: false,
      id: '',
      hash: '',
      completions: [
        { id: 'p1', hash: 'c'.repeat(64) },
        { id: 'no-such', hash: 'd'.repeat(64) },
        { id: 'p2', hash: 'a'.repeat(64) }, // 同值
      ],
    })

    expect(state.models[0]).toBe(beforeP1)
    expect(effectiveModelHash(state.models[0])).toBe('c'.repeat(64))
    expect(effectiveModelHash(state.models[1])).toBe('a'.repeat(64))
  })

  it('哈希搜索使用覆盖映射（O7）：无需重扫即可按 hash: 前缀命中', () => {
    seedDupes()
    applyHashUpdate({ active: false, id: 's', hash: 'c'.repeat(64) })
    state.search = `hash:${'c'.repeat(8)}`
    expect(filteredModels.value.map((m) => m.id)).toEqual(['s'])
  })

  it('replaceModels 清理已移除 id 的哈希覆盖（避免陈旧哈希复活）', () => {
    seedDupes()
    applyHashUpdate({ active: false, id: 's', hash: 'c'.repeat(64) })
    expect(effectiveModelHash(state.models[4])).toBe('c'.repeat(64))

    // 移除 s 后再以无哈希对象重新加入：旧覆盖不得复活
    replaceModels(state.models.filter((m) => m.id !== 's'))
    replaceModels([...state.models, makeModel('s', { hash: '' })])
    expect(effectiveModelHash(state.models.find((m) => m.id === 's'))).toBe('')
  })

  it('关闭重复筛选后视图恢复全量（筛选随开关生效与退出）', () => {
    seedDupes()
    state.showDuplicatesOnly = true
    expect(filteredModels.value).toHaveLength(4)
    state.showDuplicatesOnly = false
    expect(filteredModels.value).toHaveLength(5)
  })
})
