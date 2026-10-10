/**
 * 目录结构树派生（B-01 结构概览）：
 * 侧栏目录树从已扫描模型的 relDir 聚合，纯内存派生、零磁盘 IO，
 * 扫描/删除/移动后随 models 数组自动刷新。
 *
 * 约定：
 * - relDir 为 POSIX 相对目录（'' 表示根目录直属文件）；
 * - 仅含模型文件的目录自然出现；不含任何模型的空目录经 extraDirs 补充
 *   （B-06 整理面板传入主进程的完整目录列表，新建的空文件夹也可见）；
 * - 虚拟根节点 path 为 ''，count 统计根目录直属模型。
 */

/** 构造空目录节点 */
function makeNode(path, name) {
  return {
    name,
    path,
    count: 0, // 直属模型数
    size: 0, // 直属模型字节数
    totalCount: 0, // 含全部后代的模型数（建树末尾汇总）
    totalSize: 0,
    children: []
  }
}

/** 中文目录名排序比较器（模块级复用） */
const collator = new Intl.Collator('zh-CN')

/**
 * 构建目录树。
 * @param {Array<{relDir?:string, size?:number}>} models 已扫描模型列表
 * @param {string[]} [extraDirs] 额外纳入的空目录（POSIX 相对键，'' 为根）
 * @returns {object} 虚拟根节点
 */
export function buildFolderTree(models, extraDirs = []) {
  const root = makeNode('', '')
  const map = new Map([['', root]])

  /** 取目录节点，父链缺失时自动补建（extraDirs 可能跳过中间层先到深层） */
  const ensureDir = (dirPath) => {
    const existing = map.get(dirPath)
    if (existing) return existing
    const segs = dirPath.split('/')
    const node = makeNode(dirPath, segs[segs.length - 1])
    map.set(dirPath, node)
    const parentPath = segs.slice(0, -1).join('/')
    ensureDir(parentPath).children.push(node)
    return node
  }

  for (const m of Array.isArray(models) ? models : []) {
    const dir = typeof m.relDir === 'string' && m.relDir ? m.relDir : ''
    const node = ensureDir(dir)
    node.count += 1
    node.size += Number.isFinite(m.size) ? m.size : 0
  }
  for (const d of Array.isArray(extraDirs) ? extraDirs : []) {
    if (typeof d === 'string') ensureDir(d === '' ? '' : d)
  }

  /** 后序汇总：子树模型数/占用 + 子节点排序（目录排序不依赖模型顺序） */
  const aggregate = (node) => {
    node.totalCount = node.count
    node.totalSize = node.size
    for (const child of node.children) {
      aggregate(child)
      node.totalCount += child.totalCount
      node.totalSize += child.totalSize
    }
    node.children.sort((a, b) => collator.compare(a.name, b.name))
  }
  aggregate(root)
  return root
}

/**
 * 按展开集合把树扁平化为带层级的渲染行。
 * 虚拟根恒展开（其下级顶层目录始终可见）；其余节点仅当父链均在 expanded 中时出现。
 * @param {object} root buildFolderTree 返回的根节点
 * @param {Set<string>} expanded 展开的目录 path 集合
 * @returns {Array<{node:object, depth:number}>}
 */
export function flattenTree(root, expanded) {
  const rows = []
  const walk = (node, depth) => {
    rows.push({ node, depth })
    // depth===0 为虚拟根，恒展开；深层目录取决于父节点展开态
    if (depth === 0 || expanded.has(node.path)) {
      for (const child of node.children) walk(child, depth + 1)
    }
  }
  walk(root, 0)
  return rows
}

/**
 * 目录的全部祖先 path（不含自身）：选中深层目录时自动展开父链用。
 * @param {string} dirPath POSIX 相对目录
 * @returns {string[]}
 */
export function ancestorDirs(dirPath) {
  const segs = typeof dirPath === 'string' ? dirPath.split('/').filter(Boolean) : []
  const out = []
  for (let i = 1; i < segs.length; i++) {
    out.push(segs.slice(0, i).join('/'))
  }
  return out
}
