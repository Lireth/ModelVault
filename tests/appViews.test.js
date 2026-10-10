import { describe, it, expect, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import {
  MAX_VIEWS,
  activeView,
  addView,
  closeView,
  resetViews,
  state,
  switchView,
  viewLabel
} from '../src/renderer/src/store/appStore'

/**
 * 多视图标签页（B-02）渲染层状态测试：
 * 视图间筛选条件隔离、切换字段整体换入（lora 子分类不被误清）、
 * 关闭激活页回落、自动命名、数量上限。
 */

beforeEach(() => {
  resetViews()
  state.models = []
  state.settings.sortBy = 'name'
  state.settings.sortAsc = true
})

function ids() {
  return state.views.map((v) => v.id)
}

describe('视图播种与镜像', () => {
  it('初始为单个默认视图，平铺字段即其镜像', () => {
    expect(state.views).toHaveLength(1)
    expect(state.activeViewId).toBe(activeView.value.id)
    expect(state.typeFilter).toBe('all')
    expect(state.dirFilter).toBe('')
  })
})

describe('addView / switchView 视图隔离', () => {
  it('新视图为默认筛选；旧视图修改在切换后恢复', async () => {
    const first = activeView.value.id
    state.typeFilter = 'lora'
    state.search = '角色'
    await nextTick()

    addView()
    expect(state.views).toHaveLength(2)
    const second = activeView.value.id
    expect(second).not.toBe(first)
    expect(state.typeFilter).toBe('all')
    expect(state.search).toBe('')

    // 新视图改成收藏筛选
    state.showFavoritesOnly = true
    state.dirFilter = 'lora'
    await nextTick()

    // 切回旧视图：lora + 搜索词原样恢复
    switchView(first)
    await nextTick()
    expect(state.typeFilter).toBe('lora')
    expect(state.search).toBe('角色')
    expect(state.showFavoritesOnly).toBe(false)
    expect(state.dirFilter).toBe('')

    // 再切到新视图：收藏 + 目录条件仍在
    switchView(second)
    await nextTick()
    expect(state.showFavoritesOnly).toBe(true)
    expect(state.dirFilter).toBe('lora')
  })

  it('切换到自带 lora 子分类的视图时，子分类不被「切主分类清空子分类」联动误清', async () => {
    const first = activeView.value.id
    addView()
    const second = activeView.value.id
    // 模拟真实操作：先切到 LoRA（清空子分类联动生效），再选择角色子分类
    state.typeFilter = 'lora'
    await nextTick()
    state.subFilter = 'role'
    await nextTick()

    switchView(first)
    await nextTick()
    expect(state.typeFilter).toBe('all')

    switchView(second)
    await nextTick()
    expect(state.typeFilter).toBe('lora')
    expect(state.subFilter).toBe('role')
  })

  it('同视图内切换主分类仍会清空子分类', async () => {
    state.typeFilter = 'lora'
    state.subFilter = 'role'
    await nextTick()
    state.typeFilter = 'other'
    await nextTick()
    expect(state.subFilter).toBe('')
  })

  it('字段修改自动回写活动视图（无需显式保存）', async () => {
    state.search = 'xyz'
    await nextTick()
    expect(activeView.value.search).toBe('xyz')
  })
})

describe('closeView 关闭标签页', () => {
  it('关闭激活页时激活前一个标签并换入其字段', async () => {
    const first = activeView.value.id
    addView()
    const second = activeView.value.id
    state.typeFilter = 'vae'
    await nextTick()
    addView()
    const third = activeView.value.id
    expect(ids()).toEqual([first, second, third])

    closeView(third)
    await nextTick()
    expect(state.activeViewId).toBe(second)
    expect(state.typeFilter).toBe('vae')
  })

  it('仅剩一个标签页时不可关闭', () => {
    closeView(activeView.value.id)
    expect(state.views).toHaveLength(1)
  })
})

describe('viewLabel 自动命名', () => {
  it('按搜索词 > 目录 > 收藏 > 子分类 > 主分类 > 序号 优先级', () => {
    expect(viewLabel({ typeFilter: 'all' }, 0)).toBe('视图 1')
    expect(viewLabel({ typeFilter: 'lora' }, 1)).toContain('LoRA')
    expect(viewLabel({ typeFilter: 'lora', subFilter: 'role' }, 0)).toContain('角色')
    expect(viewLabel({ showFavoritesOnly: true, typeFilter: 'lora' }, 0)).toContain('收藏')
    expect(viewLabel({ dirFilter: 'a/b', showFavoritesOnly: true }, 0)).toBe('📁 b')
    expect(viewLabel({ search: 'girl', dirFilter: 'a' }, 0)).toBe('搜索：girl')
  })
})

describe('标签页上限', () => {
  it('达到 MAX_VIEWS 后拒绝新建', () => {
    for (let i = 0; i < MAX_VIEWS - 1; i++) addView()
    expect(state.views).toHaveLength(MAX_VIEWS)
    expect(addView()).toBeNull()
    expect(state.views).toHaveLength(MAX_VIEWS)
  })
})
