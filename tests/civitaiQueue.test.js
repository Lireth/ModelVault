import { describe, it, expect, beforeEach } from 'vitest'
import {
  acceptConfirm,
  cancelCivitaiQueue,
  rejectConfirm,
  replaceModels,
  startCivitaiQueue,
  state,
  unidentifiedCivitaiCount,
} from '../src/renderer/src/store/appStore'
import {
  makeApiMock,
  resetStoreTestState,
  makeModel,
} from './helpers/storeTest'

/**
 * 全库 Civitai 批量识别队列测试（FEAT-9）：
 * - 守卫：无库/Civitai 关闭/全部已识别/队列在途——不弹确认、不发请求
 * - 正常执行：仅未识别目标被请求（fillMissing=true 第二参）、识别结果
 *   就地同步（civitaiUrl/触发词/备注，本地 baseModel 优先）、计数与汇总 toast
 * - 未收录（found=false）：计入 notFound 且模型不改动
 * - 取消：cancelRequested 置位后下一轮收尾，warn toast，已完成部分保留
 * - 连续失败熔断：连续 8 个失败中止整队，error toast，剩余目标不再请求
 * - 陈旧目标：队列在途切库（列表整体替换）后剩余 id 直接跳过零 IPC
 * - unidentifiedCivitaiCount 派生随识别结果收敛
 */

let api

beforeEach(() => {
  api = makeApiMock()
  resetStoreTestState(api)
  state.folder = 'D:\\lib'
})

/** 种子三个模型：a/b 未识别，c 已有链接 */
function seedModels() {
  replaceModels([
    makeModel('a', { civitaiUrl: '' }),
    makeModel('b', { civitaiUrl: '' }),
    makeModel('c', { civitaiUrl: 'https://civitai.red/models/9' }),
  ])
}

/** 启动队列并通过确认层 */
function startAccepted() {
  const p = startCivitaiQueue()
  acceptConfirm()
  return p
}

describe('startCivitaiQueue 守卫', () => {
  it('无激活库/Civitai 关闭/全部已识别/在途重入：均不弹确认不发起请求', async () => {
    // 无激活库
    state.folder = ''
    await startCivitaiQueue()
    expect(state.confirm.visible).toBe(false)
    expect(api.models.civitaiIdentify).not.toHaveBeenCalled()

    // Civitai 功能关闭
    state.folder = 'D:\\lib'
    state.settings.civitaiEnabled = false
    seedModels()
    await startCivitaiQueue()
    expect(state.confirm.visible).toBe(false)
    state.settings.civitaiEnabled = true

    // 全部已识别
    replaceModels([makeModel('c', { civitaiUrl: 'u' })])
    await startCivitaiQueue()
    expect(state.confirm.visible).toBe(false)

    // 队列在途重入
    seedModels()
    state.civitaiQueue.running = true
    await startCivitaiQueue()
    expect(state.confirm.visible).toBe(false)
    expect(api.models.civitaiIdentify).not.toHaveBeenCalled()
  })

  it('确认取消时不启动队列', async () => {
    seedModels()
    const p = startCivitaiQueue()
    expect(state.confirm.visible).toBe(true)
    rejectConfirm()
    await p
    expect(api.models.civitaiIdentify).not.toHaveBeenCalled()
    expect(state.civitaiQueue.running).toBe(false)
  })
})

describe('startCivitaiQueue 正常执行', () => {
  it('仅未识别目标被请求（fillMissing=true），结果就地同步并汇总', async () => {
    seedModels()
    api.models.civitaiIdentify.mockImplementation((id, fillMissing) =>
      Promise.resolve({
        found: true,
        applied: fillMissing ? ['triggerWords'] : [],
        meta: {
          civitaiUrl: `https://civitai.red/models/${id}`,
          baseModel: 'SDXL',
          triggerWords: 'tw',
          note: '',
        },
      }),
    )
    await startAccepted()

    expect(api.models.civitaiIdentify).toHaveBeenCalledTimes(2)
    expect(api.models.civitaiIdentify).toHaveBeenCalledWith('a', true)
    expect(api.models.civitaiIdentify).toHaveBeenCalledWith('b', true)
    const ma = state.models.find((m) => m.id === 'a')
    expect(ma.civitaiUrl).toBe('https://civitai.red/models/a')
    expect(ma.triggerWords).toBe('tw')
    expect(ma.baseModel).toBe('SDXL')
    const q = state.civitaiQueue
    expect(q.running).toBe(false)
    expect(q).toMatchObject({ total: 2, done: 2, ok: 2, filled: 2, failed: 0 })
    expect(
      state.toasts.some(
        (t) => t.type === 'success' && t.text.includes('队列完成'),
      ),
    ).toBe(true)
  })

  it('本地已有 baseModel（autoInfo 解析值）不被识别值覆盖', async () => {
    replaceModels([makeModel('a', { civitaiUrl: '', baseModel: 'Pony' })])
    api.models.civitaiIdentify.mockResolvedValue({
      found: true,
      applied: [],
      meta: { civitaiUrl: 'u', baseModel: 'SDXL', triggerWords: '', note: '' },
    })
    await startAccepted()
    expect(state.models[0].baseModel).toBe('Pony')
    expect(state.civitaiQueue.filled).toBe(0)
  })

  it('未收录（found=false）计入 notFound 且模型不改动', async () => {
    seedModels()
    api.models.civitaiIdentify
      .mockResolvedValueOnce({ found: false })
      .mockResolvedValueOnce({
        found: true,
        applied: ['note'],
        meta: { civitaiUrl: 'u-b', baseModel: '', triggerWords: '', note: 'n' },
      })
    await startAccepted()
    const q = state.civitaiQueue
    expect(q).toMatchObject({ ok: 1, notFound: 1, filled: 1, failed: 0 })
    expect(state.models.find((m) => m.id === 'a').civitaiUrl).toBe('')
  })
})

