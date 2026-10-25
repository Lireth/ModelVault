import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * 文件操作后的局部扫描收敛（OPT-03）单元测试：
 * 此前重命名/禁用/移动（单模型与批量）一律整表 scanModels()——全库磁盘
 * IO + 全屏扫描遮罩；改为收集所涉子树走 partialScanModels 就地合并
 * （partialScanModels 内建「目录过多/异常回退全量」兜底）。
 * 本文件 mock partialScanModels 与 scanModels，断言各操作传入的子树集合
 * 与「不再触发全量重扫」；modelRelDirs 子树收集为真实实现。
 */

vi.mock('../src/renderer/src/store/toast.js', async (importOriginal) => ({
  ...(await importOriginal()),
  toast: vi.fn(),
  confirmDialog: vi.fn(async () => true),
}))

vi.mock('../src/renderer/src/store/library.js', async (importOriginal) => ({
  ...(await importOriginal()),
  scanModels: vi.fn(async () => {}),
}))

vi.mock(
  '../src/renderer/src/store/partial-scan.js',
  async (importOriginal) => ({
    ...(await importOriginal()),
    partialScanModels: vi.fn(async () => {}),
  }),
)

import { state, replaceModels } from '../src/renderer/src/store/state'
import { scanModels } from '../src/renderer/src/store/library'
import {
  partialScanModels,
  modelRelDirs,
} from '../src/renderer/src/store/partial-scan'
import {
  moveModelTo,
  renameModel,
  toggleDisabledModel,
} from '../src/renderer/src/store/model-actions'
import {
  batchOrganizeByTags,
  batchToggleDisabled,
} from '../src/renderer/src/store/multiselect/batch-files'

/** 注入模型（id 与 relDir 对应） */
const MODELS = [
  { id: 'D:\\lib\\a\\m1.safetensors', relDir: 'a', name: 'm1', type: 'lora' },
  {
    id: 'D:\\lib\\a\\m2.safetensors',
    relDir: 'a',
    name: 'm2',
    type: 'lora',
    subCategory: 'role',
  },
  { id: 'D:\\lib\\c\\m3.safetensors', relDir: 'c', name: 'm3', type: 'lora' },
]

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', {
    api: {
      models: {
        toggleDisabled: vi.fn(async () => ({})),
        renameModel: vi.fn(async () => ({
          path: 'D:\\lib\\a\\renamed.safetensors',
          renamedSidecars: 0,
        })),
        moveModelTo: vi.fn(async () => ({
          path: 'D:\\lib\\dst\\m1.safetensors',
          targetRelDir: 'dst',
        })),
        organizeByTags: vi.fn(async () => ({
          moved: 2,
          failed: [],
          skipped: [],
        })),
      },
    },
  })
  state.folder = 'D:\\lib'
  state.scanning = false
  state.selectedId = null
  state.multiSelect.ids = []
  state.multiSelect.busy = false
  state.multiSelect.cancelRequested = false
  replaceModels([...MODELS])
})

describe('modelRelDirs（子树收集）', () => {
  it('按模型 id 去重收集 relDir；不在列表的 id 不贡献子树', () => {
    expect(
      modelRelDirs([
        'D:\\lib\\a\\m1.safetensors',
        'D:\\lib\\a\\m2.safetensors',
        'D:\\lib\\c\\m3.safetensors',
        'D:\\lib\\gone.safetensors',
      ]),
    ).toEqual(['a', 'c'])
    expect(modelRelDirs([])).toEqual([])
  })
})

describe('单模型文件操作 → 局部扫描（OPT-03）', () => {
  it('禁用/启用后只扫所在子树，不触发全量', async () => {
    const ok = await toggleDisabledModel(MODELS[0].id, true)
    expect(ok).toBe(true)
    expect(partialScanModels).toHaveBeenCalledWith(['a'])
    expect(scanModels).not.toHaveBeenCalled()
  })

  it('重命名成功后只扫所在子树', async () => {
    const ok = await renameModel(MODELS[1].id, 'renamed')
    expect(ok).toBe(true)
    expect(partialScanModels).toHaveBeenCalledWith(['a'])
    expect(scanModels).not.toHaveBeenCalled()
  })

  it('库内移动后源/目标两个子树都扫', async () => {
    const ok = await moveModelTo(MODELS[2].id)
    expect(ok).toBe(true)
    expect(partialScanModels).toHaveBeenCalledWith(['c', 'dst'])
    expect(scanModels).not.toHaveBeenCalled()
  })

  it('移动响应缺 targetRelDir（形状漂移防御）时传空数组走全量回退', async () => {
    window.api.models.moveModelTo.mockResolvedValue({
      path: 'D:\\lib\\dst\\m3.safetensors',
    })
    await moveModelTo(MODELS[2].id)
    expect(partialScanModels).toHaveBeenCalledWith([])
    // 空数组由真实 partialScanModels 回退全量（此处被 mock，仅锁定契约）
  })
})

describe('批量文件操作 → 局部扫描（OPT-03）', () => {
  it('批量禁用后收集去重子树一次扫描', async () => {
    state.multiSelect.ids = MODELS.map((m) => m.id)
    await batchToggleDisabled(true)
    expect(partialScanModels).toHaveBeenCalledWith(['a', 'c'])
    expect(scanModels).not.toHaveBeenCalled()
  })

  it('一键整理后扫源子树 + LoRA 根子树（覆盖全部标签子目录）', async () => {
    state.multiSelect.ids = MODELS.map((m) => m.id)
    await batchOrganizeByTags()
    expect(partialScanModels).toHaveBeenCalledWith(['a', 'c', 'LoRA'])
    expect(scanModels).not.toHaveBeenCalled()
  })
})
