import { state, replaceModels } from './state'
import { toast } from './toast'
import { scanModels } from './library'

/**
 * 局部增量扫描（A-03，watcher 变更子树驱动，A-04 自 appStore.js 拆出）。
 *
 * B-01 一致性约束：
 * - 同一时刻只允许一条局部扫描在途（主进程也共用 scanning 锁），
 *   在途期间到达的变更子树合并到队列，结束后串行补扫；
 * - 请求发出时快照根目录 / 模型数组 / 代际号，响应回来任一不匹配即丢弃，
 *   避免切库或全量重扫后旧根结果串台；
 * - 因锁冲突等原因失败时，等当前请求收尾后再降级全量扫描，
 *   不能在 partialScanning 仍为 true 时直接调用全量扫描。
 */

/** 局部扫描代际：每次真正发起请求自增，用于丢弃过期响应 */
let scanToken = 0
/** 在途期间累积的后续变更（同一根目录） */
let queuedRoot = ''
let queuedDirs = new Set()
/** 在途期间收到「空子树」载荷：收尾后补一次全量扫描 */
let queuedFullScan = false

/**
 * 子树归一化：去非字符串、trim 与精确去重。
 * 越界/逃逸段校验由主进程统一执行（fail-closed），此处只做载荷收敛。
 * @param {unknown} dirs
 * @returns {string[]}
 */
function normalizeDirs(dirs) {
  if (!Array.isArray(dirs)) return []
  const out = []
  const seen = new Set()
  for (const raw of dirs) {
    if (typeof raw !== 'string') continue
    const item = raw.trim()
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/** 重置排队状态 */
function clearQueue() {
  queuedRoot = ''
  queuedDirs = new Set()
  queuedFullScan = false
}

/**
 * 在途期间的后续变更入队（按根隔离：根变化时旧队列整体作废）。
 * @param {string} root 当前根
 * @param {string[]} dirs 归一化子树
 */
function enqueue(root, dirs) {
  if (queuedRoot !== root) clearQueue()
  queuedRoot = root
  if (dirs.length === 0) {
    queuedFullScan = true
    return
  }
  for (const dir of dirs) queuedDirs.add(dir)
}

/**
 * 判断模型的相对目录是否落在变更子树集合内。
 * @param {string} relDir 模型相对目录（'' 为根直属）
 * @param {string[]} dirs 变更子树（POSIX，'' 为根直属）
 */
function isRelDirAffected(relDir, dirs) {
  return dirs.some((d) =>
    d === '' ? relDir === '' : relDir === d || relDir.startsWith(`${d}/`)
  )
}

/**
 * 局部增量扫描：只重扫 watcher 检出的变更子树，主进程返回这些子树的模型现状，
 * 渲染层就地合并——子树外的模型列表完全不动（零 IPC 载荷、零重排），
 * 不进入全屏扫描遮罩（局部扫描通常很快），成本从全库 O(n) 降为变更量。
 * dirs 为空时回退全量扫描（防御异常载荷）。
 * @param {string[]} dirs 变更子树相对路径
 */
export async function partialScanModels(dirs) {
  const normalizedDirs = normalizeDirs(dirs)
  const root = state.folder
  if (!root) return

  // 在途：合并子树后串行补扫，避免并发局部扫描互相覆盖结果
  if (state.partialScanning) {
    enqueue(root, normalizedDirs)
    return
  }
  if (normalizedDirs.length === 0) {
    clearQueue()
    return scanModels()
  }

  const token = ++scanToken
  const modelsRef = state.models
  state.partialScanning = true
  let fallbackFull = false
  let canceled = false

  /**
   * 收尾：复位在途标志并按优先级调度后续动作。
   * 独立函数而非直接写在 finally 中，避免 finally 内的 return 覆盖 try 的返回值。
   */
  function finalize() {
    if (token === scanToken) state.partialScanning = false

    // 全量扫描已接管（会返回覆盖全库的结果）：丢弃排队项，避免再发局部请求被锁拒绝
    if (state.scanning) {
      clearQueue()
      return
    }
    // 用户取消：丢弃本轮累积的后续变更（取消是显式意图，不应继续补扫）
    if (canceled) {
      clearQueue()
      return
    }
    // 收尾调度：仅当仍是当前根时消费队列，避免把旧根子树用于新库
    const rootIsCurrent = root === state.folder
    if (fallbackFull) {
      clearQueue()
      if (rootIsCurrent) scanModels()
      return
    }
    if (!rootIsCurrent || queuedRoot !== state.folder) {
      clearQueue()
      return
    }
    if (queuedFullScan) {
      clearQueue()
      scanModels()
    } else if (queuedDirs.size > 0) {
      const next = [...queuedDirs]
      clearQueue()
      partialScanModels(next)
    } else {
      clearQueue()
    }
  }

  try {
    const res = await window.api.models.partialScan({ folder: root, dirs: normalizedDirs })
    if (res.canceled) {
      canceled = true
      return
    }
    if (res.error) {
      // 根已切换或已有更新的请求：旧错误不再提示，避免串台噪音
      if (root !== state.folder || token !== scanToken) return
      // 全量扫描已接管：其结果覆盖全库，无需再降级重扫
      if (state.scanning) return
      // 局部失败保守降级为全量扫描，保证最终与磁盘一致；
      // 全量扫描延后到 finalize（此时 partialScanning 已复位）
      toast('warn', '增量刷新失败，已改为完整扫描')
      fallbackFull = true
      return
    }
    // 根 / 代际 / 数组身份三重校验（B-01）：切库或全量重扫后旧响应必须丢弃
    if (root !== state.folder || token !== scanToken || state.models !== modelsRef) return
    // 全量扫描在途：其结果将整体覆盖列表，此时合并局部结果没有意义
    if (state.scanning) return

    const incoming = Array.isArray(res.models) ? res.models : []
    const incomingIds = new Set(incoming.map((m) => m.id))
    const removedIds = []

    // 未受影响子树的旧模型原样保留；受影响的模型以局部扫描结果为准
    const untouched = state.models.filter((m) => {
      if (!isRelDirAffected(m.relDir || '', normalizedDirs)) return true
      if (incomingIds.has(m.id)) return false
      removedIds.push(m.id)
      return false
    })
    replaceModels(untouched.concat(incoming))
    state.lastScan = {
      count: state.models.length,
      durationMs: res.durationMs
    }

    // 联动收敛：多选选区与打开的详情若指向已消失模型，同步清理
    if (state.multiSelect.ids.length > 0) {
      const removedSet = new Set(removedIds)
      state.multiSelect.ids = state.multiSelect.ids.filter((id) => !removedSet.has(id))
    }
    if (state.selectedId && removedIds.includes(state.selectedId)) {
      state.selectedId = null
      state.detailDirty = false
    }

    if (res.relinked > 0) {
      toast('success', `已自动重新关联 ${res.relinked} 个移动/重命名模型的标注`)
    }
  } catch (err) {
    if (root === state.folder && token === scanToken) {
      toast('error', `增量刷新失败: ${err.message}`)
    }
  } finally {
    finalize()
  }
}
