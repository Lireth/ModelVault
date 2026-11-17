import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  replaceModels,
  selectedModel,
  state,
} from '../src/renderer/src/store/appStore'
import {
  makeApiMock,
  resetStoreTestState,
  makeModel,
} from './helpers/storeTest'

/**
 * 详情字段按需补全链路（store/detail.js enrichSelectedModel，issue #76）：
 * - 正常成功路径：瘦身元素经 models:getDetail 整体替换为完整对象（detailFull）
 * - 在途 replaceModels 整体替换选中元素后，请求时刻的旧主进程快照不得
 *   覆盖更新后的瘦身元素，且须释放防重入占位补跑一次（对应被吞掉的二次
 *   watch 触发）
 * - 在途元素被移除（切库）/替换后的新元素已带 detailFull：不写入不补跑
 * - 响应 error 静默降级：元素保持瘦身
 */

let api

beforeEach(() => {
  api = makeApiMock()
  api.models.getDetail = vi.fn()
  resetStoreTestState(api)
  state.folder = 'D:\\lib'
})

/** 手工控制 IPC 响应时序 */
function deferred() {
  let resolve
  const promise = new Promise((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** 等待 pre-flush watcher 与异步补全链就绪 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('enrichSelectedModel 基本路径', () => {
  it('瘦身元素选中即补全：整体替换为完整对象并标记 detailFull，仅一次 IPC', async () => {
    api.models.getDetail.mockResolvedValue({
      model: {
        ...makeModel('m1'),
        note: 'full',
        autoInfo: { networkModule: 'LoRA' },
      },
    })
    replaceModels([makeModel('m1')])
    state.selectedId = 'm1'
    await flush()

    expect(api.models.getDetail).toHaveBeenCalledTimes(1)
    expect(api.models.getDetail).toHaveBeenCalledWith('m1')
    expect(state.models[0]).toMatchObject({
      detailFull: true,
      note: 'full',
      autoInfo: { networkModule: 'LoRA' },
    })
    expect(selectedModel.value?.detailFull).toBe(true)
  })

  it('响应 error 静默降级：元素保持瘦身且不重发', async () => {
    api.models.getDetail.mockResolvedValue({ error: 'boom' })
    replaceModels([makeModel('m1')])
    state.selectedId = 'm1'
    await flush()

    expect(api.models.getDetail).toHaveBeenCalledTimes(1)
    expect(state.models[0].note).toBe('')
    expect(state.models[0].detailFull).toBeUndefined()
  })

  it('已带 detailFull 的元素选中不发起补全', async () => {
    replaceModels([makeModel('m1', { detailFull: true })])
    state.selectedId = 'm1'
    await flush()

    expect(api.models.getDetail).not.toHaveBeenCalled()
  })
})

describe('enrichSelectedModel 在途 replaceModels（issue #76）', () => {
  it('在途替换元素：旧主进程快照不覆盖新元素，占位释放后补跑并写入新响应', async () => {
    const d1 = deferred()
    const d2 = deferred()
    const queue = [d1, d2]
    api.models.getDetail.mockImplementation(() => queue.shift().promise)
    replaceModels([makeModel('m1', { name: 'slim' })])
    state.selectedId = 'm1'
    await flush()
    expect(api.models.getDetail).toHaveBeenCalledTimes(1)

    // 后台校验/局部扫描整体替换选中元素：重新装饰的瘦身对象，detailFull 丢失
    replaceModels([makeModel('m1', { name: 'reslimmed', note: 'new-decor' })])
    await flush()
    // 引用变化触发的二次 watch 被防重入集合吞掉：此刻仍只有请求 #1 在途
    expect(api.models.getDetail).toHaveBeenCalledTimes(1)

    // 请求 #1（请求时刻的旧快照）返回：不得覆盖新元素，并触发补跑
    d1.resolve({
      model: makeModel('m1', { name: 'stale-snapshot', note: 'stale' }),
    })
    await flush()
    expect(state.models[0].name).toBe('reslimmed')
    expect(state.models[0].note).toBe('new-decor')
    expect(state.models[0].detailFull).toBeUndefined()
    expect(api.models.getDetail).toHaveBeenCalledTimes(2)

    // 补跑响应（主进程最新装饰结果）正常写入
    d2.resolve({
      model: makeModel('m1', { name: 'fresh', note: 'fresh-decor' }),
    })
    await flush()
    expect(state.models[0]).toMatchObject({
      name: 'fresh',
      note: 'fresh-decor',
      detailFull: true,
    })
    expect(api.models.getDetail).toHaveBeenCalledTimes(2)
  })

  it('在途元素被移除（切库）：旧响应不写入也不补跑', async () => {
    const d1 = deferred()
    api.models.getDetail.mockReturnValue(d1.promise)
    replaceModels([makeModel('m1')])
    state.selectedId = 'm1'
    await flush()
    expect(api.models.getDetail).toHaveBeenCalledTimes(1)

    replaceModels([])
    d1.resolve({ model: makeModel('m1', { name: 'stale' }) })
    await flush()

    expect(api.models.getDetail).toHaveBeenCalledTimes(1)
    expect(state.models).toHaveLength(0)
  })

  it('在途替换后的新元素已带 detailFull：旧响应不覆盖也不补跑', async () => {
    const d1 = deferred()
    api.models.getDetail.mockReturnValue(d1.promise)
    replaceModels([makeModel('m1', { name: 'slim' })])
    state.selectedId = 'm1'
    await flush()
    expect(api.models.getDetail).toHaveBeenCalledTimes(1)

    replaceModels([makeModel('m1', { name: 'already-full', detailFull: true })])
    d1.resolve({ model: makeModel('m1', { name: 'stale' }) })
    await flush()

    expect(state.models[0].name).toBe('already-full')
    expect(state.models[0].detailFull).toBe(true)
    expect(api.models.getDetail).toHaveBeenCalledTimes(1)
  })
})
