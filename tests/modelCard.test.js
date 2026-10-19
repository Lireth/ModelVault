// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ModelCard from '../src/renderer/src/components/ModelCard.vue'
import { state } from '../src/renderer/src/store/appStore'
import { setupComponentTest, settle } from './helpers/componentTest'

/**
 * ModelCard 组件测试（OPT-16 基建；OPT-3 回归）：
 * 键盘交互正确性——卡片 Enter/Space 激活（打开详情/多选切换），
 * 收藏按钮 Enter/Space 仅切换收藏（keydown 不得冒泡到 article 触发
 * 打开详情的双动作缺陷）。
 */

setupComponentTest()

/** 构造最小模型对象（字段与扫描装饰结果对齐） */
function makeModel(id, overrides = {}) {
  return {
    id,
    name: id,
    type: 'checkpoint',
    size: 1000,
    mtimeMs: 1000,
    favorite: false,
    nsfw: false,
    rating: 0,
    alias: '',
    note: '',
    subCategory: '',
    triggerWords: '',
    ...overrides
  }
}

function mountCard(model) {
  state.models = [model]
  return mount(ModelCard, { props: { model } })
}

describe('ModelCard 卡片激活', () => {
  it('Enter 打开详情', async () => {
    const wrapper = mountCard(makeModel('m1'))
    await wrapper.find('.model-card').trigger('keydown', { key: 'Enter' })
    expect(state.selectedId).toBe('m1')
  })

  it('Space 打开详情', async () => {
    const wrapper = mountCard(makeModel('m1'))
    await wrapper.find('.model-card').trigger('keydown', { key: ' ' })
    expect(state.selectedId).toBe('m1')
  })

  it('点击打开详情', async () => {
    const wrapper = mountCard(makeModel('m1'))
    await wrapper.find('.model-card').trigger('click')
    expect(state.selectedId).toBe('m1')
  })

  it('多选模式下 Enter 切换选中而非打开详情', async () => {
    state.multiSelect.active = true
    const wrapper = mountCard(makeModel('m1'))
    await wrapper.find('.model-card').trigger('keydown', { key: 'Enter' })
    expect(state.multiSelect.ids).toEqual(['m1'])
    expect(state.selectedId).toBeNull()
  })
})

describe('ModelCard 修饰键点击（多选交互增强）', () => {
  it('Ctrl+点击：非多选模式进入多选并选中，不打开详情', async () => {
    const wrapper = mountCard(makeModel('m1'))
    await wrapper.find('.model-card').trigger('click', { ctrlKey: true })
    expect(state.multiSelect.active).toBe(true)
    expect(state.multiSelect.ids).toEqual(['m1'])
    expect(state.selectedId).toBeNull()
  })

  it('多选模式下 Ctrl+点击等同普通点击切换选中', async () => {
    state.multiSelect.active = true
    const wrapper = mountCard(makeModel('m1'))
    await wrapper.find('.model-card').trigger('click', { ctrlKey: true })
    expect(state.multiSelect.ids).toEqual(['m1'])
    await wrapper.find('.model-card').trigger('click', { ctrlKey: true })
    expect(state.multiSelect.ids).toEqual([])
    expect(state.selectedId).toBeNull()
  })

  it('Shift+点击：非多选模式进入多选并选中', async () => {
    const wrapper = mountCard(makeModel('m1'))
    await wrapper.find('.model-card').trigger('click', { shiftKey: true })
    expect(state.multiSelect.active).toBe(true)
    expect(state.multiSelect.ids).toEqual(['m1'])
    expect(state.selectedId).toBeNull()
  })

  it('多选模式下 Shift+点击走范围选择路径（无锚点时退化为切换）', async () => {
    state.multiSelect.active = true
    const wrapper = mountCard(makeModel('m1'))
    // 组件级单卡片场景无锚点（store 层锚点语义在 multiselect.test.js 覆盖），
    // 此处验证修饰键分支确实路由到了范围选择（退化行为与普通切换一致）
    await wrapper.find('.model-card').trigger('click', { shiftKey: true })
    expect(state.multiSelect.ids).toEqual(['m1'])
    expect(state.selectedId).toBeNull()
  })
})

