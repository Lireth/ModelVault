import { describe, it, expect, beforeEach } from 'vitest'
import {
  makeApiMock,
  resetStoreTestState,
  makeModel,
} from './helpers/storeTest'
import {
  acceptConfirm,
  batchApplyTriggers,
  batchCivitaiIdentify,
  batchCivitaiImages,
  batchDeleteModels,
  batchFavorite,
  batchToggleDisabled,
  batchAssignCivitaiTags,
  batchOrganizeByTags,
  rejectConfirm,
  requestBatchCancel,
  state,
  toggleFavorite,
} from '../src/renderer/src/store/appStore'

/**
 * appStoreBatch.test.js（ENG-1 自 appStore.test.js 按域拆分，用例内容保持原样）
 */

let api

beforeEach(() => {
  api = makeApiMock()
  resetStoreTestState(api)
})

describe('快速连点竞态（A5）', () => {
  it('双击收藏：第二次读到第一次落定的状态，IPC 依次收到相反目标值（不丢翻）', async () => {
    state.models = [makeModel('m1', { favorite: false })]
    const sentPayloads = []
    let releaseFirst = () => {}
    api.models.setMetaFlags.mockImplementationOnce((payload) => {
      sentPayloads.push(payload)
      // 第一次调用挂起：模拟 IPC 在途窗口
      return new Promise((resolve) => {
        releaseFirst = () =>
          resolve({ meta: { favorite: true, nsfw: false, rating: 0 } })
      })
    })
    api.models.setMetaFlags.mockImplementationOnce((payload) => {
      sentPayloads.push(payload)
      return Promise.resolve({
        meta: { favorite: payload.favorite, nsfw: false, rating: 0 },
      })
    })

    const first = toggleFavorite('m1') // 不 await：构造连点场景
    const second = toggleFavorite('m1')
    releaseFirst()
    await Promise.all([first, second])

    // 串行化后：第一次读旧值 false -> true；第二次读新值 true -> false
    expect(sentPayloads).toEqual([
      { id: 'm1', favorite: true },
      { id: 'm1', favorite: false },
    ])
    // 净效果翻两次，回到 false（未串行化时两次都发 true，第二次点击看起来失效）
    expect(state.models[0].favorite).toBe(false)
  })

  it('前一次失败不阻塞后续操作：报错后再次点击仍正常生效', async () => {
    state.models = [makeModel('m1', { favorite: false })]
    api.models.setMetaFlags.mockRejectedValueOnce(new Error('IPC 断开'))
    api.models.setMetaFlags.mockResolvedValueOnce({
      meta: { favorite: true, nsfw: false, rating: 0 },
    })

    const ok1 = await toggleFavorite('m1')
    expect(ok1).toBe(false)
    expect(state.toasts.some((t) => t.text.includes('收藏操作失败'))).toBe(true)
    const ok2 = await toggleFavorite('m1')
    expect(ok2).toBe(true)
    expect(state.models[0].favorite).toBe(true)
  })

  it('队列按模型粒度：不同模型的操作互不等待（m1 在途时 m2 立即可完成）', async () => {
    state.models = [makeModel('m1'), makeModel('m2')]
    let m1Started = false
    let releaseFirst = () => {}
    api.models.setMetaFlags.mockImplementation((payload) => {
      if (payload.id === 'm1') {
        m1Started = true
        return new Promise((resolve) => {
          releaseFirst = () =>
            resolve({ meta: { favorite: true, nsfw: false, rating: 0 } })
        })
      }
      return Promise.resolve({
        meta: { favorite: true, nsfw: false, rating: 0 },
      })
    })

    const p1 = toggleFavorite('m1')
    const p2 = toggleFavorite('m2')
    await expect(p2).resolves.toBe(true) // m2 未因 m1 在途而阻塞
    expect(m1Started).toBe(true)
    expect(state.models[1].favorite).toBe(true)
    releaseFirst()
    await expect(p1).resolves.toBe(true)
    expect(state.models[0].favorite).toBe(true)
  })
})