describe('startCivitaiQueue 取消与熔断', () => {
  it('cancelRequested 置位后收尾：warn toast，已完成部分保留', async () => {
    seedModels()
    api.models.civitaiIdentify.mockImplementationOnce(() =>
      Promise.resolve().then(() => {
        state.civitaiQueue.cancelRequested = true
        return {
          found: true,
          applied: [],
          meta: {
            civitaiUrl: 'u-a',
            baseModel: '',
            triggerWords: '',
            note: '',
          },
        }
      }),
    )
    await startAccepted()
    const q = state.civitaiQueue
    expect(q.running).toBe(false)
    expect(q.done).toBe(1)
    expect(api.models.civitaiIdentify).toHaveBeenCalledTimes(1)
    expect(
      state.toasts.some((t) => t.type === 'warn' && t.text.includes('已取消')),
    ).toBe(true)
    // 已识别部分保留在列表中
    expect(state.models.find((m) => m.id === 'a').civitaiUrl).toBe('u-a')
  })

  it('cancelCivitaiQueue 仅在运行中置位取消标志', () => {
    expect(state.civitaiQueue.cancelRequested).toBe(false)
    cancelCivitaiQueue()
    expect(state.civitaiQueue.cancelRequested).toBe(false)
    state.civitaiQueue.running = true
    cancelCivitaiQueue()
    expect(state.civitaiQueue.cancelRequested).toBe(true)
  })

  it('连续 8 个失败熔断中止整队：error toast，剩余目标不再请求', async () => {
    replaceModels(
      Array.from({ length: 10 }, (_, i) =>
        makeModel(`m${i}`, { civitaiUrl: '' }),
      ),
    )
    api.models.civitaiIdentify.mockResolvedValue({ error: '网络请求失败' })
    await startAccepted()
    const q = state.civitaiQueue
    expect(api.models.civitaiIdentify).toHaveBeenCalledTimes(8)
    expect(q).toMatchObject({ failed: 8, done: 8, running: false })
    expect(
      state.toasts.some((t) => t.type === 'error' && t.text.includes('已中止')),
    ).toBe(true)
  })

  it('任一成功清零连续失败计数：不触发熔断', async () => {
    replaceModels(
      Array.from({ length: 3 }, (_, i) =>
        makeModel(`m${i}`, { civitaiUrl: '' }),
      ),
    )
    api.models.civitaiIdentify
      .mockResolvedValueOnce({ error: '抖动' })
      .mockResolvedValueOnce({
        found: false,
      })
      .mockResolvedValueOnce({ error: '抖动' })
    await startAccepted()
    expect(state.civitaiQueue).toMatchObject({
      failed: 2,
      notFound: 1,
      done: 3,
    })
    expect(
      state.toasts.some(
        (t) => t.type === 'warn' && t.text.includes('队列完成'),
      ),
    ).toBe(true)
  })

  it('队列在途切库：脱离列表的陈旧目标直接跳过零请求', async () => {
    seedModels()
    api.models.civitaiIdentify.mockImplementationOnce(() => {
      // 模拟首项请求在途期间用户切库（列表整体替换）
      replaceModels([makeModel('z', { civitaiUrl: '' })])
      return Promise.resolve({ found: false })
    })
    await startAccepted()
    const q = state.civitaiQueue
    expect(api.models.civitaiIdentify).toHaveBeenCalledTimes(1)
    expect(q.done).toBe(2)
    expect(q.notFound).toBe(1)
  })
})

describe('unidentifiedCivitaiCount 派生', () => {
  it('随识别结果收敛：命中减计数、未收录不计数变化', async () => {
    seedModels()
    expect(unidentifiedCivitaiCount.value).toBe(2)
    api.models.civitaiIdentify
      .mockResolvedValueOnce({
        found: true,
        applied: [],
        meta: { civitaiUrl: 'u-a', baseModel: '', triggerWords: '', note: '' },
      })
      .mockResolvedValueOnce({ found: false })
    await startAccepted()
    expect(unidentifiedCivitaiCount.value).toBe(1)
  })
})
