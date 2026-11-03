// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import CivitaiPanel from '../src/renderer/src/components/detail/CivitaiPanel.vue'
import { replaceModels, state } from '../src/renderer/src/store/appStore'
import { setupComponentTest } from './helpers/componentTest'

/**
 * CivitaiPanel 组件测试（C4 数据关键 UI 补齐）：
 * 识别面板此前 40% 覆盖率。本文件覆盖功能开关、识别成功/未收录/错误/在途态、
 * 后台哈希预热进度、示例图勾选与导入（含 Proxy 退化载荷）、示例视频播放器、
 * 一键补全，以及切换模型时的会话状态复位。
 */

setupComponentTest()

/** 构造模型并选中（字段与扫描装饰结果对齐） */
function seedModels(models) {
  replaceModels(
    models.map((m) => ({
      id: m.id,
      name: m.id,
      type: 'lora',
      size: 1000,
      mtimeMs: 1000,
      alias: '',
      note: '',
      triggerWords: '',
      civitaiUrl: '',
      cover: '',
      coverUrl: '',
      covers: [],
      hasManualCover: false,
      ...m,
    })),
  )
  state.selectedId = models[0].id
}

/** 挂载面板（Teleport 桩内联渲染，视频播放器可经 wrapper 查询） */
async function mountPanel() {
  const wrapper = mount(CivitaiPanel, {
    global: { stubs: { Teleport: true } },
  })
  await flushPromises()
  return wrapper
}

/** 最近一条 toast */
function lastToast() {
  return state.toasts[state.toasts.length - 1]
}

beforeEach(() => {
  state.settings.civitaiEnabled = true
})