describe('批量操作单次状态合并（O2）', () => {
  it('批量收藏：全部成功时单趟同步全部标记并提示成功', async () => {
    state.models = [makeModel('a'), makeModel('b'), makeModel('c')]
    state.multiSelect.ids = ['a', 'b', 'c']
    api.models.setMetaFlags.mockResolvedValue({
      meta: { favorite: true, nsfw: false, rating: 0 },
    })
    await batchFavorite(true)
    expect(state.models.map((m) => m.favorite)).toEqual([true, true, true])
    expect(
      state.toasts.some(
        (t) => t.type === 'success' && t.text.includes('已为 3 个模型收藏'),
      ),
    ).toBe(true)
  })

  it('批量收藏按统一限流执行：同时在途 IPC 不超过上限', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `m${i}`)
    state.models = ids.map((id) => makeModel(id))
    state.multiSelect.ids = ids
    let inFlight = 0
    let maxInFlight = 0
    api.models.setMetaFlags.mockImplementation(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return { meta: { favorite: true, nsfw: false, rating: 0 } }
    })

    await batchFavorite(true)

    expect(api.models.setMetaFlags).toHaveBeenCalledTimes(40)
    expect(maxInFlight).toBeGreaterThan(0)
    expect(maxInFlight).toBeLessThanOrEqual(16)
  })

  it('批量收藏：部分失败时成功者已同步、汇总提示统计', async () => {
    state.models = [makeModel('a'), makeModel('b'), makeModel('c')]
    state.multiSelect.ids = ['a', 'b', 'c']
    api.models.setMetaFlags.mockImplementation(({ id }) =>
      id === 'b'
        ? Promise.reject(new Error('IPC 断开'))
        : Promise.resolve({ meta: { favorite: true, nsfw: false, rating: 0 } }),
    )
    await batchFavorite(true)
    expect(state.models.find((m) => m.id === 'a').favorite).toBe(true)
    expect(state.models.find((m) => m.id === 'b').favorite).toBe(false)
    expect(state.models.find((m) => m.id === 'c').favorite).toBe(true)
    expect(
      state.toasts.some(
        (t) => t.type === 'warn' && t.text.includes('成功 2 个，失败 1 个'),
      ),
    ).toBe(true)
  })

  it('一键分配标签：确认后逐个按 Civitai 分类分配并单趟同步标签字段', async () => {
    state.models = [
      makeModel('a', { type: 'lora' }),
      makeModel('b', { type: 'lora' }),
    ]
    state.multiSelect.ids = ['a', 'b']
    api.models.civitaiCategory.mockImplementation((id) =>
      id === 'a'
        ? Promise.resolve({
            found: true,
            subCategory: 'role',
            meta: { subCategory: 'role' },
          })
        : Promise.resolve({ skipped: true }),
    )
    const p = batchAssignCivitaiTags()
    acceptConfirm()
    await p
    expect(api.models.civitaiCategory).toHaveBeenCalledTimes(2)
    expect(state.models.find((m) => m.id === 'a').subCategory).toBe('role')
    expect(
      state.toasts.some(
        (t) =>
          t.type === 'success' &&
          t.text.includes('成功 1 个') &&
          t.text.includes('无 Civitai 链接 1 个'),
      ),
    ).toBe(true)
  })

  it('一键分配标签：非 LoRA 模型不发起 IPC 且计入汇总', async () => {
    state.models = [
      makeModel('a', { type: 'lora' }),
      makeModel('b', { type: 'checkpoint' }),
    ]
    state.multiSelect.ids = ['a', 'b']
    api.models.civitaiCategory.mockResolvedValue({
      found: true,
      subCategory: 'role',
      meta: { subCategory: 'role' },
    })
    const p = batchAssignCivitaiTags()
    acceptConfirm()
    await p
    expect(api.models.civitaiCategory).toHaveBeenCalledTimes(1)
    expect(api.models.civitaiCategory).toHaveBeenCalledWith('a')
    expect(
      state.toasts.some(
        (t) =>
          t.type === 'success' &&
          t.text.includes('成功 1 个') &&
          t.text.includes('非 LoRA 1 个'),
      ),
    ).toBe(true)
  })

  it('一键分配标签：全选均非 LoRA 时提示且不发起 IPC', async () => {
    state.models = [makeModel('a', { type: 'checkpoint' })]
    state.multiSelect.ids = ['a']
    await batchAssignCivitaiTags()
    expect(api.models.civitaiCategory).not.toHaveBeenCalled()
    expect(state.toasts.some((t) => t.text.includes('均不是 LoRA'))).toBe(true)
  })

  it('一键分配标签：确认层拒绝时不发起任何 IPC', async () => {
    state.models = [makeModel('a', { type: 'lora' })]
    state.multiSelect.ids = ['a']
    const p = batchAssignCivitaiTags()
    rejectConfirm()
    await p
    expect(api.models.civitaiCategory).not.toHaveBeenCalled()
  })

  it('一键移动文件：已标注与未标注 LoRA 按新结构提交移动并整表重扫，非 LoRA 不参与', async () => {
    state.models = [
      makeModel('a', { type: 'lora', subCategory: 'role' }),
      makeModel('b', { type: 'lora', subCategory: '' }),
      makeModel('c', { type: 'checkpoint', subCategory: 'base' }),
    ]
    state.multiSelect.ids = ['a', 'b', 'c']
    state.scanning = true // 跳过移动后的整表重扫（该链路由 scanner/watcher 测试覆盖）
    api.models.organizeByTags.mockResolvedValue({
      moved: 2,
      failed: [],
      skipped: [],
    })
    const p = batchOrganizeByTags()
    acceptConfirm()
    await p
    expect(api.models.organizeByTags).toHaveBeenCalledWith([
      { id: 'a', subCategory: 'role' },
      { id: 'b', subCategory: '' },
    ])
    expect(
      state.toasts.some(
        (t) => t.type === 'success' && t.text.includes('已移动 2 个 LoRA 模型'),
      ),
    ).toBe(true)
  })

  it('一键移动文件：选中模型均非 LoRA 时提示且不发起 IPC', async () => {
    state.models = [makeModel('a', { type: 'checkpoint', subCategory: '' })]
    state.multiSelect.ids = ['a']
    await batchOrganizeByTags()
    expect(api.models.organizeByTags).not.toHaveBeenCalled()
    expect(state.toasts.some((t) => t.text.includes('均不是 LoRA'))).toBe(true)
  })

  it('批量删除：确认后单趟移除并清理 selectedId 与选区', async () => {
    state.models = [makeModel('a'), makeModel('b'), makeModel('c')]
    state.selectedId = 'b'
    state.multiSelect.active = true
    state.multiSelect.ids = ['a', 'b']
    api.models.deleteModel.mockResolvedValue({ ok: true })
    const p = batchDeleteModels()
    acceptConfirm()
    await p
    expect(state.models.map((m) => m.id)).toEqual(['c'])
    expect(state.selectedId).toBeNull()
    // 选区仅移除已删除 id，多选模式保持
    expect(state.multiSelect.active).toBe(true)
    expect(state.multiSelect.ids).toEqual([])
    expect(
      state.toasts.some(
        (t) =>
          t.type === 'success' && t.text.includes('已将 2 个模型移入回收站'),
      ),
    ).toBe(true)
  })

  it('批量删除按文件操作并发上限执行：同时在途 IPC 不超过上限', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `d${i}`)
    state.models = ids.map((id) => makeModel(id))
    state.multiSelect.ids = ids
    let inFlight = 0
    let maxInFlight = 0
    api.models.deleteModel.mockImplementation(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return { ok: true }
    })

    const pending = batchDeleteModels()
    acceptConfirm()
    await pending

    expect(api.models.deleteModel).toHaveBeenCalledTimes(40)
    expect(maxInFlight).toBeGreaterThan(0)
    expect(maxInFlight).toBeLessThanOrEqual(8)
  })

  it('批量删除：部分失败时失败者保留在列表', async () => {
    state.models = [makeModel('a'), makeModel('b')]
    state.multiSelect.ids = ['a', 'b']
    api.models.deleteModel.mockImplementation((id) =>
      id === 'a'
        ? Promise.resolve({ ok: true })
        : Promise.resolve({ error: '文件被占用' }),
    )
    const p = batchDeleteModels()
    acceptConfirm()
    await p
    expect(state.models.map((m) => m.id)).toEqual(['b'])
    expect(state.multiSelect.ids).toEqual(['b'])
    expect(
      state.toasts.some((t) => t.text.includes('成功 1 个，失败 1 个')),
    ).toBe(true)
  })

  it('批量删除：确认取消时不调用删除 IPC', async () => {
    state.models = [makeModel('a')]
    state.multiSelect.ids = ['a']
    const p = batchDeleteModels()
    rejectConfirm()
    await p
    expect(api.models.deleteModel).not.toHaveBeenCalled()
    expect(state.models).toHaveLength(1)
  })

  it('批量提交在途时连点被拦截：不重复发起 IPC（B6 in-flight 防护）', async () => {
    state.models = [makeModel('a'), makeModel('b')]
    state.multiSelect.ids = ['a', 'b']
    state.multiSelect.busy = false
    // 两个模型的 IPC 各自挂起：逐一收集 resolve（单个变量会被后一次调用覆盖）
    const resolvers = []
    api.models.setMetaFlags.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve)
        }),
    )

    const first = batchFavorite(true) // 不 await：构造在途窗口（busy 同步置位）
    const second = batchFavorite(true) // 在途期间的连点：必须被 busy 拦截
    await second

    // 仅第一批 2 个 IPC（每模型一个）；连点不得把同一批再提交一遍
    expect(api.models.setMetaFlags).toHaveBeenCalledTimes(2)
    expect(state.multiSelect.busy).toBe(true) // 首批在途，按钮应保持禁用

    for (const resolve of resolvers)
      resolve({ meta: { favorite: true, nsfw: false, rating: 0 } })
    await first
    expect(state.multiSelect.busy).toBe(false) // 完成后恢复可用
    expect(state.models.map((m) => m.favorite)).toEqual([true, true])
  })

  it('批量删除在途（含确认层弹出）时连点不重复提交', async () => {
    state.models = [makeModel('a')]
    state.multiSelect.ids = ['a']
    state.multiSelect.busy = false
    let release = () => {}
    api.models.deleteModel.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true })
        }),
    )

    const first = batchDeleteModels()
    // 确认层已弹出但删除 IPC 尚未发出：busy 已置位，连点直接拦截
    const second = await batchDeleteModels()
    expect(second).toBeUndefined()
    expect(state.multiSelect.busy).toBe(true)

    acceptConfirm() // 通过第一个（已在途的）确认层
    await new Promise((resolve) => setTimeout(resolve, 0))
    release()
    await first
    expect(api.models.deleteModel).toHaveBeenCalledTimes(1)
    expect(state.models).toHaveLength(0)
    expect(state.multiSelect.busy).toBe(false)
  })

  it('批量填入自动触发词（F3）：仅填空触发词且有候选的模型，绝不覆盖已有标注', async () => {
    state.models = [
      makeModel('fresh', {
        autoInfo: { triggerCandidates: ['tag-a', 'tag-b'] },
      }),
      makeModel('owned', {
        triggerWords: '已有词',
        autoInfo: { triggerCandidates: ['tag-x'] },
      }),
      makeModel('nocand', { autoInfo: null }),
    ]
    state.multiSelect.ids = ['fresh', 'owned', 'nocand']
    api.models.saveModelData.mockImplementation(({ triggerWords }) =>
      Promise.resolve({ meta: { triggerWords, triggerWordsSource: '' } }),
    )

    await batchApplyTriggers()

    // 仅对「fresh」发起保存：已有触发词与无候选的模型跳过
    expect(api.models.saveModelData).toHaveBeenCalledTimes(1)
    expect(api.models.saveModelData.mock.calls[0][0]).toEqual({
      id: 'fresh',
      triggerWords: 'tag-a, tag-b',
    })
    // 本地列表同步填入结果，其余模型不受影响
    expect(state.models[0].triggerWords).toBe('tag-a, tag-b')
    expect(state.models[1].triggerWords).toBe('已有词')
    expect(
      state.toasts.some(
        (t) =>
          t.type === 'success' && t.text.includes('已为 1 个模型填入触发词'),
      ),
    ).toBe(true)
    expect(
      state.toasts.some((t) => t.text.includes('2 个已有触发词或无候选')),
    ).toBe(true)
  })

  it('批量填入触发词按统一限流执行：同时在途 IPC 不超过上限', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `t${i}`)
    state.models = ids.map((id) =>
      makeModel(id, {
        autoInfo: { triggerCandidates: ['tag'] },
        triggerWords: '',
      }),
    )
    state.multiSelect.ids = ids
    let inFlight = 0
    let maxInFlight = 0
    api.models.saveModelData.mockImplementation(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return { meta: { triggerWords: 'tag', triggerWordsSource: 'civitai' } }
    })

    await batchApplyTriggers()

    expect(api.models.saveModelData).toHaveBeenCalledTimes(40)
    expect(maxInFlight).toBeGreaterThan(0)
    expect(maxInFlight).toBeLessThanOrEqual(16)
  })

  it('批量填入触发词：选中模型全部无可填时提示且零 IPC', async () => {
    state.models = [makeModel('owned', { triggerWords: 'x' })]
    state.multiSelect.ids = ['owned']
    await batchApplyTriggers()
    expect(api.models.saveModelData).not.toHaveBeenCalled()
    expect(
      state.toasts.some((t) => t.text.includes('均已有触发词或无自动解析候选')),
    ).toBe(true)
  })

  it('批量 Civitai 识别：串行逐个调用，未收录不算失败，civitaiUrl 单趟同步', async () => {
    state.models = [makeModel('a'), makeModel('b'), makeModel('c')]
    state.multiSelect.ids = ['a', 'b', 'c']
    api.models.civitaiIdentify.mockImplementation((id) => {
      if (id === 'a')
        return Promise.resolve({
          found: true,
          meta: { civitaiUrl: 'https://civitai.com/models/1' },
        })
      if (id === 'b') return Promise.resolve({ found: false })
      return Promise.reject(new Error('网络断开'))
    })
    await batchCivitaiIdentify()
    // 逐个串行调用（而非并发）
    expect(api.models.civitaiIdentify).toHaveBeenCalledTimes(3)
    expect(api.models.civitaiIdentify.mock.calls.map((c) => c[0])).toEqual([
      'a',
      'b',
      'c',
    ])
    // 识别成功者同步 civitaiUrl，未收录/失败者保持空串
    expect(state.models[0].civitaiUrl).toBe('https://civitai.com/models/1')
    expect(state.models[1].civitaiUrl).toBeUndefined()
    expect(state.models[2].civitaiUrl).toBeUndefined()
    // 汇总提示含未收录与失败统计
    expect(
      state.toasts.some(
        (t) => t.type === 'warn' && t.text.includes('成功 1 个'),
      ),
    ).toBe(true)
    expect(state.toasts.some((t) => t.text.includes('未收录 1 个'))).toBe(true)
    expect(state.toasts.some((t) => t.text.includes('失败 1 个'))).toBe(true)
    // 批量结束后忙碌与进度复位
    expect(state.multiSelect.busy).toBe(false)
    expect(state.multiSelect.progress).toBe('')
  })

  it('批量 Civitai 识别：识别期间更新逐个进度文案', async () => {
    state.models = [makeModel('a'), makeModel('b')]
    state.multiSelect.ids = ['a', 'b']
    const seen = []
    api.models.civitaiIdentify.mockImplementation(() => {
      seen.push(state.multiSelect.progress)
      return Promise.resolve({ found: false })
    })
    await batchCivitaiIdentify()
    expect(seen).toEqual(['识别中 1/2：a', '识别中 2/2：b'])
  })

  it('批量获取示例图：仅处理无封面模型，取前 4 张并同步封面状态', async () => {
    const coversRsp = {
      cover: 'D:\\m\\.modelvault\\covers\\1.png',
      coverUrl: 'mvimg:///1.png',
      covers: [
        { rel: 'covers/1.png', path: 'D:\\m\\1.png', url: 'mvimg:///1.png' },
      ],
    }
    state.models = [
      makeModel('nocover'),
      makeModel('hascover', {
        hasManualCover: true,
        covers: [{ rel: 'covers/x.png' }],
      }),
    ]
    state.multiSelect.ids = ['nocover', 'hascover']
    api.models.civitaiIdentify.mockImplementation((id) =>
      id === 'nocover'
        ? Promise.resolve({
            found: true,
            meta: { civitaiUrl: 'https://civitai.com/models/9' },
            info: {
              images: [
                { url: 'u1' },
                { url: 'u2' },
                { url: 'u3' },
                { url: 'u4' },
                { url: 'u5' },
                { url: 'u6' },
              ],
            },
          })
        : Promise.resolve({ found: false }),
    )
    api.models.civitaiImportImages.mockResolvedValue({ added: 4, ...coversRsp })

    await batchCivitaiImages()

    // 已有封面的模型完全跳过（识别与导入均不调用）
    expect(api.models.civitaiIdentify).toHaveBeenCalledTimes(1)
    expect(api.models.civitaiIdentify).toHaveBeenCalledWith('nocover')
    // 单模型最多取前 4 张（BATCH_CIVITAI_IMAGES_PER_MODEL）
    expect(api.models.civitaiImportImages).toHaveBeenCalledTimes(1)
    expect(api.models.civitaiImportImages).toHaveBeenCalledWith('nocover', [
      { url: 'u1' },
      { url: 'u2' },
      { url: 'u3' },
      { url: 'u4' },
    ])
    // 封面结果与 civitaiUrl 同步到本地列表
    const m = state.models.find((mm) => mm.id === 'nocover')
    expect(m.hasManualCover).toBe(true)
    expect(m.cover).toBe(coversRsp.cover)
    expect(m.covers).toEqual(coversRsp.covers)
    expect(m.civitaiUrl).toBe('https://civitai.com/models/9')
    expect(
      state.toasts.some(
        (t) =>
          t.type === 'success' &&
          t.text.includes('已为 1 个模型添加共 4 张示例图'),
      ),
    ).toBe(true)
    expect(
      state.toasts.some((t) => t.text.includes('已有示例图跳过 1 个')),
    ).toBe(true)
  })

  it('批量获取示例图：选中模型均已有封面时提示且零 IPC', async () => {
    state.models = [
      makeModel('a', {
        hasManualCover: true,
        covers: [{ rel: 'covers/a.png' }],
      }),
    ]
    state.multiSelect.ids = ['a']
    await batchCivitaiImages()
    expect(api.models.civitaiIdentify).not.toHaveBeenCalled()
    expect(api.models.civitaiImportImages).not.toHaveBeenCalled()
    expect(state.toasts.some((t) => t.text.includes('均已有示例图'))).toBe(true)
  })
})

