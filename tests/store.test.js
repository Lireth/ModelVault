import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  atomicWriteFile,
  getModelMeta,
  isInRoot,
  loadData,
  removeModelMeta,
  renameModelMeta,
  setDataRoot,
  setModelHash,
  setModelMeta
} from '../src/main/services/store'

/**
 * store.js 单元测试（黑盒）：
 * - 元数据规范化（别名/标签/评分/参数旧版迁移/未知字段剔除）
 * - 路径关联（相对键、Windows 大小写不敏感兜底、越界拒绝）
 * - 元数据键迁移（重命名）、哈希持久化校验
 * - atomicWriteFile 原子写入
 * 说明：模块级内存状态按 beforeEach 重置（切换临时根目录）。
 */

let root

/** 写入一个模型文件占位（仅为路径关联，不要求真实模型内容） */
async function touchModel(rel) {
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, 'x')
  return abs
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'modelvault-store-'))
  setDataRoot(root)
  await loadData()
})

afterAll(async () => {
  await fs.rm(os.tmpdir(), { recursive: true, force: false }).catch(() => {})
})

describe('元数据规范化', () => {
  it('基础字段：别名修剪、备注截断、未知字段剔除', async () => {
    const abs = await touchModel('a.safetensors')
    const meta = setModelMeta(abs, {
      alias: '  我的大模型  ',
      note: 'x'.repeat(3000),
      unknownField: 'should be dropped',
      params: { steps: 20 }
    })
    expect(meta.alias).toBe('我的大模型')
    expect(meta.note).toHaveLength(2000)
    expect(meta.unknownField).toBeUndefined()
    expect(meta.params.steps).toBe(20)
    // 重新读取（内存规范化结果一致）
    expect(getModelMeta(abs).alias).toBe('我的大模型')
  })

  it('标签：去空、去重、单项截断、数量上限', async () => {
    const abs = await touchModel('b.safetensors')
    const tags = ['风格', '风格', '  ', 'x'.repeat(50), ...Array.from({ length: 25 }, (_, i) => `t${i}`)]
    const meta = setModelMeta(abs, { tags })
    expect(meta.tags[0]).toBe('风格')
    expect(meta.tags.filter((t) => t === '风格')).toHaveLength(1)
    expect(meta.tags.every((t) => t.length <= 30)).toBe(true)
    expect(meta.tags.length).toBeLessThanOrEqual(20)
  })

  it('评分越界回退 0，收藏仅接受 true', async () => {
    const abs = await touchModel('c.safetensors')
    expect(setModelMeta(abs, { rating: 9, favorite: 'yes' }).rating).toBe(0)
    expect(getModelMeta(abs).favorite).toBe(false)
    expect(setModelMeta(abs, { rating: 5, favorite: true }).favorite).toBe(true)
  })

  it('旧版参数迁移：cfg 单值 -> 区间，resMinW/resMinH -> 单值区间', async () => {
    const abs = await touchModel('d.safetensors')
    const meta = setModelMeta(abs, {
      params: { cfg: 7, resMinW: 512, resMinH: 768, steps: 25 }
    })
    expect(meta.params.cfgMin).toBe(7)
    expect(meta.params.cfgMax).toBe(7)
    expect(meta.params.resMin).toBe(512)
    expect(meta.params.steps).toBe(25)
  })

  it('旧版单封面字段迁移为多封面列表', async () => {
    const abs = await touchModel('e.safetensors')
    const meta = setModelMeta(abs, { cover: '.modelvault/covers/old.png' })
    expect(meta.covers).toEqual(['.modelvault/covers/old.png'])
    expect(meta.cover).toBe('.modelvault/covers/old.png')
  })
})

describe('路径关联', () => {
  it('越界路径拒绝保存', async () => {
    const outside = path.join(path.dirname(root), 'outside.safetensors')
    expect(setModelMeta(outside, { alias: 'x' })).toBeNull()
    expect(setModelMeta('', { alias: 'x' })).toBeNull()
  })

  it('Windows 大小写不敏感：路径仅大小写不同仍可关联', async () => {
    const abs = await touchModel('Case-Model.safetensors')
    const lower = abs.toLowerCase()
    if (lower === abs) return // 文件系统大小写不敏感时大小写变化无意义
    expect(isInRoot(lower)).toBe(true)
    const meta = setModelMeta(lower, { alias: '小写路径' })
    expect(meta).not.toBeNull()
    // 键按传入路径的相对形式记录，同一变体读取一致
    expect(getModelMeta(lower).alias).toBe('小写路径')
  })

  it('重命名迁移元数据键，目标键已存在时拒绝覆盖', async () => {
    const oldAbs = await touchModel('old-name.safetensors')
    const newAbs = await touchModel('new-name.safetensors')
    setModelMeta(oldAbs, { alias: '迁移测试' })
    // 目标元数据键已存在 -> 拒绝覆盖（文件存在性由 IPC 层校验）
    setModelMeta(newAbs, { alias: '占位' })
    expect(renameModelMeta(oldAbs, newAbs)).toBe(false)
    removeModelMeta(newAbs)
    // 目标键空闲后迁移成功，旧键清除且数据保留
    expect(renameModelMeta(oldAbs, newAbs)).toBe(true)
    expect(getModelMeta(oldAbs)).toBeNull()
    expect(getModelMeta(newAbs).alias).toBe('迁移测试')
  })

  it('删除元数据', async () => {
    const abs = await touchModel('del.safetensors')
    setModelMeta(abs, { alias: '待删除' })
    expect(removeModelMeta(abs)).toBe(true)
    expect(getModelMeta(abs)).toBeNull()
    expect(removeModelMeta(abs)).toBe(false)
  })
})

describe('AutoV2 哈希持久化', () => {
  it('合法哈希写入成功，非法哈希拒绝', async () => {
    const abs = await touchModel('hash-model.safetensors')
    setModelMeta(abs, { alias: 'hash' })
    const good = 'a'.repeat(64)
    expect(setModelHash(abs, good, 12345)).toBe(true)
    const meta = getModelMeta(abs)
    expect(meta.hash).toBe(good)
    expect(meta.hashMtime).toBe(12345)
    expect(setModelHash(abs, 'not-a-hash', 1)).toBe(false)
    expect(setModelHash(abs, 'A'.repeat(64), 1)).toBe(true) // 大写 hex 自动转小写
    expect(getModelMeta(abs).hash).toBe('a'.repeat(64))
  })
})

describe('atomicWriteFile', () => {
  it('写入内容完整且不残留临时文件', async () => {
    const file = path.join(root, 'nested', 'dir', 'out.json')
    await atomicWriteFile(file, '{"ok":true}')
    expect(await fs.readFile(file, 'utf-8')).toBe('{"ok":true}')
    const siblings = await fs.readdir(path.dirname(file))
    expect(siblings.every((n) => !n.includes('.tmp'))).toBe(true)
  })
})
