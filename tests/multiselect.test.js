import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  allFilteredSelected,
  exitMultiSelect,
  invertSelectionFiltered,
  replaceModels,
  selectRedundantDuplicates,
  selectRangeTo,
  state,
  toggleMultiSelectMode,
  toggleSelect,
  toggleSelectAllFiltered
} from '../src/renderer/src/store/appStore'

/**
 * 多选选择语义单元测试（范围选择锚点 / 反选 / 全选判定）：
 * 纯 store 层测试（不挂载组件），仅覆盖 multiselect.js 的选择逻辑：
 * - Shift 范围选择（selectRangeTo）：锚点设置 / 范围替换 / 重排序后按新位置 / 锚失效退化 / 退出清锚
 * - 反选（invertSelectionFiltered）：筛选内取反、筛选范围外已选保留
 * - 全选判定（allFilteredSelected）：长度快速路径与含筛选外 id 的正确性
 * 注入模型按名称 a/b/c/... 命名，默认 sortBy='name' 下顺序与命名一致。
 */

/** 模型 id 规则（seedModels 注入时同名对应） */
const id = (name) => `D:\\models\\${name}.safetensors`

// 选择语义不触发 IPC；与 appStore.test.js 同口径桩最小 window/document 保证模块加载
beforeEach(() => {
  vi.stubGlobal('window', { api: { models: {} } })
  vi.stubGlobal('document', {
    documentElement: { classList: { toggle: vi.fn() }, style: { setProperty: vi.fn() } }
  })
  state.folder = ''
  state.scanning = false
  state.scanError = ''
  replaceModels([])
  state.typeFilter = 'all'
  state.subFilter = ''
  state.showFavoritesOnly = false
  state.search = ''
  state.sortBy = 'name'
  state.sortAsc = true
  state.multiSelect.active = false
  state.multiSelect.ids = []
  state.multiSelect.busy = false
  state.multiSelect.progress = ''
})

/** 注入 n 个按名排序的模型（id 与 name 同名，默认排序下顺序确定） */
function seedModels(names, extra = {}) {
  replaceModels(
    names.map((name, i) => ({
      id: id(name),
      name,
      type: 'lora',
      size: 10 + i,
      mtimeMs: i + 1,
      favorite: false,
      nsfw: false,
      rating: 0,
      alias: '',
      note: '',
      subCategory: '',
      triggerWords: '',
      coverUrl: '',
      covers: [],
      ...extra
    }))
  )
}

