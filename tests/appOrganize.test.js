import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  acceptConfirm,
  bindGap,
  closeOrganize,
  createOrganizeFolder,
  moveIdsToDir,
  openOrganize,
  renameOrganizeFolder,
  resetViews,
  setOrganizeTargetDir,
  state
} from '../src/renderer/src/store/appStore'

/**
 * B-06 应用内整理渲染层 store 测试：
 * 打开加载目录/缺口、移动确认与列表联动、重命名局部刷新与筛选平移、
 * 手动绑定替换条目、错误分支提示。
 */

function makeApi() {
  return {
    models: {
      listDirs: vi.fn(() => Promise.resolve({ dirs: ['', 'lora'] })),
      metaGaps: vi.fn(() => Promise.resolve({ orphans: [], newcomers: [] })),
      createFolder: vi.fn(),
      renameFolder: vi.fn(),
      partialScan: vi.fn(() => Promise.resolve({ models: [], dirs: [], relinked: 0 })),
      moveModels: vi.fn(),
      bindMeta: vi.fn()
    }
  }
}

let api

beforeEach(() => {
  api = makeApi()
  vi.stubGlobal('window', { api })
  state.folder = 'D:\\models'
  state.scanning = false
  state.models = []
  state.multiSelect = { active: false, ids: [] }
  state.selectedId = null
  state.organize = {
    open: false,
    busy: false,
    dirs: [],
    targetDir: '',
    pendingIds: [],
    gapsLoading: false,
    orphans: [],
    newcomers: []
  }
  state.toasts.splice(0, state.toasts.length)
  if (state.confirm.resolve) state.confirm.resolve(false)
  state.confirm = { visible: false, text: '', resolve: null }
  resetViews()
})

function makeModel(id, relDir) {
  return { id, name: id, type: 'lora', relDir, size: 1, mtimeMs: 1 }
}

describe('openOrganize 面板初始化', () => {
  it('打开面板并加载目录与缺口数据，带入选中模型', async () => {
    await openOrganize(['m1', 'm2'])
    expect(state.organize.open).toBe(true)
    expect(state.organize.pendingIds).toEqual(['m1', 'm2'])
    expect(state.organize.dirs).toEqual(['', 'lora'])
    expect(api.models.listDirs).toHaveBeenCalledTimes(1)
    expect(api.models.metaGaps).toHaveBeenCalled()
  })

  it('setOrganizeTargetDir / closeOrganize 更新状态并清空待移动清单', async () => {
    await openOrganize(['m1'])
    setOrganizeTargetDir('lora')
    expect(state.organize.targetDir).toBe('lora')
    closeOrganize()
    expect(state.organize.open).toBe(false)
    expect(state.organize.pendingIds).toEqual([])
  })
})

describe('createOrganizeFolder 新建文件夹', () => {
  it('成功时调用 IPC 并刷新目录列表', async () => {
    api.models.createFolder.mockResolvedValue({ ok: true, dir: 'a/b' })
    const ok = await createOrganizeFolder({ parentDir: 'a', name: 'b' })
    expect(ok).toBe(true)
    expect(api.models.createFolder).toHaveBeenCalledWith('a/b')
    expect(api.models.listDirs).toHaveBeenCalled()
  })
  it('主进程返回 error 时失败并提示', async () => {
    api.models.createFolder.mockResolvedValue({ error: '非法名称' })
    const ok = await createOrganizeFolder({ parentDir: '', name: 'b?' })
    expect(ok).toBe(false)
  })
})

describe('renameOrganizeFolder 重命名文件夹', () => {
  it('成功后局部扫描新旧子树并刷新目录', async () => {
    api.models.renameFolder.mockResolvedValue({ ok: true, oldDir: 'lora', newDir: 'loras', moved: 2 })
    const ok = await renameOrganizeFolder({ dir: 'lora', newName: 'loras' })
    expect(ok).toBe(true)
    expect(api.models.renameFolder).toHaveBeenCalledWith('lora', 'loras')
    expect(api.models.partialScan).toHaveBeenCalledWith({
      folder: 'D:\\models',
      dirs: ['lora', 'loras']
    })
  })

  it('目标正是被重命名目录本身时目标平移到新路径', async () => {
    state.organize.targetDir = 'lora'
    api.models.renameFolder.mockResolvedValue({ ok: true, oldDir: 'lora', newDir: 'loras', moved: 0 })
    await renameOrganizeFolder({ dir: 'lora', newName: 'loras' })
    expect(state.organize.targetDir).toBe('loras')
  })
})

