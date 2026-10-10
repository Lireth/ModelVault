import { describe, it, expect } from 'vitest'
import { ancestorDirs, buildFolderTree, flattenTree } from '../src/renderer/src/store/folder-tree'

/**
 * 目录结构树纯函数测试（B-01）：
 * 聚合口径（直属/子树计数）、缺失父链补建、空目录补充、展开扁平化。
 */

function m(relDir, size = 100) {
  return { relDir, size }
}

describe('buildFolderTree 目录聚合', () => {
  it('根节点聚合根直属模型，目录节点聚合直属模型', () => {
    const root = buildFolderTree([m(''), m(''), m('lora')])
    expect(root.count).toBe(2)
    expect(root.totalCount).toBe(3)
    const lora = root.children.find((c) => c.path === 'lora')
    expect(lora.count).toBe(1)
    expect(lora.totalCount).toBe(1)
  })

  it('子树计数包含全部后代的模型数与占用', () => {
    const root = buildFolderTree([
      m('a/b', 10),
      m('a/b/c', 20),
      m('a', 30),
      m('', 40)
    ])
    const a = root.children.find((c) => c.path === 'a')
    expect(a.count).toBe(1) // 仅 a 直属
    expect(a.totalCount).toBe(3) // a + a/b + a/b/c
    expect(a.totalSize).toBe(60)
    const ab = a.children.find((c) => c.path === 'a/b')
    expect(ab.totalCount).toBe(2)
    expect(ab.totalSize).toBe(30)
    expect(root.totalSize).toBe(100)
  })

  it('缺失中间层时自动补建父链（extraDirs 深层空目录）', () => {
    const root = buildFolderTree([], ['x/y/z'])
    const x = root.children.find((c) => c.path === 'x')
    expect(x).toBeTruthy()
    const y = x.children.find((c) => c.path === 'x/y')
    const z = y.children.find((c) => c.path === 'x/y/z')
    expect(z).toBeTruthy()
    expect(z.totalCount).toBe(0)
  })

  it('无 relDir/尺寸非法的模型按根直属、0 字节处理', () => {
    const root = buildFolderTree([{}, { relDir: 'a', size: NaN }])
    expect(root.count).toBe(1)
    const a = root.children.find((c) => c.path === 'a')
    expect(a.size).toBe(0)
  })

  it('子节点按中文名排序（顺序与 zh Collator 一致且稳定）', () => {
    const root = buildFolderTree([m('洛'), m('a'), m('中')])
    const names = root.children.map((c) => c.name)
    const sorted = [...names].sort((x, y) => new Intl.Collator('zh-CN').compare(x, y))
    expect(names).toEqual(sorted)
  })
})

describe('flattenTree 展开扁平化', () => {
  it('虚拟根恒展开，深层目录默认折叠', () => {
    const root = buildFolderTree([m('a/b/c')])
    const rows = flattenTree(root, new Set())
    const paths = rows.map((r) => r.node.path)
    expect(paths).toEqual(['', 'a'])
  })

  it('展开父节点后出现子节点，未展开的兄弟深层不出现', () => {
    const root = buildFolderTree([m('a/b/c'), m('x/y')])
    const rows = flattenTree(root, new Set(['a']))
    const paths = rows.map((r) => r.node.path)
    expect(paths).toContain('a/b')
    expect(paths).not.toContain('a/b/c')
    expect(paths).not.toContain('x/y')
  })

  it('行携带正确层级深度', () => {
    const root = buildFolderTree([m('a/b/c')])
    const rows = flattenTree(root, new Set(['a', 'a/b']))
    const byPath = Object.fromEntries(rows.map((r) => [r.node.path, r.depth]))
    expect(byPath['']).toBe(0)
    expect(byPath.a).toBe(1)
    expect(byPath['a/b']).toBe(2)
    expect(byPath['a/b/c']).toBe(3)
  })
})

describe('ancestorDirs 祖先链', () => {
  it('返回不含自身的全部祖先路径', () => {
    expect(ancestorDirs('a/b/c/d')).toEqual(['a', 'a/b', 'a/b/c'])
  })
  it('顶层目录与根无祖先', () => {
    expect(ancestorDirs('a')).toEqual([])
    expect(ancestorDirs('')).toEqual([])
  })
})
