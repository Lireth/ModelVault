/**
 * 目录遍历与扫描执行（I/O 密集）：
 * 有界并发 readdir + 并行 stat + 按出队序号确定性提交，进度回调按时间窗合并。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { abortError, relativeWithin, runWithConcurrency } from '../../utils'
import {
  DISABLED_SUFFIX,
  MAX_SCAN_DEPTH,
  MODEL_EXTENSIONS,
  classifySubCategory,
  folderTypeOf,
  isVisibleScanEntry,
  modelAddedMs,
  typeByFilename,
} from './rules'
import { errorCode, errorMessage } from '../../../shared/error-text'

/**
 * 并行 stat 的并发上限：与 watcher 等共用 utils.runWithConcurrency（流式取任务，无批间屏障）
 */
const STAT_CONCURRENCY = 64

/**
 * 目录遍历的并发上限（OPT-02）：与 watcher 快照遍历
 * （watcher-snapshot 的 DEFAULT_TRAVERSAL_CONCURRENCY=8）同一量级的有界并发。
 * 此前 readdir 逐目录 await——大库/机械盘/网络盘上扫描耗时 ≈ 目录数 × 单次
 * readdir 延迟，是遍历阶段唯一的纯串行等待（文件 stat 本就 64 路并行）。
 */
const TRAVERSAL_CONCURRENCY = 8

/**
 * 扫描进度推送最小间隔（ms）：IPC 发送层另有 120ms 节流，此处先合并逐文件
 * 回调——大库首扫逐文件构造进度对象并调用 Date.now() 会带来数万次纯冗余
 * 分配；合并后渲染层进度刷新频率不变（仍远低于 120ms 闸门）。
 */
const PROGRESS_EMIT_INTERVAL_MS = 80

/**
 * 递归扫描模型目录。
 *
 * 目录遍历为有界并发（OPT-02）：readdir 在固定并发窗口内重叠，消除大库/
 * 机械盘/网络盘上「目录数 × 单次 readdir 延迟」的串行等待；结果按出队序号
 * 顺序提交，输出的内容与顺序运行间确定（遍历次序为 BFS）。
 *
 * @param {string} root 模型根目录绝对路径
 * @param {(progress: {dirs: number, found: number, current: string}) => void} [onProgress] 进度回调
 * @param {{excludeDirs?: string[]|Set<string>, extensions?: string[]|Set<string>,
 *   signal?: AbortSignal, subDirs?: string[]}} [options]
 *   额外排除的目录名（不区分大小写）、扫描的文件扩展名、取消信号；
 *   subDirs 为 A-03 子树局部扫描的相对根 POSIX 目录列表（'' 表示根直属）
 * @returns {Promise<{models: Array, errors: Array, dirCount: number,
 *   dirSnapshot: Map<string, string[]>, failedDirs: string[]}>}
 *   dirSnapshot 为本次实际读取目录的「目录绝对路径 → 排序条目名」快照，
 *   供 watcher 直接作为监控基线（OPT-02：扫描与监控共用同一份目录事实，
 *   避免扫描结束后再做一次全树遍历，也避免旧基线重复触发局部扫描）。
 *   failedDirs（B5）为子树模式下读取失败（非 ENOENT）的相对目录 POSIX
 *   列表：这些子树数据可能仍存在，调用方须保留其既有模型/索引/基线。
 * @throws {Error} name 为 'AbortError' 表示扫描被取消
 */
