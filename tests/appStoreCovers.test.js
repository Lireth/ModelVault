import { describe, it, expect, beforeEach } from 'vitest'
import {
  makeApiMock,
  resetStoreTestState,
  makeModel,
} from './helpers/storeTest'
import {
  clearAllCovers,
  clearCovers,
  deleteCover,
  importCoversFromDrop,
  pasteCover,
  replaceModels,
  saveModelData,
  selectedModel,
  setDefaultCover,
  state,
  uploadCover,
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

describe('封面操作链路（上传/粘贴/设默认/删除/清空）', () => {
  /** 主进程封面操作的标准成功响应（covers 为最新完整列表） */
  function coverRes(n = 1) {
    return {
      cover: `covers/c${n}.png`,
      coverUrl: `mvimg://local/covers/c${n}.png`,
      covers: Array.from({ length: n }, (_, i) => ({
        rel: `covers/c${i + 1}.png`,
        path: `p${i + 1}`,
        url: `u${i + 1}`,
      })),
      meta: {},
    }
  }
  function seedModel() {
    replaceModels([makeModel('m1', { covers: [] })])
    state.selectedId = 'm1'
  }

  it('uploadCover 成功：列表追加、默认封面与缩略图覆盖同步更新', async () => {
    seedModel()
    api.models.uploadCover.mockResolvedValue(coverRes(2))
    expect(await uploadCover('m1')).toBe(true)
    const m = state.models[0]
    expect(m.covers).toHaveLength(2)
    expect(m.cover).toBe('covers/c2.png')
    expect(m.hasManualCover).toBe(true)
    // OP-02：新 coverUrl 同步覆盖缩略图，卡片立即显示新封面
    expect(selectedModel.value.coverUrl).toBe('mvimg://local/covers/c2.png')
    expect(state.toasts.at(-1)).toMatchObject({ type: 'success' })
  })

  it('uploadCover 业务失败提示错误；用户取消静默返回', async () => {
    seedModel()
    api.models.uploadCover.mockResolvedValue({
      error: '文件内容不是有效的图片，已拒绝导入',
    })
    expect(await uploadCover('m1')).toBe(false)
    expect(state.toasts.at(-1)).toMatchObject({ type: 'error' })
    expect(state.models[0].covers).toHaveLength(0)

    state.toasts.splice(0)
    api.models.uploadCover.mockResolvedValue({ canceled: true })
    expect(await uploadCover('m1')).toBe(false)
    expect(state.toasts).toHaveLength(0)
  })

  it('pasteCover 成功与失败', async () => {
    seedModel()
    api.models.pasteCover.mockResolvedValue(coverRes(1))
    expect(await pasteCover('m1')).toBe(true)
    expect(state.models[0].cover).toBe('covers/c1.png')
    expect(state.toasts.at(-1).text).toContain('剪贴板')

    api.models.pasteCover.mockResolvedValue({ error: '剪贴板中没有图片' })
    expect(await pasteCover('m1')).toBe(false)
    expect(state.toasts.at(-1)).toMatchObject({ type: 'error' })
  })

  it('setDefaultCover 成功切换默认显示；失败提示且不改动列表', async () => {
    seedModel()
    api.models.setDefaultCover.mockResolvedValue(coverRes(3))
    expect(await setDefaultCover('m1', 'covers/c3.png')).toBe(true)
    expect(api.models.setDefaultCover).toHaveBeenCalledWith(
      'm1',
      'covers/c3.png',
    )
    expect(state.models[0].cover).toBe('covers/c3.png')

    api.models.setDefaultCover.mockResolvedValue({ error: '封面不存在' })
    expect(await setDefaultCover('m1', 'covers/gone.png')).toBe(false)
    expect(state.toasts.at(-1).text).toBe('封面不存在')
  })

  it('deleteCover 成功回退下一张封面；失败提示', async () => {
    seedModel()
    // 删除默认后主进程回退：响应携带剩余列表与新的默认封面
    api.models.deleteCover.mockResolvedValue(coverRes(1))
    expect(await deleteCover('m1', 'covers/c2.png')).toBe(true)
    expect(api.models.deleteCover).toHaveBeenCalledWith('m1', 'covers/c2.png')
    expect(state.models[0].covers).toHaveLength(1)
    expect(state.toasts.at(-1).text).toBe('封面已删除')

    api.models.deleteCover.mockResolvedValue({ error: '删除封面失败' })
    expect(await deleteCover('m1', 'covers/c1.png')).toBe(false)
    expect(state.toasts.at(-1)).toMatchObject({ type: 'error' })
  })

  it('clearCovers 成功清空单模型示例图；失败提示', async () => {
    seedModel()
    api.models.clearCovers.mockResolvedValue({
      cover: '',
      coverUrl: '',
      covers: [],
      meta: {},
    })
    expect(await clearCovers('m1')).toBe(true)
    const m = state.models[0]
    expect(m.covers).toEqual([])
    expect(m.cover).toBe('')
    expect(m.hasManualCover).toBe(false)
    // 一键移除全部示例图同步清掉失效缩略图覆盖（OP-02）
    expect(selectedModel.value.coverUrl).toBe('')
    expect(state.toasts.at(-1).text).toBe('已移除全部示例图')

    api.models.clearCovers.mockResolvedValue({ error: '清理失败' })
    expect(await clearCovers('m1')).toBe(false)
  })

  it('id 已不在列表（并发删除后）：跳过状态同步仍按成功提示', async () => {
    replaceModels([])
    api.models.deleteCover.mockResolvedValue(coverRes(1))
    expect(await deleteCover('gone', 'covers/c1.png')).toBe(true)
    expect(state.models).toHaveLength(0)
    expect(state.toasts.at(-1)).toMatchObject({ type: 'success' })
  })
})

describe('saveModelData 详情保存（covers-store）', () => {
  beforeEach(() => {
    replaceModels([makeModel('m1')])
  })

  it('成功后同步参数/备注/别名/子分类/触发词到本地列表', async () => {
    api.models.saveModelData.mockResolvedValue({
      meta: {
        params: { steps: 25 },
        note: '新备注',
        alias: '展示名',
        subCategory: 'role',
        triggerWords: 'kw',
      },
    })
    expect(
      await saveModelData('m1', {
        params: { steps: 25 },
        note: '新备注',
      }),
    ).toBe(true)
    const m = state.models[0]
    expect(m.note).toBe('新备注')
    expect(m.alias).toBe('展示名')
    expect(m.subCategory).toBe('role')
    expect(m.triggerWords).toBe('kw')
    expect(m.params).toEqual({ steps: 25 })
    expect(state.toasts.at(-1).text).toBe('参数已保存')
  })

  it('silent 模式（批量编辑）不弹成功提示', async () => {
    api.models.saveModelData.mockResolvedValue({ meta: {} })
    expect(await saveModelData('m1', { note: 'n' }, { silent: true })).toBe(
      true,
    )
    expect(state.toasts).toHaveLength(0)
  })

  it('业务失败与通道异常均提示错误并返回 false', async () => {
    api.models.saveModelData.mockResolvedValue({ error: '模型不存在' })
    expect(await saveModelData('m1', { note: 'n' })).toBe(false)
    expect(state.toasts.at(-1).text).toBe('模型不存在')

    api.models.saveModelData.mockRejectedValue(new Error('IPC 通道异常'))
    expect(await saveModelData('m1', { note: 'n' })).toBe(false)
    expect(state.toasts.at(-1).text).toContain('保存失败')
  })
})