describe('批量取消（Esc 请求取消，串行批量提前收尾）', () => {
  it('requestBatchCancel 仅在 busy 期间置位', () => {
    state.multiSelect.busy = false
    requestBatchCancel()
    expect(state.multiSelect.cancelRequested).toBe(false)
    state.multiSelect.busy = true
    requestBatchCancel()
    expect(state.multiSelect.cancelRequested).toBe(true)
  })

  it('批量禁用进行中请求取消：循环提前收尾、标志位 finally 复位、提示已完成数', async () => {
    state.models = [makeModel('a'), makeModel('b'), makeModel('c')]
    state.multiSelect.ids = ['a', 'b', 'c']
    state.multiSelect.busy = false
    state.scanning = true // 跳过禁用后的整表重扫（该链路由 scanner/watcher 测试覆盖）
    let calls = 0
    api.models.toggleDisabled.mockImplementation(() => {
      calls += 1
      if (calls === 1) requestBatchCancel() // 第一个完成后按 Esc 请求取消（busy 已置位的真实路径）
      return Promise.resolve({ ok: true })
    })

    await batchToggleDisabled(true)

    expect(calls).toBe(1) // 第二轮循环顶部检查取消标志，提前 break
    expect(state.multiSelect.busy).toBe(false)
    expect(state.multiSelect.cancelRequested).toBe(false)
    expect(
      state.toasts.some((t) => t.text.includes('已取消（完成 1/3）')),
    ).toBe(true)
  })

  it('批量识别进行中请求取消：已完成部分保存并提示进度', async () => {
    state.models = [makeModel('a'), makeModel('b'), makeModel('c')]
    state.multiSelect.ids = ['a', 'b', 'c']
    let calls = 0
    api.models.civitaiIdentify.mockImplementation(() => {
      calls += 1
      if (calls === 2) requestBatchCancel() // 识别完第二个后请求取消
      return Promise.resolve({
        found: true,
        meta: { civitaiUrl: 'https://civitai.com/models/x' },
      })
    })

    await batchCivitaiIdentify()

    expect(calls).toBe(2)
    expect(state.multiSelect.cancelRequested).toBe(false)
    expect(
      state.toasts.some((t) => t.text.includes('识别已取消（完成 2/3）')),
    ).toBe(true)
    // 已识别部分已保存：a/b 的 civitaiUrl 已写入
    expect(state.models.find((m) => m.id === 'a').civitaiUrl).toBe(
      'https://civitai.com/models/x',
    )
    expect(state.models.find((m) => m.id === 'b').civitaiUrl).toBe(
      'https://civitai.com/models/x',
    )
  })

  it('并发批量（批量收藏）进行中请求取消：批量照常完成，结束后标志位复位（A3）', async () => {
    state.models = [makeModel('a'), makeModel('b')]
    state.multiSelect.ids = ['a', 'b']
    state.multiSelect.busy = false
    api.models.setMetaFlags.mockImplementation(async () => {
      requestBatchCancel() // 并发型批量进行中按 Esc：置位但不响应
      return { meta: { favorite: true, nsfw: false, rating: 0 } }
    })

    await batchFavorite(true)

    expect(api.models.setMetaFlags).toHaveBeenCalledTimes(2)
    // finally 统一复位：取消意图不得跨批量泄漏（A3 毒化根因）
    expect(state.multiSelect.cancelRequested).toBe(false)
  })

  it('并发批量期间 Esc 不毒化后续串行批量（A3 回归）', async () => {
    state.models = [makeModel('a'), makeModel('b')]
    state.multiSelect.ids = ['a', 'b']
    api.models.setMetaFlags.mockImplementation(async () => {
      requestBatchCancel()
      return { meta: { favorite: true, nsfw: false, rating: 0 } }
    })
    await batchFavorite(true)

    // 修复前：遗留的 cancelRequested 使禁用批量首轮即收尾（「已取消（完成 0/2）」）
    state.scanning = true // 跳过禁用后的整表重扫（该链路由 scanner/watcher 测试覆盖）
    api.models.toggleDisabled.mockResolvedValue({ ok: true })
    await batchToggleDisabled(true)

    expect(api.models.toggleDisabled).toHaveBeenCalledTimes(2)
    expect(state.toasts.some((t) => t.text.includes('已禁用 2 个模型'))).toBe(
      true,
    )
  })

  it('批量删除（并发型）进行中请求取消：照常完成且结束后标志位复位（A3）', async () => {
    state.models = [makeModel('a'), makeModel('b')]
    state.multiSelect.ids = ['a', 'b']
    state.multiSelect.busy = false
    api.models.deleteModel.mockResolvedValue({ ok: true })
    const p = batchDeleteModels()
    acceptConfirm() // 确认层通过后进入并发删除
    requestBatchCancel() // 删除进行中按 Esc（置位但不响应）
    await p

    expect(api.models.deleteModel).toHaveBeenCalledTimes(2)
    expect(state.multiSelect.cancelRequested).toBe(false)
  })
})