export async function scanModels(root, onProgress, options = {}) {
  const userExclude =
    options.excludeDirs instanceof Set
      ? options.excludeDirs
      : new Set(options.excludeDirs || [])
  const extensions =
    options.extensions instanceof Set
      ? options.extensions
      : new Set(options.extensions || MODEL_EXTENSIONS)
  const signal = options.signal
  const models = []
  const errors = []
  // OPT-02：扫描遍历顺带收集目录名快照（与 watcher 的可见性/深度规则一致），
  // 作为监控基线复用；仅保存目录名，不额外 stat 或读文件。
  const dirSnapshot = new Map()
  // 同一次扫描内按绝对路径去重（B-01 防御）：子树集合若出现父子重叠，
  // 同一文件会被递归访问两次。调用方已在入参层剔除后代，此处兜底保证
  // 扫描结果永远不含重复 id（重复卡片、统计翻倍、缩略图重复登记）。
  const seenIds = new Set()
  let dirCount = 0
  // 进度推送合并（见 PROGRESS_EMIT_INTERVAL_MS）：只在时间窗到达时构造快照，
  // 最后一个文件名与计数就地更新，避免逐文件分配进度对象
  let lastProgressAt = 0
  let lastProgressFile = ''

  /**
   * 推送一次进度快照（force=true 用于扫描收尾，保证小库/快速扫描至少一次）。
   * @param {boolean} force 是否忽略时间窗
   */
  function emitProgress(force) {
    if (!onProgress || models.length === 0) return
    const now = Date.now()
    if (!force && now - lastProgressAt < PROGRESS_EMIT_INTERVAL_MS) return
    lastProgressAt = now
    onProgress({
      dirs: dirCount,
      found: models.length,
      current: lastProgressFile,
    })
  }

  // A-03 子树局部扫描：subDirs 为相对根的 POSIX 目录列表，'' 表示根直属。
  // 每个初始节点扫描目录内文件；非根节点递归全部后代，根节点（''）不递归——
  // 根层新增/删除的目录必以其自身路径另行出现在子树集合中，'' 只需采集直属文件
  const scoped = Array.isArray(options.subDirs) && options.subDirs.length > 0
  // B5：子树模式下读取失败（非 ENOENT）的相对目录（POSIX）——这些子树
  // 数据可能仍存在，调用方必须保留其既有模型/索引/基线而非按空目录覆盖
  const failedDirs = []
  const rootResolved = path.resolve(root)
  const isInsideRoot = (abs) =>
    relativeWithin(path.resolve(abs), rootResolved) !== null
  const initialDirs = scoped
    ? options.subDirs
        .map((item) => {
          const normalized = typeof item === 'string' ? item.trim() : ''
          if (normalized === '')
            return { dir: root, depth: 0, rel: '', descend: false }
          const segs = normalized.split('/').filter(Boolean)
          return {
            dir: path.join(root, ...segs),
            depth: segs.length,
            rel: segs.join('/'),
            descend: true,
          }
        })
        // 越界（含 .. 逃逸/绝对路径）与超深子树不入栈
        .filter(
          (item) => item.depth <= MAX_SCAN_DEPTH && isInsideRoot(item.dir),
        )
    : [{ dir: root, depth: 0, rel: '', descend: true }]
  const queue = initialDirs
  // OPT-02 并发遍历：动态 FIFO 队列 + 固定 worker（与 watcher-snapshot 的
  // pump 同构的有界并发）——readdir 在并发窗口内重叠；子目录在读取完成后
  // 压入共享队尾（BFS）。确定性保证：目录节点出队时分配单调序号，读改写
  // 完成的结果按序号顺序提交——models/errors/dirSnapshot 的内容与相互顺序
  // 与串行实现完全一致（仅遍历次序 DFS→BFS，运行间确定性不变），取消与
  // seenIds 去重语义不变。
  let nextSeq = 0
  let nextCommitSeq = 0
  /** 已完成读改写、待按序提交的目录单元（seq → unit；null 为跳过占位） */
  const pendingUnits = new Map()
  let qi = 0
  let active = 0
  let settled = false
  // 结束遍历（err 非空时以该错误拒绝整体 Promise，如 stat 池的取消中止）：
  // 实现在紧随其后的 walkDone executor 内同步赋值（不设占位函数体——
  // 占位箭头在覆盖率函数计数中是结构性死项，永远不可能被调用）
  /** @type {(err?: Error) => void} */
  let settleWalk
  const walkDone = /** @type {Promise<void>} */ (
    new Promise((resolve, reject) => {
      settleWalk = (err) => {
        if (settled) return
        settled = true
        if (err) reject(err)
        else resolve()
      }
    })
  )

  /**
   * 提交所有已就绪的连续序号单元（同步、纯 CPU：快照登记 + 模型登记）。
   * 提交严格按出队序号推进——单个慢目录只延迟其后目录的「登记」时机，
   * 不阻塞并发窗口内其他目录的 readdir/stat。
   */
  function commitReadyUnits() {
    while (pendingUnits.has(nextCommitSeq)) {
      const unit = pendingUnits.get(nextCommitSeq)
      pendingUnits.delete(nextCommitSeq)
      nextCommitSeq += 1
      if (!unit) continue
      if (unit.error) {
        errors.push({ dir: unit.dir, message: unit.error })
        // B5：子树读取失败（非 ENOENT）的相对目录登记，供调用方保留旧数据
        if (typeof unit.failedDir === 'string') failedDirs.push(unit.failedDir)
        continue
      }
      // OPT-02：记录本目录的可见条目名（与 watcher 快照同构，排序保证稳定比较）
      dirSnapshot.set(unit.dir, unit.visibleNames.sort())
      unit.fileEntries.forEach((f, index) => {
        const { stat, err } = unit.stats[index]
        if (err) {
          errors.push({ dir: f.fullPath, message: err })
          return
        }
        if (seenIds.has(f.fullPath)) return
        seenIds.add(f.fullPath)
        const ext = f.ext || path.extname(f.name).toLowerCase()
        models.push({
          id: f.fullPath,
          // disabled 文件名含双重后缀（x.safetensors.disabled），一并剥离
          name: path.basename(
            f.name,
            ext + (f.disabled ? DISABLED_SUFFIX : ''),
          ),
          ext,
          disabled: f.disabled === true,
          // PERF-SCAN：文件夹规则已在目录级记忆化，未命中时按文件名关键词兜底
          type: unit.folderType || typeByFilename(f.name),
          // 自动分类标签：按文件夹名匹配（目录级记忆化结果，装饰层与
          // meta.subCategory 合成生效）
          folderSubCategory: unit.folderSubCategory,
          relDir: unit.rel,
          // OPT-11：不再携带 folder（所在库根绝对路径）——全库同一长字符串
          // 且可由 dirname(id) 派生，渲染层/主进程均无消费方（字段盘点确认），
          // 万级库的 IPC 载荷/装饰缓存/本地索引各省约 1MB 纯冗余
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          // 添加时间（OPT-1「按添加时间」排序数据源）：随模型对象透传装饰层
          // 与本地索引（索引保留装饰层额外字段），渲染层缺省时回退 mtimeMs
          ctimeMs: modelAddedMs(stat),
        })
        // 进度合并推送（PROGRESS_EMIT_INTERVAL_MS）：文件名就地更新，
        // 到达时间窗或扫描收尾时才构造回调载荷
        lastProgressFile = f.relChild
        emitProgress(false)
      })
    }
  }

  /** 处理单个出队目录：readdir → 分类入队子目录 → 并行 stat → 按序提交 */
  async function processDir(node) {
    const seq = nextSeq++
    const { dir, depth, rel, descend } = node
    if (depth > MAX_SCAN_DEPTH) {
      // 超深目录不入快照不计数（与旧实现一致）；占位空槽保持提交链连续
      pendingUnits.set(seq, null)
      commitReadyUnits()
      return
    }

    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      // 三态区分（B5）：
      // - ENOENT/ENOTDIR：目录确实不存在（删除/移动），正常增量场景——
      //   按空目录处理，该子树旧模型随之移除；
      // - 子树模式的其它错误（EACCES/EBUSY/EMFILE 等，杀软锁定/同步工具
      //   占用）：目录可能仍存在——记入 errors 并登记 failedDirs，由调用方
      //   保留该子树的既有模型/索引/监控基线，绝不用空结果覆盖；
      // - 全量模式（根节点不可读）：仍计入错误由调用方决定停止监控。
      // 三类均以占位/错误单元进提交链：序号连续、errors 顺序确定
      const code = errorCode(err)
      if (scoped && code !== 'ENOENT' && code !== 'ENOTDIR') {
        pendingUnits.set(seq, {
          dir,
          rel,
          error: errorMessage(err) || String(err),
          failedDir: rel,
        })
        commitReadyUnits()
        return
      }
      if (scoped) {
        pendingUnits.set(seq, null)
        commitReadyUnits()
        return
      }
      pendingUnits.set(seq, { dir, error: errorMessage(err) || String(err) })
      commitReadyUnits()
      return
    }
    dirCount += 1

    // 先遍历目录项：子目录压入共享队尾（BFS）+ 收集待 stat 的模型文件
    const fileEntries = []
    const visibleNames = []
    for (const entry of entries) {
      // O11：与 watcher 共享同一可见性策略（隐藏/put_/符号链接/排除目录）
      if (!isVisibleScanEntry(entry, userExclude)) continue
      const name = entry.name
      visibleNames.push(name)

      const fullPath = path.join(dir, name)
      const relChild = rel ? `${rel}/${name}` : name

      if (entry.isDirectory()) {
        // descend=false 仅用于子树集合中的根节点（''）：不递归后代
        if (descend) {
          queue.push({
            dir: fullPath,
            depth: depth + 1,
            rel: relChild,
            descend: true,
          })
        }
        continue
      }
      if (!entry.isFile()) continue
      // F10：.disabled 后缀放行（WebUI 生态「禁用而非删除」的通行做法）。
      // 主扩展名（去掉 .disabled 后）须仍是所扫描的模型类型；ext 保留真实
      // 模型扩展名，使分类、封面与 safetensors 装饰链照常工作
      if (name.toLowerCase().endsWith(DISABLED_SUFFIX)) {
        const stem = name.slice(0, -DISABLED_SUFFIX.length)
        const baseExt = path.extname(stem).toLowerCase()
        if (!extensions.has(baseExt)) continue
        fileEntries.push({
          fullPath,
          name,
          relChild,
          ext: baseExt,
          disabled: true,
        })
        continue
      }
      if (!extensions.has(path.extname(name).toLowerCase())) continue
      fileEntries.push({ fullPath, name, relChild })
    }

    // PERF-SCAN：文件夹分类与自动标签只依赖相对目录，同一目录内全部模型
    // 共享同一结果——原实现逐文件重复拆分/小写化路径段并逐段匹配规则，
    // 万级库首扫产生数万次冗余分配与比较；此处按目录计算一次随单元提交
    const relSegments = fileEntries.length > 0 && rel ? rel.split('/') : []
    const folderType =
      relSegments.length > 0
        ? folderTypeOf(relSegments.map((s) => s.toLowerCase()))
        : ''
    const folderSubCategory = classifySubCategory(relSegments)

    // 并行 stat（取 size/mtime/birthtime）：流式固定并发池（与 watcher 共用
    // utils.runWithConcurrency，O-5）——完成一个补位一个。目录级并发后，
    // 同窗口内多个目录的 stat 池自然重叠，在途总量仍有界（≤ 在途单元数 ×
    // 64，实际受 libuv 线程池约束）。结果按索引回填后进提交链，取消语义
    // （每文件前检查）与顺序提交语义不变。
    const stats = new Array(fileEntries.length)
    await runWithConcurrency(
      fileEntries,
      async (f, index) => {
        if (signal?.aborted) throw abortError()
        try {
          stats[index] = { stat: await fs.stat(f.fullPath) }
        } catch (err) {
          stats[index] = { err: errorMessage(err) || String(err) }
        }
      },
      STAT_CONCURRENCY,
    )
    pendingUnits.set(seq, {
      dir,
      rel,
      fileEntries,
      stats,
      visibleNames,
      folderType,
      folderSubCategory,
    })
    commitReadyUnits()
  }

  // 固定 worker 池：pump 完成一个补位一个（与 watcher-snapshot 同构）
  const pump = () => {
    if (settled) return
    if (active === 0 && (qi >= queue.length || signal?.aborted)) {
      // 队列排空或已取消：正常收尾——取消由外层 signal 后置检查统一抛 AbortError
      settleWalk()
      return
    }
    while (
      active < TRAVERSAL_CONCURRENCY &&
      qi < queue.length &&
      !settled &&
      !signal?.aborted
    ) {
      const node = queue[qi++]
      active += 1
      processDir(node)
        .catch((err) => {
          // stat 池的取消中止等异常：终止整次遍历（与旧实现异常直接上抛一致）
          settleWalk(err)
        })
        .finally(() => {
          active -= 1
          pump()
        })
    }
  }
  pump()
  await walkDone
  // 收尾强制推送一次，保证小库/快速扫描（未跨过时间窗）也有进度快照
  emitProgress(true)
  if (signal?.aborted) throw abortError()

  return { models, errors, dirCount, dirSnapshot, failedDirs }
}
