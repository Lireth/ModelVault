/**
 * 局部扫描子树归一化与压缩（主/渲染共用，O3）：
 *
 * watcher 在批量解压/迁移后可能一次检出数百个变更目录。IPC schema 对
 * dirs 数量有硬上限，主进程旧实现还会对超出部分静默 slice——未被扫描的
 * 子树会保持陈旧，直到用户手动全量扫描。本模块提供确定性策略：
 * 1. 校验全部条目（不截断输入，非法项明确报错）；
 * 2. 去重并剔除被祖先覆盖的后代；
 * 3. 数量超限时收敛到一级目录（scanner 对非根子树递归扫描整棵子树，
 *    一级目录可安全覆盖其下全部变更）；
 * 4. 一级目录仍超限时返回 fullScanRequired，由调用方降级全量扫描。
 *
 * 空串表示「仅根目录直属文件」，不递归子目录，因此不参与祖先覆盖判断。
 */

/** 单次局部扫描实际执行的子树数量上限（超过则收敛/全量回退） */
export const MAX_PARTIAL_SCAN_DIRS = 200
/**
 * IPC 入参硬上限：允许调用方传入超过业务上限的变更集，由本模块收敛；
 * 仅用于防御超大 payload，不承担「截断」语义。
 */
export const MAX_PARTIAL_SCAN_DIRS_INPUT = 1000
/** 单个子树相对路径长度上限 */
export const MAX_PARTIAL_SCAN_DIR_LEN = 1000

/**
 * 去重并剔除被祖先覆盖的后代，保持输入首次出现顺序。
 * 排序后只需与「上一个保留项」比较：字典序保证同一祖先的全部后代连续出现。
 * @param {unknown} dirs 子树列表（非字符串项被忽略）
 * @returns {string[]}
 */
export function dedupeAndPruneDescendants(dirs) {
  const unique = []
  const seen = new Set()
  for (const item of Array.isArray(dirs) ? dirs : []) {
    if (typeof item !== 'string' || seen.has(item)) continue
    seen.add(item)
    unique.push(item)
  }

  const kept = new Set()
  let lastAncestor = ''
  for (const item of [...unique].sort()) {
    if (lastAncestor && item !== lastAncestor && item.startsWith(`${lastAncestor}/`)) {
      continue
    }
    kept.add(item)
    // 空串不覆盖任何子目录，不能作为后续判断的祖先
    lastAncestor = item === '' ? '' : item
  }
  return unique.filter((item) => kept.has(item))
}

/**
 * 将子树收敛到一级目录（保留首次出现顺序并去重）。
 * scanner 对非根子树递归扫描全部后代，故一级目录等价覆盖其下所有变更。
 * @param {string[]} dirs 已去重/去后代的子树列表
 * @returns {string[]}
 */
export function collapseDirsToTopLevel(dirs) {
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(dirs) ? dirs : []) {
    if (typeof item !== 'string') continue
    if (item === '') {
      if (!seen.has('')) {
        seen.add('')
        out.push('')
      }
      continue
    }
    const top = item.split('/')[0]
    if (!seen.has(top)) {
      seen.add(top)
      out.push(top)
    }
  }
  return out
}

/**
 * 校验并归一化局部扫描子树（主进程 IPC 入口使用）。
 * 超限时优先收敛到一级目录；仍超限则要求调用方降级全量扫描，
 * 绝不对输入做静默截断。
 * @param {unknown} dirs 渲染进程传入的变更子树
 * @param {number} [max] 子树数量上限（默认 MAX_PARTIAL_SCAN_DIRS）
 * @returns {{subDirs: string[], collapsed?: boolean} |
 *   {fullScanRequired: true} | {error: string}}
 */
export function normalizePartialScanDirs(dirs, max = MAX_PARTIAL_SCAN_DIRS) {
  if (!Array.isArray(dirs)) return { error: '缺少变更子树' }
  // 校验全部条目：不因数量上限提前停下，避免非法项被隐藏
  const normalized = []
  for (const raw of dirs) {
    if (typeof raw !== 'string') return { error: '变更子树参数无效' }
    const item = raw.trim()
    if (item === '') {
      normalized.push('')
      continue
    }
    if (
      item.length > MAX_PARTIAL_SCAN_DIR_LEN ||
      item.includes('\\') ||
      item.startsWith('/') ||
      /^[A-Za-z]:/.test(item) ||
      item.split('/').some((seg) => seg === '' || seg === '..' || seg === '.')
    ) {
      return { error: '变更子树参数无效' }
    }
    normalized.push(item)
  }
  if (normalized.length === 0) return { error: '缺少变更子树' }

  const subDirs = dedupeAndPruneDescendants(normalized)
  if (subDirs.length <= max) return { subDirs }

  const collapsed = collapseDirsToTopLevel(subDirs)
  if (collapsed.length <= max) return { subDirs: collapsed, collapsed: true }
  return { fullScanRequired: true }
}