describe('多选范围选择（selectRangeTo，锚点语义）', () => {
  it('普通点击设置锚点：toggleSelect 后范围选以最后点击项为锚', () => {
    seedModels(['a', 'b', 'c', 'd'])
    state.multiSelect.active = true
    toggleSelect(id('b'))
    expect(state.multiSelect.ids).toEqual([id('b')])

    selectRangeTo(id('d'))
    expect(state.multiSelect.ids).toEqual([id('b'), id('c'), id('d')])
  })

  it('反向范围：锚点在目标之后时仍覆盖两者之间的全部项', () => {
    seedModels(['a', 'b', 'c', 'd'])
    state.multiSelect.active = true
    toggleSelect(id('d'))
    selectRangeTo(id('b'))
    expect(state.multiSelect.ids).toEqual([id('b'), id('c'), id('d')])
  })

  it('范围选择替换现有选区：范围外的已选项被丢弃（资源管理器同语义）', () => {
    seedModels(['a', 'b', 'c', 'd'])
    state.multiSelect.active = true
    toggleSelect(id('a'))
    toggleSelect(id('b')) // 锚点为 b
    selectRangeTo(id('d'))
    expect(state.multiSelect.ids).toEqual([id('b'), id('c'), id('d')])
  })

  it('重排序后按新位置解析范围：锚点按 id 实时定位而非记忆索引', () => {
    seedModels(['a', 'b', 'c'])
    state.sortBy = 'mtime' // mtimeMs 降序：c > b > a
    state.multiSelect.active = true
    toggleSelect(id('a')) // 锚点 a 位于筛选结果末尾（索引 2）
    selectRangeTo(id('c')) // c 位于索引 0
    expect(state.multiSelect.ids).toEqual([id('c'), id('b'), id('a')])
  })

  it('锚点被筛选掉后退化为普通切换并以目标项重建锚点', () => {
    seedModels(['a', 'b', 'c'])
    state.multiSelect.active = true
    toggleSelect(id('a')) // 锚点 = a
    state.showFavoritesOnly = true // 全部非 favorite，筛选结果为空
    selectRangeTo(id('c')) // 锚失效 → 退化为 toggleSelect('c')
    expect(state.multiSelect.ids).toEqual([id('a'), id('c')])

    // 退化的切换已重建锚点为 c：再次范围选仍退化（c 不在空筛选内），
    // 且 a 在选区中，切换 a 为移除
    selectRangeTo(id('a'))
    expect(state.multiSelect.ids).toEqual([id('c')])
  })

  it('锚点有效但目标不在筛选结果中时退化为普通切换', () => {
    seedModels(['a', 'b'])
    state.multiSelect.active = true
    toggleSelect(id('a'))
    selectRangeTo('ghost-id') // 不存在的 id
    expect(state.multiSelect.ids).toEqual([id('a'), 'ghost-id'])
  })

  it('退出多选清空锚点：重新进入后范围选退化为普通切换', () => {
    seedModels(['a', 'b', 'c'])
    state.multiSelect.active = true
    toggleSelect(id('a'))
    exitMultiSelect()
    expect(state.multiSelect.ids).toEqual([])

    toggleMultiSelectMode()
    selectRangeTo(id('c')) // 锚已清空 → 退化
    expect(state.multiSelect.ids).toEqual([id('c')])
  })
})

describe('反选（invertSelectionFiltered）', () => {
  it('筛选范围内选中态取反', () => {
    seedModels(['a', 'b', 'c', 'd'])
    state.multiSelect.active = true
    toggleSelect(id('a'))
    toggleSelect(id('c'))
    invertSelectionFiltered()
    expect(state.multiSelect.ids).toEqual([id('b'), id('d')])
  })

  it('筛选范围外的已选项保留', () => {
    seedModels(['a', 'b', 'c', 'd'], { favorite: false })
    // 仅 c、d 为 favorite：showFavoritesOnly 后筛选结果为 [c, d]
    replaceModels(
      ['a', 'b', 'c', 'd'].map((name, i) => ({
        id: id(name),
        name,
        type: 'lora',
        size: 10 + i,
        mtimeMs: i + 1,
        favorite: name === 'c' || name === 'd',
        nsfw: false,
        rating: 0,
        alias: '',
        note: '',
        subCategory: '',
        triggerWords: '',
        coverUrl: '',
        covers: []
      }))
    )
    state.multiSelect.active = true
    toggleSelect(id('a'))
    state.showFavoritesOnly = true
    invertSelectionFiltered()
    // 筛选内 [c,d] 全未选 → 全选；筛选外已选 a 保留
    expect(state.multiSelect.ids).toEqual([id('c'), id('d'), id('a')])
  })
})