describe('ModelCard NSFW 模糊开关', () => {
  it('nsfw 模型默认模糊（设置 nsfwBlur 默认开启）且显示红色 NSFW 角标', () => {
    const wrapper = mountCard(makeModel('m1', { nsfw: true, coverUrl: 'mvimg://thumb/a.png' }))
    expect(wrapper.find('.cover img').classes()).toContain('blurred')
    expect(wrapper.find('.nsfw-badge').exists()).toBe(true)
    wrapper.unmount()
  })

  it('设置关闭模糊后 nsfw 模型封面不再模糊，红色 NSFW 角标保留', () => {
    state.settings.nsfwBlur = false
    const wrapper = mountCard(makeModel('m1', { nsfw: true, coverUrl: 'mvimg://thumb/a.png' }))
    expect(wrapper.find('.cover img').classes()).not.toContain('blurred')
    expect(wrapper.find('.nsfw-badge').exists()).toBe(true)
    wrapper.unmount()
  })

  it('非 nsfw 模型不受开关影响，始终不模糊', () => {
    state.settings.nsfwBlur = true
    const wrapper = mountCard(makeModel('m1', { nsfw: false, coverUrl: 'mvimg://thumb/a.png' }))
    expect(wrapper.find('.cover img').classes()).not.toContain('blurred')
    wrapper.unmount()
  })
})

describe('ModelCard 收藏按钮键盘行为（OPT-3 回归）', () => {
  /**
   * 说明：jsdom 不会把 Enter/Space 按键合成为按钮原生 click（真实浏览器会）。
   * 以下用例按浏览器真实时序模拟「keydown → click」两段，断言叠加后只有
   * 收藏生效、详情未打开——正是 OPT-3 双触发缺陷的回归点。
   */

  it('Enter：仅切换收藏，不冒泡打开详情', async () => {
    window.api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: true, nsfw: false, rating: 0 }
    })
    const wrapper = mountCard(makeModel('m1'))
    const btn = wrapper.find('.fav-btn')
    // 第一段：keydown 不得冒泡到 article 触发打开详情
    await btn.trigger('keydown', { key: 'Enter' })
    expect(state.selectedId).toBeNull()
    // 第二段：浏览器随后触发原生 click，收藏生效
    await btn.trigger('click')
    await settle()
    expect(window.api.models.setMetaFlags).toHaveBeenCalledWith({ id: 'm1', favorite: true })
    expect(state.selectedId).toBeNull()
  })

  it('Space：仅切换收藏，不冒泡打开详情', async () => {
    window.api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: true, nsfw: false, rating: 0 }
    })
    const wrapper = mountCard(makeModel('m1'))
    const btn = wrapper.find('.fav-btn')
    await btn.trigger('keydown', { key: ' ' })
    expect(state.selectedId).toBeNull()
    await btn.trigger('click')
    await settle()
    expect(window.api.models.setMetaFlags).toHaveBeenCalledWith({ id: 'm1', favorite: true })
    expect(state.selectedId).toBeNull()
  })

  it('点击：切换收藏且不打开详情', async () => {
    window.api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: true, nsfw: false, rating: 0 }
    })
    const wrapper = mountCard(makeModel('m1'))
    await wrapper.find('.fav-btn').trigger('click')
    await settle()
    expect(window.api.models.setMetaFlags).toHaveBeenCalled()
    expect(state.selectedId).toBeNull()
  })

  it('已收藏时 Enter 切换为取消收藏', async () => {
    window.api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: false, nsfw: false, rating: 0 }
    })
    const wrapper = mountCard(makeModel('m1', { favorite: true }))
    const btn = wrapper.find('.fav-btn')
    await btn.trigger('keydown', { key: 'Enter' })
    await btn.trigger('click')
    await settle()
    expect(window.api.models.setMetaFlags).toHaveBeenCalledWith({ id: 'm1', favorite: false })
    expect(state.selectedId).toBeNull()
  })
})

