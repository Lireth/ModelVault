import { describe, it, expect, beforeEach } from 'vitest'
import {
  makeApiMock,
  resetStoreTestState,
  makeModel,
} from './helpers/storeTest'
import {
  clearAllCovers,
  importCoversFromDrop,
  replaceModels,
  selectedModel,
  state,
} from '../src/renderer/src/store/appStore'

/**
 * appStoreCovers.test.js（ENG-1 自 appStore.test.js 按域拆分，用例内容保持原样）
 */

let api

beforeEach(() => {
  api = makeApiMock()
  resetStoreTestState(api)
})

describe('清空全部示例图（OPT-01）', () => {
  it('成功后以元素级替换同步列表，派生查找立即回退且不重扫', async () => {
    replaceModels([
      makeModel('m1', {
        cover: 'covers/a.png',
        coverUrl: 'mvimg://local/covers/a.png',
        covers: [
          {
            rel: 'covers/a.png',
            path: 'D:\\models\\.modelvault\\covers\\a.png',
            url: 'mvimg://local/covers/a.png',
          },
        ],
        hasManualCover: true,
      }),
      makeModel('m2', {
        cover: 'covers/b.png',
        coverUrl: 'mvimg://local/covers/b.png',
        covers: [
          {
            rel: 'covers/b.png',
            path: 'D:\\models\\.modelvault\\covers\\b.png',
            url: 'mvimg://local/covers/b.png',
          },
        ],
        hasManualCover: true,
      }),
    ])
    state.selectedId = 'm1'
    const before = state.models[0]
    api.models.clearAllCovers.mockResolvedValue({ cleared: 2, images: 2 })

    const ok = await clearAllCovers()

    expect(ok).toBe(true)
    // 浅响应数组的元素必须被替换，才能触发依赖其索引的派生状态
    expect(state.models[0]).not.toBe(before)
    for (const m of state.models) {
      expect(m.cover).toBe('')
      expect(m.coverUrl).toBe('')
      expect(m.covers).toEqual([])
      expect(m.hasManualCover).toBe(false)
    }
    // selectedModel 经 modelById 读取到新引用，详情页立即回退占位图
    expect(selectedModel.value?.coverUrl).toBe('')
    expect(state.toasts.at(-1)).toMatchObject({ type: 'success' })
  })
})

describe('批量拖拽导入封面（OPT-9）', () => {
  /** 构造 importCover IPC 的成功响应（covers 为最新完整列表） */
  function coverRes(n) {
    return {
      cover: `abs-${n}`,
      coverUrl: `url-${n}`,
      covers: Array.from({ length: n }, (_, i) => ({
        rel: `c${i + 1}`,
        path: `p${i + 1}`,
        url: `u${i + 1}`,
      })),
      meta: {},
    }
  }

  it('多文件：逐文件串行 IPC，末尾单趟应用最终封面列表', async () => {
    state.models = [makeModel('m1', { covers: [] })]
    let call = 0
    api.models.importCover.mockImplementation(() => {
      call += 1
      return Promise.resolve(coverRes(call))
    })
    const res = await importCoversFromDrop('m1', ['a.png', 'b.png', 'c.png'])
    expect(api.models.importCover).toHaveBeenCalledTimes(3)
    expect(res).toMatchObject({ ok: true, total: 3, failed: 0 })
    // 最后一次响应即包含全部 3 张封面
    expect(state.models[0].covers).toHaveLength(3)
    expect(state.models[0].coverUrl).toBe('url-3')
    expect(state.models[0].hasManualCover).toBe(true)
    // store 内不逐条弹 toast（汇总提示交由调用方）
    expect(state.toasts).toHaveLength(0)
  })

  it('单张业务失败不中断其余：失败计数入 errors，成功张仍应用', async () => {
    state.models = [makeModel('m1', { covers: [] })]
    api.models.importCover.mockImplementation((id, path) =>
      path === 'bad.png'
        ? Promise.resolve({ error: '文件内容不是有效的图片，已拒绝导入' })
        : Promise.resolve(coverRes(1)),
    )
    const res = await importCoversFromDrop('m1', [
      'ok1.png',
      'bad.png',
      'ok2.png',
    ])
    expect(api.models.importCover).toHaveBeenCalledTimes(3)
    expect(res.ok).toBe(true)
    expect(res.total).toBe(3)
    expect(res.failed).toBe(1)
    expect(res.errors[0]).toContain('不是有效的图片')
    expect(state.models[0].covers).toHaveLength(1)
    expect(state.toasts).toHaveLength(0)
  })

  it('IPC reject 同样计入失败且不中断后续文件', async () => {
    state.models = [makeModel('m1', { covers: [] })]
    api.models.importCover.mockImplementation((id, path) =>
      path === 'boom.png'
        ? Promise.reject(new Error('通道异常'))
        : Promise.resolve(coverRes(1)),
    )
    const res = await importCoversFromDrop('m1', ['boom.png', 'ok.png'])
    expect(res.failed).toBe(1)
    expect(res.errors[0]).toBe('通道异常')
    expect(state.models[0].covers).toHaveLength(1)
  })

  it('全部失败时不应用任何状态', async () => {
    state.models = [makeModel('m1', { covers: [] })]
    api.models.importCover.mockResolvedValue({ error: '不支持的格式' })
    const res = await importCoversFromDrop('m1', ['a.png', 'b.png'])
    expect(res.ok).toBe(false)
    expect(res.failed).toBe(2)
    expect(state.models[0].covers).toHaveLength(0)
  })

  it('空列表/非法输入：不调用 IPC，返回零值', async () => {
    const res = await importCoversFromDrop('m1', [])
    expect(res).toEqual({ ok: false, total: 0, failed: 0, errors: [] })
    const res2 = await importCoversFromDrop('m1', null)
    expect(res2.total).toBe(0)
    expect(api.models.importCover).not.toHaveBeenCalled()
  })
})