describe('重复清理选择（selectRedundantDuplicates，FEAT-1）', () => {
  /** 注入两个重复组 + 独立模型：x 组（哈希 h1）、y 组（哈希 h2）、z 独立 */
  function seedDupes() {
    replaceModels([
      { id: id('x1'), name: 'x1', type: 'lora', size: 100, mtimeMs: 1, favorite: false, rating: 0, hash: 'h1', covers: [] },
      { id: id('x2'), name: 'x2', type: 'lora', size: 100, mtimeMs: 2, favorite: false, rating: 4, hash: 'h1', covers: [] },
      { id: id('x3'), name: 'x3', type: 'lora', size: 100, mtimeMs: 3, favorite: true, rating: 0, hash: 'h1', covers: [] },
      { id: id('y1'), name: 'y1', type: 'lora', size: 50, mtimeMs: 1, favorite: false, rating: 0, hash: 'h2', covers: [] },
      { id: id('y2'), name: 'y2', type: 'lora', size: 50, mtimeMs: 2, favorite: false, rating: 0, hash: 'h2', covers: [] },
      { id: id('z'), name: 'z', type: 'lora', size: 10, mtimeMs: 1, favorite: true, rating: 5, hash: 'h3', covers: [] }
    ])
  }

  it('每组保留最优一份（评分高优先），其余冗余项加入多选', () => {
    seedDupes()
    const n = selectRedundantDuplicates()
    // x 组保留 x2（评分 4）；y 组评分/收藏相同，保留更新的 y2；z 独立不参与
    expect(n).toBe(3)
    expect(state.multiSelect.active).toBe(true)
    expect(state.multiSelect.ids).toEqual([id('x1'), id('x3'), id('y1')])
  })

  it('评分与收藏相同时保留最新文件（mtime 新者优先）', () => {
    replaceModels([
      { id: id('a1'), name: 'a1', type: 'lora', size: 10, mtimeMs: 5, favorite: true, rating: 2, hash: 'h1', covers: [] },
      { id: id('a2'), name: 'a2', type: 'lora', size: 10, mtimeMs: 9, favorite: true, rating: 2, hash: 'h1', covers: [] }
    ])
    expect(selectRedundantDuplicates()).toBe(1)
    expect(state.multiSelect.ids).toEqual([id('a1')])
  })

  it('已进入多选时保留模式态，仅替换选区', () => {
    seedDupes()
    state.multiSelect.active = true
    toggleSelect(id('z'))
    selectRedundantDuplicates()
    expect(state.multiSelect.active).toBe(true)
    expect(state.multiSelect.ids).toEqual([id('x1'), id('x3'), id('y1')])
  })

  it('无重复组时不动作、不进入多选', () => {
    seedModels(['a', 'b'])
    const n = selectRedundantDuplicates()
    expect(n).toBe(0)
    expect(state.multiSelect.active).toBe(false)
    expect(state.multiSelect.ids).toEqual([])
  })
})

describe('全选判定（allFilteredSelected）', () => {
  it('空筛选结果与空选区均判定为未全选', () => {
    seedModels(['a', 'b'])
    expect(allFilteredSelected.value).toBe(false)
  })

  it('部分选中（选中数少于筛选数）走快速路径判定为 false', () => {
    seedModels(['a', 'b', 'c'])
    state.multiSelect.active = true
    toggleSelect(id('a'))
    expect(allFilteredSelected.value).toBe(false)
  })

  it('选中数不少于筛选数但筛选内存在遗漏项时逐项校验为 false', () => {
    seedModels(['a', 'b'])
    replaceModels(
      ['a', 'b'].map((name, i) => ({
        id: id(name),
        name,
        type: 'lora',
        size: 10 + i,
        mtimeMs: i + 1,
        favorite: true,
        nsfw: false,
        rating: 0,
        alias: '',
        note: '',
        subCategory: '',
        triggerWords: '',
        coverUrl: '',
        covers: []
      }))
    )
    state.showFavoritesOnly = true // 筛选结果为 [a, b]
    state.multiSelect.active = true
    // 数量达标（2 >= 2）但 b 未选中，须走逐项校验而非长度短路
    state.multiSelect.ids = [id('a'), 'ghost-id']
    expect(allFilteredSelected.value).toBe(false)
  })

  it('全选后判定为 true；再 toggleSelect 任意项后判定为 false', () => {
    seedModels(['a', 'b', 'c'])
    state.multiSelect.active = true
    toggleSelectAllFiltered()
    expect(allFilteredSelected.value).toBe(true)
    toggleSelect(id('b'))
    expect(allFilteredSelected.value).toBe(false)
  })

  it('万级模型全选行为正确（回归性能优化的行为不变性）', () => {
    seedModels(Array.from({ length: 10000 }, (_, i) => `m${String(i).padStart(5, '0')}`))
    state.multiSelect.active = true
    toggleSelectAllFiltered()
    expect(state.multiSelect.ids).toHaveLength(10000)
    expect(allFilteredSelected.value).toBe(true)
    toggleSelect(id('m05000'))
    expect(allFilteredSelected.value).toBe(false)
  })
})
