// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import {
  activeSavedViewId,
  applySavedView,
  defaultSettings,
  deleteSavedView,
  saveCurrentAsView,
  savedViews,
  state,
  viewSummary
} from '../src/renderer/src/store/appStore'

/**
 * 智能视图（组合筛选收藏）store 模块测试：
 * - 保存：快照字段完整、名称校验（空白/超长/重名/上限）、即时持久化
 * - 应用：整体覆写平铺筛选字段（B-02 镜像）、subFilter 在
 *   typeFilter watcher 清空后恢复、排序持久化
 * - 活动视图命中高亮、删除持久化、摘要文案
 */

/** window.api 桩：settings.update 回显合并结果（与主进程规范化返回的完整设置一致） */
function makeApiMock() {
  return {
    settings: {
      update: vi.fn((patch) => Promise.resolve({ settings: { ...state.settings, ...patch } }))
    },
    window: { setTheme: vi.fn(() => Promise.resolve()) }
  }
}

/** 复位筛选/视图相关状态（口径与 componentTest 一致，裁剪到本域） */
function resetState() {
  state.typeFilter = 'all'
  state.subFilter = ''
  state.showFavoritesOnly = false
  state.search = ''
  state.sortBy = 'name'
  state.sortAsc = true
  Object.assign(state.settings, defaultSettings())
  state.toasts.splice(0, state.toasts.length)
}

beforeEach(() => {
  window.api = makeApiMock()
  resetState()
})

/** 造一个视图载荷（直接写入设置镜像，绕过保存流程） */
function seedView(overrides = {}) {
  const view = {
    id: 'v1',
    name: 'LoRA收藏',
    search: '',
    typeFilter: 'lora',
    subFilter: '',
    showFavoritesOnly: true,
    sortBy: 'name',
    sortAsc: true,
    ...overrides
  }
  state.settings.savedViews = [view]
  return view
}

describe('智能视图：保存当前筛选', () => {
  it('快照当前筛选/排序字段并即时持久化', async () => {
    state.search = '动漫'
    state.typeFilter = 'lora'
    await nextTick() // 等 typeFilter watcher 落定后再设 subFilter（与应用路径同序）
    state.subFilter = 'role'
    state.showFavoritesOnly = true
    state.sortBy = 'mtime'
    state.sortAsc = false

    const ok = await saveCurrentAsView('我的视图')

    expect(ok).toBe(true)
    const call = window.api.settings.update.mock.calls[0][0]
    expect(call.savedViews).toHaveLength(1)
    expect(call.savedViews[0]).toMatchObject({
      name: '我的视图',
      search: '动漫',
      typeFilter: 'lora',
      subFilter: 'role',
      showFavoritesOnly: true,
      sortBy: 'mtime',
      sortAsc: false
    })
    expect(call.savedViews[0].id).toBeTruthy()
    // 设置镜像已同步（侧栏列表立即可见）
    expect(savedViews.value).toHaveLength(1)
  })

  it('名称为空白时拒绝且不持久化', async () => {
    expect(await saveCurrentAsView('   ')).toBe(false)
    expect(window.api.settings.update).not.toHaveBeenCalled()
    expect(state.toasts.some((t) => t.type === 'warn')).toBe(true)
  })

  it('名称超长（>30 字）时拒绝', async () => {
    expect(await saveCurrentAsView('x'.repeat(31))).toBe(false)
    expect(window.api.settings.update).not.toHaveBeenCalled()
  })

  it('重名（不区分大小写）时拒绝', async () => {
    seedView({ name: 'My View' })
    expect(await saveCurrentAsView('my view')).toBe(false)
    expect(window.api.settings.update).not.toHaveBeenCalled()
  })

  it('达到 20 个上限时拒绝', async () => {
    state.settings.savedViews = Array.from({ length: 20 }, (_, i) => ({
      id: `v${i}`,
      name: `视图${i}`,
      search: '',
      typeFilter: 'all',
      subFilter: '',
      showFavoritesOnly: false,
      sortBy: 'name',
      sortAsc: true
    }))
    expect(await saveCurrentAsView('第21个')).toBe(false)
    expect(window.api.settings.update).not.toHaveBeenCalled()
  })
})

describe('智能视图：应用', () => {
  it('整体覆写平铺筛选字段并持久化排序', async () => {
    const view = seedView({
      search: '机甲',
      typeFilter: 'checkpoint',
      showFavoritesOnly: false,
      sortBy: 'size',
      sortAsc: false
    })

    await applySavedView(view.id)

    expect(state.search).toBe('机甲')
    expect(state.typeFilter).toBe('checkpoint')
    expect(state.showFavoritesOnly).toBe(false)
    expect(state.sortBy).toBe('size')
    expect(state.sortAsc).toBe(false)
    // 排序持久化（与手动改排序的既有行为一致）
    expect(window.api.settings.update).toHaveBeenCalledWith({ sortBy: 'size', sortAsc: false })
  })

  it('LoRA 子分类筛选在 typeFilter watcher 清空后恢复', async () => {
    const view = seedView({ typeFilter: 'lora', subFilter: 'role' })

    await applySavedView(view.id)
    await nextTick()

    expect(state.typeFilter).toBe('lora')
    // filter.js 的 typeFilter watcher 会清空 subFilter（微任务 flush），
    // 应用路径须在其落定后恢复视图携带的子分类
    expect(state.subFilter).toBe('role')
  })

  it('应用不存在的视图 id 为空操作', async () => {
    await applySavedView('v-not-exist')
    expect(state.typeFilter).toBe('all')
    expect(window.api.settings.update).not.toHaveBeenCalled()
  })
})

describe('智能视图：活动命中与删除', () => {
  it('当前状态与视图逐项一致时命中活动视图，改动后失效', async () => {
    seedView()
    state.typeFilter = 'lora'
    state.showFavoritesOnly = true

    expect(activeSavedViewId.value).toBe('v1')

    state.search = 'x'
    expect(activeSavedViewId.value).toBe('')
  })

  it('删除视图并持久化剩余列表', async () => {
    seedView()
    const ok = await deleteSavedView('v1')
    expect(ok).toBe(true)
    expect(window.api.settings.update).toHaveBeenCalledWith({ savedViews: [] })
    expect(savedViews.value).toHaveLength(0)
  })

  it('删除不存在的 id 为空操作', async () => {
    seedView()
    expect(await deleteSavedView('v-x')).toBe(false)
    expect(window.api.settings.update).not.toHaveBeenCalled()
  })
})

describe('智能视图：摘要', () => {
  it('组合非默认筛选条件与排序（固定语义排序不带方向）', () => {
    const v = {
      search: '动漫',
      typeFilter: 'lora',
      subFilter: 'role',
      showFavoritesOnly: true,
      sortBy: 'favorite',
      sortAsc: false
    }
    const summary = viewSummary(v)
    expect(summary).toContain('LoRA')
    expect(summary).toContain('角色')
    expect(summary).toContain('仅收藏')
    expect(summary).toContain('动漫')
    expect(summary).toContain('收藏优先')
    expect(summary).not.toContain('↓') // 固定语义排序不响应方向
  })

  it('无筛选条件时以「全部模型」兜底并携带排序', () => {
    expect(
      viewSummary({
        search: '',
        typeFilter: 'all',
        subFilter: '',
        showFavoritesOnly: false,
        sortBy: 'name',
        sortAsc: true
      })
    ).toBe('全部模型 · 按名称↑')
  })
})