describe('ModelCard 封面悬停轮播', () => {
  /**
   * 与组件内常量对齐：悬停停稳 HOVER_DELAY 后启动，之后每 CYCLE_INTERVAL 推进一张。
   * Image 桩按 URL 集合决定 load/error（queueMicrotask 触发，配合
   * advanceTimersByTimeAsync 的微任务冲刷，无需真实图片加载）。
   */
  const HOVER_DELAY = 400
  const CYCLE_INTERVAL = 1400
  let failUrls = new Set()
  let restoreImage = null

  function makeCovers(prefix, count) {
    return Array.from({ length: count }, (_, i) => ({
      rel: `${prefix}${i}.png`,
      path: `/lib/${prefix}${i}.png`,
      url: `mvimg://local/${prefix}${i}.png`
    }))
  }

  /** 当前轮播展示的最新一张轮播图 src（无轮播层时为空串） */
  function currentCycleSrc(wrapper) {
    const imgs = wrapper.findAll('.cycle-layer img')
    return imgs.length ? imgs.at(-1).attributes('src') : ''
  }

  beforeEach(() => {
    vi.useFakeTimers()
    failUrls = new Set()
    const Original = globalThis.Image
    globalThis.Image = class {
      set src(url) {
        queueMicrotask(() => {
          if (failUrls.has(url)) this.onerror?.(new Error('load failed'))
          else this.onload?.()
        })
      }
    }
    restoreImage = () => {
      globalThis.Image = Original
    }
  })

  afterEach(() => {
    restoreImage()
    vi.useRealTimers()
  })

  it('少于两张封面时悬停不启动轮播', async () => {
    const covers = makeCovers('a', 1)
    const wrapper = mountCard(
      makeModel('m1', { cover: covers[0].path, covers, coverUrl: 'mvimg://thumb/a0.png' })
    )
    await wrapper.find('.cover').trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(HOVER_DELAY + CYCLE_INTERVAL * 2)
    expect(wrapper.find('.cycle-layer').exists()).toBe(false)
    expect(wrapper.find('.cycle-dots').exists()).toBe(false)
    wrapper.unmount()
  })

  it('悬停停稳后从默认封面下一张开始轮播并循环', async () => {
    const covers = makeCovers('b', 3)
    const wrapper = mountCard(
      makeModel('m1', { cover: covers[0].path, covers, coverUrl: 'mvimg://thumb/b0.png' })
    )
    await wrapper.find('.cover').trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(HOVER_DELAY)
    expect(currentCycleSrc(wrapper)).toBe(covers[1].url)
    expect(wrapper.findAll('.cycle-dot')).toHaveLength(3)
    expect(wrapper.findAll('.cycle-dot')[1].classes()).toContain('on')
    await vi.advanceTimersByTimeAsync(CYCLE_INTERVAL)
    expect(currentCycleSrc(wrapper)).toBe(covers[2].url)
    await vi.advanceTimersByTimeAsync(CYCLE_INTERVAL)
    expect(currentCycleSrc(wrapper)).toBe(covers[0].url)
    wrapper.unmount()
  })

  it('轮播优先使用封面缩略图（OPT-1）', async () => {
    const covers = makeCovers('t', 2)
    // 第二张携带主进程推送的缩略图地址：预载与展示均走 thumbUrl
    covers[1].thumbUrl = 'mvimg://thumb/t1.jpg'
    const wrapper = mountCard(
      makeModel('m1', { cover: covers[0].path, covers, coverUrl: 'mvimg://thumb/t0.png' })
    )
    await wrapper.find('.cover').trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(HOVER_DELAY)
    expect(currentCycleSrc(wrapper)).toBe(covers[1].thumbUrl)
    wrapper.unmount()
  })

  it('缩略图预加载失败时回退原图（OPT-1）', async () => {
    const covers = makeCovers('u', 2)
    covers[1].thumbUrl = 'mvimg://thumb/u1.jpg'
    failUrls.add(covers[1].thumbUrl)
    const wrapper = mountCard(
      makeModel('m1', { cover: covers[0].path, covers, coverUrl: 'mvimg://thumb/u0.png' })
    )
    await wrapper.find('.cover').trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(HOVER_DELAY)
    // 缩略图预载失败 → 回退原图展示，封面不被跳过
    expect(currentCycleSrc(wrapper)).toBe(covers[1].url)
    // 后续推进正常（原图可加载）
    await vi.advanceTimersByTimeAsync(CYCLE_INTERVAL)
    expect(currentCycleSrc(wrapper)).toBe(covers[0].url)
    wrapper.unmount()
  })

  it('光标扫过未停稳不触发轮播', async () => {
    const covers = makeCovers('c', 2)
    const wrapper = mountCard(
      makeModel('m1', { cover: covers[0].path, covers, coverUrl: 'mvimg://thumb/c0.png' })
    )
    await wrapper.find('.cover').trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(HOVER_DELAY - 100)
    await wrapper.find('.cover').trigger('mouseleave')
    await vi.advanceTimersByTimeAsync(HOVER_DELAY + CYCLE_INTERVAL * 2)
    expect(wrapper.find('.cycle-layer').exists()).toBe(false)
    wrapper.unmount()
  })

  it('离开封面区立即停播并恢复默认封面', async () => {
    const covers = makeCovers('d', 2)
    const wrapper = mountCard(
      makeModel('m1', { cover: covers[0].path, covers, coverUrl: 'mvimg://thumb/d0.png' })
    )
    await wrapper.find('.cover').trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(HOVER_DELAY)
    expect(wrapper.find('.cycle-layer').exists()).toBe(true)
    await wrapper.find('.cover').trigger('mouseleave')
    expect(wrapper.find('.cycle-layer').exists()).toBe(false)
    // 停播后计时器已清理，时间推进不再复活轮播
    await vi.advanceTimersByTimeAsync(CYCLE_INTERVAL * 3)
    expect(wrapper.find('.cycle-layer').exists()).toBe(false)
    wrapper.unmount()
  })

  it('加载失败的封面被跳过', async () => {
    const covers = makeCovers('e', 3)
    failUrls.add(covers[1].url)
    const wrapper = mountCard(
      makeModel('m1', { cover: covers[0].path, covers, coverUrl: 'mvimg://thumb/e0.png' })
    )
    await wrapper.find('.cover').trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(HOVER_DELAY)
    // 第二张预加载失败，首轮直接落到第三张
    expect(currentCycleSrc(wrapper)).toBe(covers[2].url)
    await vi.advanceTimersByTimeAsync(CYCLE_INTERVAL)
    expect(currentCycleSrc(wrapper)).toBe(covers[0].url)
    wrapper.unmount()
  })
})

describe('ModelCard 重复角标（FEAT-1）', () => {
  /** 注入一对同哈希模型并挂载其一的卡片 */
  function mountWithDupes(extra = {}) {
    const a = makeModel('d1', { hash: 'h', ...extra })
    const b = makeModel('d2', { hash: 'h', ...extra })
    state.models = [a, b]
    return mount(ModelCard, { props: { model: a } })
  }

  it('哈希与其他模型相同时显示「重复」角标', async () => {
    const wrapper = mountWithDupes()
    await settle()
    expect(wrapper.find('.dupe-badge').exists()).toBe(true)
    wrapper.unmount()
  })

  it('NSFW 并存时重复角标带避让类（右移）', async () => {
    const wrapper = mountWithDupes({ nsfw: true })
    await settle()
    expect(wrapper.find('.dupe-badge').classes()).toContain('offset')
    wrapper.unmount()
  })

  it('独立模型（哈希无同伴）不显示重复角标', async () => {
    const a = makeModel('d1', { hash: 'h' })
    state.models = [a]
    const wrapper = mount(ModelCard, { props: { model: a } })
    await settle()
    expect(wrapper.find('.dupe-badge').exists()).toBe(false)
    wrapper.unmount()
  })
})