describe('CivitaiPanel 识别入口', () => {
  it('功能开关关闭时整个面板隐藏', async () => {
    state.settings.civitaiEnabled = false
    seedModels([{ id: 'm1' }])
    const wrapper = await mountPanel()
    expect(wrapper.find('.civitai-panel').exists()).toBe(false)
    wrapper.unmount()
  })

  it('识别成功展示模型页链接与一键补全', async () => {
    seedModels([{ id: 'm1' }])
    window.api.models.civitaiIdentify.mockResolvedValue({
      found: true,
      url: 'https://civitai.red/models/1?modelVersionId=2',
      info: { images: [], videos: [] },
      meta: {
        civitaiUrl: 'https://civitai.red/models/1?modelVersionId=2',
        triggerWords: '',
        note: '',
      },
    })
    const wrapper = await mountPanel()

    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('识别 Civitai 模型'))
      .trigger('click')
    await flushPromises()

    expect(window.api.models.civitaiIdentify).toHaveBeenCalledWith('m1')
    const link = wrapper.find('.civitai-link')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toBe(
      'https://civitai.red/models/1?modelVersionId=2',
    )
    expect(wrapper.findAll('button').some((b) => b.text() === '一键补全')).toBe(
      true,
    )
    wrapper.unmount()
  })

  it('未收录时展示明确提示，不进入已识别态', async () => {
    seedModels([{ id: 'm1' }])
    window.api.models.civitaiIdentify.mockResolvedValue({ found: false })
    const wrapper = await mountPanel()

    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('识别 Civitai 模型'))
      .trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('未在 Civitai 找到匹配的模型')
    expect(wrapper.find('.civitai-link').exists()).toBe(false)
    wrapper.unmount()
  })

  it('业务错误经 store 提示且保持未识别态', async () => {
    seedModels([{ id: 'm1' }])
    window.api.models.civitaiIdentify.mockResolvedValue({
      error: 'Civitai 功能已关闭',
    })
    const wrapper = await mountPanel()

    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('识别 Civitai 模型'))
      .trigger('click')
    await flushPromises()

    expect(lastToast()).toMatchObject({
      type: 'error',
      text: 'Civitai 功能已关闭',
    })
    expect(wrapper.find('.civitai-link').exists()).toBe(false)
    wrapper.unmount()
  })

  it('识别在途时按钮禁用并展示忙碌文案', async () => {
    seedModels([{ id: 'm1' }])
    let resolveIdentify
    window.api.models.civitaiIdentify.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveIdentify = resolve
        }),
    )
    const wrapper = await mountPanel()

    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('识别 Civitai 模型'))
      .trigger('click')
    await flushPromises()

    const busyBtn = wrapper
      .findAll('button')
      .find((b) => b.text() === '识别中…')
    expect(busyBtn).toBeTruthy()
    expect(busyBtn.attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toContain('正在计算文件哈希并查询 Civitai')

    resolveIdentify({ found: false })
    await flushPromises()
    expect(
      wrapper
        .findAll('button')
        .some((b) => b.text().includes('识别 Civitai 模型')),
    ).toBe(true)
    wrapper.unmount()
  })

  it('后台预热进度按当前模型匹配并展示百分比与字节数', async () => {
    seedModels([{ id: 'm1' }])
    Object.assign(state.warmup, {
      active: true,
      id: 'm1',
      percent: 40,
      hashedBytes: 1024 * 1024,
      totalBytes: 10 * 1024 * 1024,
      done: 0,
      remaining: 1,
    })
    const wrapper = await mountPanel()

    expect(wrapper.text()).toContain('正在计算文件哈希 40%（1.0 MB / 10.0 MB）')
    expect(wrapper.find('.civitai-warmup-fill').attributes('style')).toContain(
      'width: 40%',
    )
    wrapper.unmount()
  })

  it('预热进度属于其他模型时不展示', async () => {
    seedModels([{ id: 'm1' }])
    Object.assign(state.warmup, {
      active: true,
      id: 'm2',
      percent: 80,
      hashedBytes: 8,
      totalBytes: 10,
    })
    const wrapper = await mountPanel()
    expect(wrapper.find('.civitai-warmup').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('CivitaiPanel 示例图采集与导入', () => {
  const imageUrl = 'https://image.civitai.com/a.jpeg'
  const nsfwUrl = 'https://image.civitai.com/b.jpeg'
  const videoUrl = 'https://image.civitai.com/v.mp4'

  /** 已识别模型 + 识别返回示例图/视频 */
  async function mountWithImages() {
    seedModels([
      {
        id: 'm1',
        civitaiUrl: 'https://civitai.red/models/1?modelVersionId=2',
      },
    ])
    window.api.models.civitaiIdentify.mockResolvedValue({
      found: true,
      info: {
        images: [
          { url: imageUrl, width: 100, height: 100, nsfw: false },
          { url: nsfwUrl, width: 100, height: 100, nsfw: true },
        ],
        videos: [
          { url: videoUrl, thumbnailUrl: videoUrl, width: 320, height: 180 },
        ],
      },
    })
    const wrapper = await mountPanel()
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '示例图采集')
      .trigger('click')
    await flushPromises()
    return wrapper
  }

  it('展示示例图（NSFW 角标）与示例视频，可展开/收起', async () => {
    const wrapper = await mountWithImages()
    expect(wrapper.findAll('.civitai-img-item')).toHaveLength(2)
    expect(wrapper.findAll('.civitai-nsfw-badge')).toHaveLength(1)
    expect(wrapper.findAll('.civitai-video-item')).toHaveLength(1)

    await wrapper
      .findAll('button')
      .find((b) => b.text() === '收起示例图')
      .trigger('click')
    expect(wrapper.find('.civitai-img-grid').exists()).toBe(false)
    wrapper.unmount()
  })

  it('勾选图片后导入：载荷为普通 {url} 对象，成功后清空选择', async () => {
    const wrapper = await mountWithImages()
    await wrapper.findAll('.civitai-img-item input')[0].trigger('change')

    const importBtn = wrapper
      .findAll('button')
      .find((b) => b.text().includes('添加所选示例图（1）'))
    expect(importBtn).toBeTruthy()
    window.api.models.civitaiImportImages.mockResolvedValue({
      added: 1,
      failed: [],
      cover: 'c1',
      coverUrl: 'u1',
      covers: [{ rel: 'c1', path: 'p1' }],
    })
    await importBtn.trigger('click')
    await flushPromises()

    // Proxy 不可结构化克隆：组件必须拷贝为普通对象再走 IPC
    expect(window.api.models.civitaiImportImages).toHaveBeenCalledWith('m1', [
      { url: imageUrl },
    ])
    expect(wrapper.findAll('.civitai-img-item.checked')).toHaveLength(0)
    expect(lastToast().type).toBe('success')
    wrapper.unmount()
  })

  it('导入失败时保留勾选便于重试', async () => {
    const wrapper = await mountWithImages()
    await wrapper.findAll('.civitai-img-item input')[0].trigger('change')
    window.api.models.civitaiImportImages.mockResolvedValue({
      error: '示例图下载失败',
    })

    await wrapper
      .findAll('button')
      .find((b) => b.text().includes('添加所选示例图（1）'))
      .trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.civitai-img-item.checked')).toHaveLength(1)
    expect(lastToast()).toMatchObject({
      type: 'error',
      text: '示例图下载失败',
    })
    wrapper.unmount()
  })

  it('再次勾选同一张图会取消选择', async () => {
    const wrapper = await mountWithImages()
    const checkbox = wrapper.findAll('.civitai-img-item input')[0]

    await checkbox.trigger('change')
    expect(wrapper.findAll('.civitai-img-item.checked')).toHaveLength(1)
    await checkbox.trigger('change')
    expect(wrapper.findAll('.civitai-img-item.checked')).toHaveLength(0)
    wrapper.unmount()
  })

  it('全选 / 清空控制勾选集合', async () => {
    const wrapper = await mountWithImages()

    await wrapper
      .findAll('button')
      .find((b) => b.text() === '全选')
      .trigger('click')
    expect(wrapper.findAll('.civitai-img-item.checked')).toHaveLength(2)

    await wrapper
      .findAll('button')
      .find((b) => b.text() === '清空')
      .trigger('click')
    expect(wrapper.findAll('.civitai-img-item.checked')).toHaveLength(0)
    wrapper.unmount()
  })

  it('示例视频播放器经 civimg 代理播放，Esc 关闭', async () => {
    const wrapper = await mountWithImages()
    await wrapper.find('.civitai-video-item').trigger('click')

    expect(wrapper.find('.civitai-video-mask').exists()).toBe(true)
    const video = wrapper.find('.civitai-video-player')
    expect(video.attributes('src')).toBe(
      `civimg://remote/${encodeURIComponent(videoUrl)}`,
    )

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(wrapper.find('.civitai-video-mask').exists()).toBe(false)
    wrapper.unmount()
  })

  it('切换模型时清空上一模型的示例图与勾选状态', async () => {
    const wrapper = await mountWithImages()
    await wrapper.findAll('.civitai-img-item input')[0].trigger('change')

    seedModels([{ id: 'm1', civitaiUrl: 'x' }, { id: 'm2' }])
    state.selectedId = 'm2'
    await flushPromises()

    expect(wrapper.find('.civitai-img-grid').exists()).toBe(false)
    expect(
      wrapper
        .findAll('button')
        .some((b) => b.text().includes('识别 Civitai 模型')),
    ).toBe(true)
    wrapper.unmount()
  })
})

describe('CivitaiPanel 一键补全', () => {
  it('补全调用 IPC 并提示实际填充字段', async () => {
    seedModels([
      {
        id: 'm1',
        civitaiUrl: 'https://civitai.red/models/1?modelVersionId=2',
      },
    ])
    window.api.models.civitaiComplete.mockResolvedValue({
      found: true,
      applied: ['triggerWords', 'note'],
      meta: {
        civitaiUrl: 'https://civitai.red/models/1?modelVersionId=2',
        triggerWords: 'cat',
        note: 'desc',
      },
    })
    const wrapper = await mountPanel()

    await wrapper
      .findAll('button')
      .find((b) => b.text() === '一键补全')
      .trigger('click')
    await flushPromises()

    expect(window.api.models.civitaiComplete).toHaveBeenCalledWith('m1')
    expect(lastToast()).toMatchObject({ type: 'success' })
    expect(lastToast().text).toContain('已补全：触发词、备注')
    expect(state.models[0].triggerWords).toBe('cat')
    wrapper.unmount()
  })
})
