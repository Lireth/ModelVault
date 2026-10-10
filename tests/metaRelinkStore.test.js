import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fakeUserData } from './setup'

/**
 * relinkScannedMeta 存储层集成测试（A-02）：
 * 以真实临时目录 + 真实关联存储验证移动/重命名后的键迁移、
 * 封面引用保持（封面存于 .modelvault/covers，与模型相对路径无关）、
 * 无信号的数据孤儿保守保留、空孤儿自动清理，以及落盘内容。
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => fakeUserData), isPackaged: true }
}))

import {
  flushStoreSave,
  getModelMeta,
  loadData,
  relinkScannedMeta,
  saveStoreNow,
  setDataRoot,
  setModelMeta
} from '../src/main/services/store'
import { DATA_DIR } from '../src/main/services/store'

let root
const roots = []

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-relink-'))
  roots.push(root)
  setDataRoot(root)
  await loadData()
})

afterEach(async () => {
  for (const dir of roots) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

/** 构造扫描模型条目（字段与 scanner 输出一致） */
function scanned(rel, { size = 1024, mtimeMs = 1000 } = {}) {
  const abs = path.join(root, ...rel.split('/'))
  const ext = path.extname(abs)
  return {
    id: abs,
    name: path.basename(abs, ext),
    ext,
    relDir: path.dirname(rel) === '.' ? '' : path.dirname(rel),
    folder: path.dirname(abs),
    size,
    mtimeMs
  }
}

describe('relinkScannedMeta 库内移动/重命名重关联', () => {
  it('模型移入子目录（同名）：标注迁移到新键，旧键删除，封面引用保持有效', async () => {
    const oldAbs = path.join(root, 'a.safetensors')
    setModelMeta(oldAbs, {
      alias: '我的模型',
      note: '重要备注',
      favorite: true,
      cover: `${DATA_DIR}/covers/keep.png`,
      covers: [`${DATA_DIR}/covers/keep.png`]
    })

    const result = relinkScannedMeta([scanned('lora/a.safetensors')])

    expect(result.relinked).toBe(1)
    expect(result.retainedOrphans).toBe(0)
    expect(getModelMeta(path.join(root, 'a.safetensors'))).toBeNull()
    const moved = getModelMeta(path.join(root, 'lora', 'a.safetensors'))
    expect(moved.alias).toBe('我的模型')
    expect(moved.note).toBe('重要备注')
    expect(moved.favorite).toBe(true)
    // 封面引用不随模型路径变化而改动（关联封面存于 .modelvault/covers）
    expect(moved.cover).toBe(`${DATA_DIR}/covers/keep.png`)
  })

  it('同目录改名（1:1）：标注迁移到新文件名', async () => {
    setModelMeta(path.join(root, 'old-name.safetensors'), { rating: 5 })

    const result = relinkScannedMeta([scanned('new-name.safetensors')])

    expect(result.relinked).toBe(1)
    expect(getModelMeta(path.join(root, 'new-name.safetensors')).rating).toBe(5)
    expect(getModelMeta(path.join(root, 'old-name.safetensors'))).toBeNull()
  })

  it('歧义场景（同名两个新位置）不关联，数据孤儿保留以便文件移回时重新关联', async () => {
    setModelMeta(path.join(root, 'd1', 'a.safetensors'), { note: '别绑错' })

    const result = relinkScannedMeta([
      scanned('x/a.safetensors'),
      scanned('y/a.safetensors')
    ])

    expect(result.relinked).toBe(0)
    expect(result.retainedOrphans).toBe(1)
    expect(getModelMeta(path.join(root, 'd1', 'a.safetensors')).note).toBe('别绑错')
  })

  it('无任何用户数据的空孤儿自动清理；有数据的孤儿保留', async () => {
    // 空骨架（曾写入后全部取消的标注）
    setModelMeta(path.join(root, 'empty.safetensors'), { favorite: false })
    // 有备注的真孤儿
    setModelMeta(path.join(root, 'kept.safetensors'), { note: '保留我' })

    const result = relinkScannedMeta([scanned('unrelated.safetensors')])

    expect(result.relinked).toBe(0)
    expect(result.prunedEmpty).toBe(1)
    expect(result.retainedOrphans).toBe(1)
    expect(getModelMeta(path.join(root, 'empty.safetensors'))).toBeNull()
    expect(getModelMeta(path.join(root, 'kept.safetensors')).note).toBe('保留我')
  })

  it('键仍存在于扫描结果的模型既不算孤儿也不算新模型（保持原样）', async () => {
    const abs = path.join(root, 'stay.safetensors')
    setModelMeta(abs, { note: '原地不动' })

    const result = relinkScannedMeta([scanned('stay.safetensors')])

    expect(result).toEqual({ relinked: 0, prunedEmpty: 0, retainedOrphans: 0 })
    expect(getModelMeta(abs).note).toBe('原地不动')
  })

  it('重关联与清理结果落盘到 store.json（防抖保存被触发）', async () => {
    setModelMeta(path.join(root, 'a.safetensors'), { alias: '迁移后可见' })
    relinkScannedMeta([scanned('sub/a.safetensors')])
    await flushStoreSave()

    const raw = JSON.parse(await fs.readFile(path.join(root, DATA_DIR, 'store.json'), 'utf-8'))
    expect(raw.models['sub/a.safetensors'].alias).toBe('迁移后可见')
    expect(raw.models['a.safetensors']).toBeUndefined()
  })
})

describe('relinkScannedMeta 边界', () => {
  it('空扫描结果时：有数据的孤儿走保留/清理判定，不抛错', async () => {
    setModelMeta(path.join(root, 'kept.safetensors'), { rating: 1 })
    const result = relinkScannedMeta([])
    expect(result.relinked).toBe(0)
    expect(result.retainedOrphans).toBe(1)
  })

  it('无孤儿时返回全零且不触发无意义写盘', async () => {
    const result = relinkScannedMeta([scanned('a.safetensors')])
    expect(result).toEqual({ relinked: 0, prunedEmpty: 0, retainedOrphans: 0 })
    // 新模型本就无元数据：不应凭空创建条目
    expect(getModelMeta(path.join(root, 'a.safetensors'))).toBeNull()
    await saveStoreNow()
    const raw = JSON.parse(await fs.readFile(path.join(root, DATA_DIR, 'store.json'), 'utf-8'))
    expect(raw.models).toEqual({})
  })
})