describe('moveIdsToDir / movePendingToTarget 模型移动', () => {
  it('空列表与扫描中直接拒绝，不弹确认不发 IPC', async () => {
    expect(await moveIdsToDir([], 'lora')).toBe(false)
    state.scanning = true
    expect(await moveIdsToDir(['m1'], 'lora')).toBe(false)
    expect(api.models.moveModels).not.toHaveBeenCalled()
    expect(state.confirm.visible).toBe(false)
  })

  it('用户取消确认时不移动', async () => {
    const p = moveIdsToDir(['m1'], 'lora')
    await Promise.resolve()
    // 确认层已弹出，用户拒绝
    state.confirm.resolve(false)
    state.confirm.visible = false
    state.confirm.resolve = null
    const ok = await p
    expect(ok).toBe(false)
    expect(api.models.moveModels).not.toHaveBeenCalled()
  })

  it('确认后移动：本地条目替换、多选选区跟随新 id、目录与缺口刷新', async () => {
    state.models = [makeModel('D:\\models\\lora\\a.safetensors', 'lora')]
    state.multiSelect.ids = ['D:\\models\\lora\\a.safetensors']
    api.models.moveModels.mockResolvedValue({
      moved: [
        {
          from: 'D:\\models\\lora\\a.safetensors',
          to: 'D:\\models\\角色\\a.safetensors',
          model: makeModel('D:\\models\\角色\\a.safetensors', '角色')
        }
      ],
      failed: [],
      destDir: '角色'
    })
    const p = moveIdsToDir(['D:\\models\\lora\\a.safetensors'], '角色')
    acceptConfirm()
    const ok = await p
    expect(ok).toBe(true)
    expect(api.models.moveModels).toHaveBeenCalledWith({
      ids: ['D:\\models\\lora\\a.safetensors'],
      destDir: '角色'
    })
    expect(state.models[0].id).toBe('D:\\models\\角色\\a.safetensors')
    expect(state.multiSelect.ids).toEqual(['D:\\models\\角色\\a.safetensors'])
  })

  it('移动的模型正在详情中打开时关闭详情', async () => {
    const oldId = 'D:\\models\\a.safetensors'
    state.models = [makeModel(oldId, '')]
    state.selectedId = oldId
    api.models.moveModels.mockResolvedValue({
      moved: [{ from: oldId, to: 'D:\\models\\d\\a.safetensors', model: makeModel('D:\\models\\d\\a.safetensors', 'd') }],
      failed: [],
      destDir: 'd'
    })
    const p = moveIdsToDir([oldId], 'd')
    acceptConfirm()
    await p
    expect(state.selectedId).toBeNull()
  })

  it('部分失败时按成功条目更新并走警告提示', async () => {
    state.models = [makeModel('D:\\models\\a.safetensors', '')]
    api.models.moveModels.mockResolvedValue({
      moved: [],
      failed: [{ id: 'D:\\models\\a.safetensors', error: '目标文件夹已存在同名文件' }],
      destDir: 'd'
    })
    const p = moveIdsToDir(['D:\\models\\a.safetensors'], 'd')
    acceptConfirm()
    const ok = await p
    expect(ok).toBe(false)
    expect(state.models[0].id).toBe('D:\\models\\a.safetensors')
  })
})

describe('bindGap 手动绑定', () => {
  it('成功后用装饰结果替换本地条目，孤儿/新模型从清单移除', async () => {
    state.models = [makeModel('D:\\models\\new.safetensors', 'new')]
    state.organize.orphans = [{ key: 'old/x.safetensors' }]
    state.organize.newcomers = [{ key: 'new.safetensors' }]
    api.models.bindMeta.mockResolvedValue({
      ok: true,
      model: { ...makeModel('D:\\models\\new.safetensors', 'new'), alias: '绑定后' }
    })
    const ok = await bindGap('old/x.safetensors', 'new.safetensors')
    expect(ok).toBe(true)
    expect(state.models[0].alias).toBe('绑定后')
    expect(state.organize.orphans).toEqual([])
    expect(state.organize.newcomers).toEqual([])
  })

  it('空键拒绝；主进程报错时不清空清单', async () => {
    expect(await bindGap('', 'x')).toBe(false)
    state.organize.orphans = [{ key: 'old/x.safetensors' }]
    api.models.bindMeta.mockResolvedValue({ error: '目标已有标注' })
    const ok = await bindGap('old/x.safetensors', 'new.safetensors')
    expect(ok).toBe(false)
    expect(state.organize.orphans).toHaveLength(1)
  })
})
